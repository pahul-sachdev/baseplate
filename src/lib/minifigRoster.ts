import {
  MAX_MINIFIG_NUMBER_LENGTH,
  classifyMinifigId,
  isRoutableMinifigNumber,
  normaliseMinifigNumber,
} from './minifigNumber.ts';
import type { CountedList } from './minifigValuePort.ts';

/**
 * Who is in a set, parsed from the BrickEconomy payload ALREADY ON DISK.
 *
 * ZERO requests, retroactively, for every set ever valued: `minifigs` has been arriving in the set
 * payload and being discarded since the adapter was written, because BrickEconomySet models
 * `minifigs_count` and not `minifigs`. This is a re-read, not a fetch — which is what removes
 * Rebrickable from the critical path entirely, along with the unbridgeable fig-001549 → sw0509
 * mapping it would have needed.
 *
 * Structurally typed rather than importing BrickEconomySet, on the same principle that made
 * PreviewProvenance a redeclaration: src/lib never imports an adapter, and nothing here may give a
 * client bundle an edge to a module that value-imports Prisma. It also reads only the two keys
 * mapSet() never touches, so the frozen valuation path is provably unaffected.
 */

/** The two keys this cares about, both `unknown` because a cached payload is not a promise. */
export interface RosterSource {
  minifigs?: unknown;
  minifigs_count?: unknown;
}

/**
 * What the caller found on disk. Explicit, because "no snapshot" and "a snapshot that will not
 * parse" are different answers and the second must never quietly render as "no minifigures".
 */
export type RosterInput =
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'payload'; data: RosterSource };

/**
 * Five states, and the distinctions between the middle three are the whole point.
 *
 *   no_payload  — the set has never been valued. NOTHING is known. NOT "no minifigures".
 *   unreadable  — a snapshot exists but will not parse. Never silently treated as "no figures".
 *   not_listed  — a payload exists and mentions minifigures NOWHERE. MEASURED on 10 of 29 cached
 *                 snapshots, and every one of those ten is a genuinely figure-less set (Big Ben,
 *                 Colosseum, the helmets) — but that is an inference about those ten, not a rule.
 *                 So it is rendered as "BrickEconomy listed no minifigures for this set": a
 *                 statement about the LISTING, not a claim about the set.
 *   none        — minifigs_count is present and 0. This IS a positive claim of no minifigures.
 *   listed      — ids and/or a count. `figs.listed` may be empty while `figs.reported` is positive
 *                 (unobserved, but representable), and that case must NOT degrade into a silent
 *                 empty grid, which is why it is not folded into not_listed.
 */
export type MinifigRoster =
  | { kind: 'no_payload' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'not_listed' }
  | { kind: 'none' }
  | { kind: 'listed'; figs: CountedList; unreadableEntries: number };

/** A total Record, so a sixth roster kind cannot ship without words. */
export const ROSTER_NOTES: Readonly<Record<MinifigRoster['kind'], string>> = {
  no_payload:
    'This set has not been valued yet, so BasePlate has no minifigure list for it. Valuing the ' +
    'set fills this in at no extra cost — the figure list arrives in the same response.',
  unreadable:
    'The cached BrickEconomy response for this set could not be read, so its minifigure list is ' +
    'unavailable. Refreshing the set rebuilds it.',
  not_listed: 'BrickEconomy listed no minifigures for this set.',
  none: 'BrickEconomy reports this set has no minifigures.',
  listed: '',
};

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Parses defensively and DROPS rather than throwing: a payload this fails on belongs to a set that
 * is still perfectly valuable, and the roster is an addition to that page, not a gate on it.
 *
 * Ids are trimmed and lowercased, then filtered by a length-and-charset envelope — NOT by a
 * catalogue judgement. "90398pb015" is KEPT: deciding it is not a real figure is BrickEconomy's
 * call to make, not ours, and the honest way to find out is to let the user ask once and cache the
 * answer forever.
 *
 * Duplicates within the array are collapsed. Never observed upstream, but a duplicate would
 * double-count in the 50% sum, and the array is documented as distinct ids anyway.
 *
 * Order is preserved — it is BrickEconomy's, and the app has no better one.
 */
export function readRoster(input: RosterInput): MinifigRoster {
  if (input.kind === 'absent') return { kind: 'no_payload' };
  if (input.kind === 'unreadable') return { kind: 'unreadable', reason: input.reason };

  const { minifigs, minifigs_count: rawCount } = input.data;
  const reported = asPositiveInt(rawCount);
  const hasArray = Array.isArray(minifigs);

  // Neither key present at all: the payload never mentions minifigures.
  if (!hasArray && reported === null) return { kind: 'not_listed' };

  // A reported zero with no array is a positive claim, and the only thing that produces `none`.
  if (!hasArray && reported === 0) return { kind: 'none' };

  const listed: string[] = [];
  const seen = new Set<string>();
  let unreadableEntries = 0;

  for (const entry of hasArray ? (minifigs as unknown[]) : []) {
    if (typeof entry !== 'string') {
      unreadableEntries += 1;
      continue;
    }
    const id = normaliseMinifigNumber(entry);
    if (id === '' || id.length > MAX_MINIFIG_NUMBER_LENGTH || !isRoutableMinifigNumber(id)) {
      unreadableEntries += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    listed.push(id);
  }

  // An array that was present but yielded nothing usable, with no count either, is not a claim
  // that the set has no figures — it is a listing we could not read.
  if (listed.length === 0 && reported === null) {
    return unreadableEntries > 0
      ? { kind: 'unreadable', reason: `${unreadableEntries} unreadable entries in the figure list` }
      : { kind: 'not_listed' };
  }
  if (listed.length === 0 && reported === 0) return { kind: 'none' };

  return { kind: 'listed', figs: { listed, reported }, unreadableEntries };
}

/**
 * A descriptive note about id SHAPES, offered BEFORE a batch spends anything.
 *
 * An observation about strings, framed as a possibility ("BrickEconomy may have no minifigure
 * record for these"), never a claim about value. It exists so the user can decline to spend 20
 * requests learning 20 nothings on Hogwarts Castle, and it never blocks the attempt.
 */
export function idShapeNote(ids: readonly string[]): { unusual: readonly string[] } | null {
  const unusual = ids.filter((id) => classifyMinifigId(id) === 'unclassified');
  return unusual.length === 0 ? null : { unusual };
}
