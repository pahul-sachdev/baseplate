import { factorsFromEnv, mapSet } from './brickeconomy/map.ts';
import { equivalentKeys } from './brickeconomy/source.ts';
import type { BrickEconomySet } from './brickeconomy/types.ts';
import { prisma } from './client.ts';
import { systemClock } from './clock.ts';
import {
  classifyValuation,
  mergePreviewMeta,
  type CatalogHint,
  type PreviewProvenance,
  type PreviewValuation,
  type SetPreview,
} from '../lib/setPreview.ts';
import { isCondition, type Valuation } from '../lib/types.ts';
import { pickValuationRow } from '../lib/valuationRows.ts';

/**
 * Preview rows for a grid of sets. Reads the database and stops.
 *
 * This is what makes a wide search free. A search for "millennium falcon" returns twenty sets, and
 * rendering all twenty must not cost twenty BrickEconomy requests — so this reads whatever is
 * already on disk and reports "not valued yet" for the rest. Nothing here can reach the network;
 * spending a request is app/actions.ts's job and requires a click.
 *
 * Six queries total, whatever N is. The per-set alternative — looping readLatestValuation — is
 * 3-4 queries each, which is 80 for a twenty-card grid.
 *
 * Deliberately NOT parameterised by condition. A stored row carries every price band at once, so
 * filtering the read by condition reported "not valued yet" for a set whose numbers were sitting
 * right there — and offered to spend a request to fetch them again. Which condition a row was filed
 * under is a cache-key detail; see src/lib/valuationRows.ts for how one row is chosen.
 */

interface SnapshotRow {
  setNumber: string;
  fetchedOn: string;
  payload: string;
  derived: string;
  provisional: boolean;
  sourceFetchedOn: string | null;
}

function parsePayload(payload: string): BrickEconomySet | null {
  try {
    return JSON.parse(payload) as BrickEconomySet;
  } catch {
    return null;
  }
}

function parseDerived(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A batched mirror of getProvenance() in ./brickeconomy/source.ts, which is per-set and lives in a
 * frozen file. Same rules, deliberately: today's row wins even when it is provisional — that row
 * exists precisely to disclose that stale numbers were served — and `derived` is recomputed from
 * the payload rather than trusted from the stored column, which goes stale when the factors change.
 */
function provenanceFrom(rows: SnapshotRow[], today: string): PreviewProvenance {
  // Rows arrive ascending by fetchedAt, so the last of any group is the newest.
  const todays = rows.filter((row) => row.fetchedOn === today);
  const row = todays[todays.length - 1] ?? rows[rows.length - 1];
  if (row === undefined) return { derived: [], staleFrom: null };

  let derived = parseDerived(row.derived);
  const payload = parsePayload(row.payload);
  if (payload !== null) {
    try {
      derived = mapSet(row.setNumber, payload, factorsFromEnv()).derived;
    } catch {
      // Unmappable payload: fall back to whatever was recorded at write time.
    }
  }

  return { derived, staleFrom: row.provisional ? row.sourceFetchedOn : null };
}

/**
 * Indexes rows under the requested set number, resolving "10236" and "10236-1" to one card.
 *
 * An exact hit always beats an equivalent one — both forms genuinely exist in this database — and
 * otherwise the last row wins, so callers order ascending to get the newest.
 */
function indexByRequested<T extends { setNumber: string }>(
  rows: T[],
  lookup: Map<string, string>,
): Map<string, T> {
  const byRequested = new Map<string, T>();
  for (const row of rows) {
    const requested = lookup.get(row.setNumber);
    if (requested === undefined) continue;

    const existing = byRequested.get(requested);
    if (existing !== undefined && existing.setNumber === requested && row.setNumber !== requested) {
      continue;
    }
    byRequested.set(requested, row);
  }
  return byRequested;
}

function groupByRequested<T extends { setNumber: string }>(
  rows: T[],
  lookup: Map<string, string>,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const requested = lookup.get(row.setNumber);
    if (requested === undefined) continue;
    const bucket = grouped.get(requested);
    if (bucket === undefined) grouped.set(requested, [row]);
    else bucket.push(row);
  }
  return grouped;
}

/**
 * Preview rows in the order given, one per requested set number.
 *
 * `catalog` carries the Rebrickable search payload the caller already holds — passing it in is what
 * gives a card its piece count and photo without a second request.
 */
export async function readSetPreviews(
  setNumbers: readonly string[],
  catalog: ReadonlyMap<string, CatalogHint> = new Map(),
): Promise<SetPreview[]> {
  if (setNumbers.length === 0) return [];

  const requested = [...new Set(setNumbers)];
  const lookup = new Map<string, string>();
  for (const setNumber of requested) {
    for (const key of equivalentKeys(setNumber)) lookup.set(key, setNumber);
  }
  const keys = [...lookup.keys()];

  const [valuationRows, setRows, snapshotRows, bricksetRows, savedRows, imageRows] =
    await Promise.all([
      // No condition filter: one row answers for every condition, and filtering here is exactly
      // what used to blank a card that had numbers on disk.
      prisma.valuation.findMany({
        where: { setNumber: { in: keys } },
        orderBy: { fetchedAt: 'asc' },
      }),
      prisma.set.findMany({ where: { setNumber: { in: keys } } }),
      prisma.setSnapshot.findMany({
        where: { setNumber: { in: keys } },
        orderBy: { fetchedAt: 'asc' },
      }),
      prisma.bricksetSet.findMany({ where: { setNumber: { in: keys } } }),
      // Exact numbers only. saveSetAction and removeSetAction key on the string as saved, so
      // matching an equivalent form here would badge a card the Remove button cannot unsave.
      prisma.savedSet.findMany({ where: { setNumber: { in: requested } } }),
      prisma.setImage.findMany({ where: { setNumber: { in: keys } } }),
    ]);

  const today = systemClock.today();
  // Grouped, not indexed: several conditions and both spellings can match one card, and choosing
  // between them is a rule of its own rather than "whichever row came last".
  const valuations = groupByRequested(valuationRows, lookup);
  const sets = indexByRequested(setRows, lookup);
  const snapshots = groupByRequested(snapshotRows, lookup);
  const brickset = indexByRequested(bricksetRows, lookup);
  const images = indexByRequested(imageRows, lookup);
  const saved = new Set(savedRows.map((row) => row.setNumber));

  return requested.map((setNumber) => {
    const engineSet = sets.get(setNumber) ?? null;
    const bricksetRow = brickset.get(setNumber) ?? null;

    const meta = mergePreviewMeta({
      setNumber,
      catalog: catalog.get(setNumber) ?? null,
      brickset: bricksetRow,
      engine: engineSet,
      cachedImageUrl: images.get(setNumber)?.imageUrl ?? null,
      onWatchlist: saved.has(setNumber),
    });

    const row = pickValuationRow(valuations.get(setNumber) ?? [], setNumber);
    let valuation: PreviewValuation = { kind: 'none' };

    // pickValuationRow has already dropped rows with an unrecognised condition; this narrows the
    // string to the union for the object below.
    if (row !== null && isCondition(row.condition)) {
      const provenance = provenanceFrom(snapshots.get(setNumber) ?? [], today);
      const figures: Valuation = {
        // The number the caller asked for, not the key the row happened to be filed under.
        setNumber,
        condition: row.condition,
        sealed: row.sealed,
        usedWithBox: row.usedWithBox,
        usedNoBox: row.usedNoBox,
        partOut: row.partOut,
        trend: row.trend,
        fetchedAt: row.fetchedAt,
        fetchedOn: row.fetchedOn,
      };
      valuation = {
        kind: classifyValuation(row.fetchedOn, provenance, today),
        valuation: figures,
        fetchedOn: row.fetchedOn,
        provenance,
      };
    }

    return { meta, valuation };
  });
}
