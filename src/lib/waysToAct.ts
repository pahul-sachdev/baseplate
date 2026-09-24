import { CONDITION_PHRASES, STRATEGY_LABELS } from './labels.ts';
import { round2 } from './money.ts';
import { ANCHOR_PLATFORM, platformById } from './platforms.ts';
import {
  CONDITIONS,
  type Condition,
  type PriceBand,
  type Strategy,
  type Valuation,
} from './types.ts';
import { bandFor, ELIGIBILITY, NO_DATA_REASON, netForStrategy } from './verdict.ts';

/**
 * The full opportunity map for a set: every play it can be sold through, at every band that
 * prices one — and deliberately NOT filtered by condition.
 *
 * This is the difference between "what should I do with the copy I have" (that is verdict(), which
 * takes a condition) and "what is this set worth doing anything with at all" (this). The detail
 * view shows both, and the condition selector must only reach the first. It used to reach both,
 * so picking a condition silently hid avenues from the map that was supposed to be complete.
 *
 * Derived from CONDITIONS x ELIGIBILITY rather than listed. The 5x3 grid collapses to exactly four
 * distinct priced cells today — part_out is condition-blind and flip_sealed only ever reads the
 * sealed band — but a condition or band added later joins the map here with no edit, which a hand
 * written list of four rows would not.
 *
 * Pure, like the rest of src/lib. Mock disclosure is not modelled here: MOCK_BACKED_STRATEGIES
 * lives in src/composition.ts and reaches the UI as a prop, exactly as it does for the verdict.
 */

/** A play priced off one band, and the conditions that can execute it. */
interface Opportunity {
  key: string;
  strategy: Strategy;
  band: PriceBand;
  conditions: Condition[];
}

/**
 * The qualifier that distinguishes two rows of the same play. Null when the play has only one
 * band and its own name is already unambiguous.
 *
 * A total Record over PriceBand, so a new band cannot be added without deciding how it reads in
 * the table — the alternative is two rows both labelled "Resell used".
 */
const BAND_QUALIFIERS: Readonly<Record<PriceBand, string | null>> = {
  sealed: null,
  partOut: null,
  usedWithBox: 'with box',
  usedNoBox: 'no box',
};

/**
 * Why a band could not be priced, in the band's own terms.
 *
 * NO_DATA_REASON says "used-market data", which is the truth for the two used bands and a lie for
 * the others. A sealed or part-out figure is non-null by type, so those branches only fire on a
 * non-positive value — rare, but it must not be explained as a used-market gap.
 */
const ABSENT_REASONS: Readonly<Record<PriceBand, string>> = {
  sealed: 'no sealed price on file for this set',
  partOut: 'no part-out figure on file for this set',
  usedWithBox: NO_DATA_REASON,
  usedNoBox: NO_DATA_REASON,
};

export interface ActRow {
  /** Stable across renders: `${strategy}:${band}`. */
  key: string;
  strategy: Strategy;
  /** Names the band it assumes, e.g. "Resell used, no box". */
  label: string;
  /** The conditions that can execute this play. */
  conditions: readonly Condition[];
  /** Those conditions in plain words — "any condition", or "used, no box". */
  appliesTo: string;
  /**
   * The observed band price, before fees. What the market says the set is worth — NOT a suggested
   * list price. BasePlate computes no asking price and no surface may imply that it has.
   */
  marketValue: number;
  fees: number;
  net: number;
  /** The venue the net is after, from ANCHOR_PLATFORM — "eBay", "BrickLink". */
  venueLabel: string;
}

/** A play with no priced row, and the engine's own reason. Disclosed once, never as a table row. */
export interface AbsentPlay {
  key: string;
  label: string;
  reason: string;
}

export interface ActMatrix {
  /** Descending by net. May be empty — a set with no positive band is a real state. */
  rows: ActRow[];
  /** The key of the best-netting row, or null when there are none. */
  bestKey: string | null;
  absent: AbsentPlay[];
}

/**
 * Every distinct (play, band) pair the eligibility map allows, in a stable order, with the
 * conditions that reach each one accumulated.
 */
function opportunities(): Opportunity[] {
  const byKey = new Map<string, Opportunity>();

  for (const condition of CONDITIONS) {
    for (const strategy of ELIGIBILITY[condition].eligible) {
      const band = bandFor(strategy, condition);
      // A play the condition allows but no band prices — nothing to add to the map.
      if (band === null) continue;

      const key = `${strategy}:${band}`;
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, { key, strategy, band, conditions: [condition] });
      else seen.conditions.push(condition);
    }
  }

  return [...byKey.values()];
}

function labelFor(strategy: Strategy, band: PriceBand): string {
  const qualifier = BAND_QUALIFIERS[band];
  return qualifier === null
    ? STRATEGY_LABELS[strategy]
    : `${STRATEGY_LABELS[strategy]}, ${qualifier}`;
}

function appliesTo(conditions: readonly Condition[]): string {
  if (conditions.length === CONDITIONS.length) return 'any condition';
  return conditions.map((condition) => CONDITION_PHRASES[condition]).join(' or ');
}

/**
 * Every priced way to act on a set, best net first.
 *
 * A row exists only when its band is a positive number. Null is absent, and so is zero: a $0.00
 * band is a gap in the data rather than a measurement of worthlessness, and pricing one would put
 * a "market value $0.00, net -$0.30" row on screen. Absent plays are disclosed once, together,
 * with the reason — never as a table row saying "unavailable".
 */
export function actMatrix(valuation: Valuation): ActMatrix {
  const rows: ActRow[] = [];
  const absent: AbsentPlay[] = [];

  for (const opportunity of opportunities()) {
    const { key, strategy, band, conditions } = opportunity;
    const label = labelFor(strategy, band);
    const observed = valuation[band];

    if (observed === null || observed <= 0) {
      absent.push({ key, label, reason: ABSENT_REASONS[band] });
      continue;
    }

    const marketValue = round2(observed);
    const net = netForStrategy(strategy, marketValue);
    rows.push({
      key,
      strategy,
      label,
      conditions,
      appliesTo: appliesTo(conditions),
      marketValue,
      fees: round2(marketValue - net),
      net,
      venueLabel: platformById(ANCHOR_PLATFORM[strategy]).label,
    });
  }

  // Stable sort, so equal nets keep the derivation order above rather than shuffling per render.
  rows.sort((a, b) => b.net - a.net);

  return { rows, bestKey: rows[0]?.key ?? null, absent };
}
