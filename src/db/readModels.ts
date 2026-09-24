import { equivalentKeys, getProvenance, type Provenance } from './brickeconomy/source.ts';
import { prisma } from './client.ts';
import { systemClock } from './clock.ts';
import { isCondition, type SetMeta, type Valuation } from '../lib/types.ts';
import { pickValuationRow } from '../lib/valuationRows.ts';

/**
 * Read-only queries for rendering the UI.
 *
 * Every function here touches the database and nothing else. This is the reason a page load
 * cannot spend quota: server components read through this module, and only Server Actions call
 * getValuation(), which is the one path that may hit the network.
 *
 * Not a port and not an engine capability — a read model over tables the engine already owns.
 */

/** BrickEconomy's published daily allowance. */
export const DAILY_QUOTA = 100;

export interface CachedValuation {
  valuation: Valuation;
  set: SetMeta | null;
  /** True when the numbers were fetched on some earlier day. */
  isStale: boolean;
  provenance: Provenance;
}

function toValuation(row: {
  setNumber: string;
  condition: string;
  sealed: number;
  usedWithBox: number | null;
  usedNoBox: number | null;
  partOut: number;
  trend: number;
  fetchedAt: Date;
  fetchedOn: string;
}): Valuation | null {
  if (!isCondition(row.condition)) return null;
  return {
    setNumber: row.setNumber,
    condition: row.condition,
    sealed: row.sealed,
    usedWithBox: row.usedWithBox,
    usedNoBox: row.usedNoBox,
    partOut: row.partOut,
    trend: row.trend,
    fetchedAt: row.fetchedAt,
    fetchedOn: row.fetchedOn,
  };
}

/**
 * The most recent valuation for a set, of any age and any stored condition. Never fetches.
 *
 * Matched through equivalentKeys, like the snapshot reads have always been. "10236" and "10236-1"
 * denote one set and both forms genuinely exist in this database, so an exact match would report
 * "nothing cached" for a set that was valued yesterday under the other spelling — and would make a
 * preview card and its deep link disagree about whether the set has numbers.
 *
 * Not parameterised by condition, for the same reason. A row carries every price band whatever
 * condition it was filed under, so asking for 'sealed' reported "no cached valuation" for sets
 * valued today under used_box — and put them in Trending's bulk-refresh list, where they spent a
 * request re-fetching numbers already on disk. Which row wins: src/lib/valuationRows.ts.
 */
export async function readLatestValuation(setNumber: string): Promise<CachedValuation | null> {
  const rows = await prisma.valuation.findMany({
    where: { setNumber: { in: equivalentKeys(setNumber) } },
    orderBy: { fetchedAt: 'asc' },
  });
  const row = pickValuationRow(rows, setNumber);
  if (row === null) return null;

  // Reported under the number the caller asked for, not the key the row was filed under.
  const valuation = toValuation({ ...row, setNumber });
  if (valuation === null) return null;

  const [set, provenance] = await Promise.all([
    readSetMeta(setNumber),
    getProvenance(setNumber),
  ]);

  return {
    valuation,
    set,
    isStale: row.fetchedOn !== systemClock.today(),
    provenance,
  };
}

/**
 * True when this set already has today's numbers — i.e. a lookup would be free.
 *
 * Condition-blind, matching readLatestValuation: today's row answers for every condition, so a set
 * valued this morning under used_nobox is cached for the sealed question too.
 */
export async function isCachedToday(setNumber: string): Promise<boolean> {
  const row = await prisma.valuation.findFirst({
    where: {
      setNumber: { in: equivalentKeys(setNumber) },
      fetchedOn: systemClock.today(),
    },
  });
  return row !== null;
}

export async function readSetMeta(setNumber: string): Promise<SetMeta | null> {
  return prisma.set.findFirst({ where: { setNumber: { in: equivalentKeys(setNumber) } } });
}

export interface CachedImage {
  imageUrl: string | null;
  /** False when the set has never been looked up, so the UI can offer a refresh. */
  known: boolean;
}

export async function readImage(setNumber: string): Promise<CachedImage> {
  // Artwork is only ever filed under the "-1" form, so a bare number needs the equivalent key.
  const row = await prisma.setImage.findFirst({
    where: { setNumber: { in: equivalentKeys(setNumber) } },
  });
  return row === null ? { imageUrl: null, known: false } : { imageUrl: row.imageUrl, known: true };
}

export async function readImages(setNumbers: string[]): Promise<Map<string, CachedImage>> {
  const rows = await prisma.setImage.findMany({ where: { setNumber: { in: setNumbers } } });
  const byNumber = new Map<string, CachedImage>();
  for (const row of rows) byNumber.set(row.setNumber, { imageUrl: row.imageUrl, known: true });
  for (const setNumber of setNumbers) {
    if (!byNumber.has(setNumber)) byNumber.set(setNumber, { imageUrl: null, known: false });
  }
  return byNumber;
}

export interface SavedSetRow {
  setNumber: string;
  note: string | null;
  addedAt: Date;
}

export async function readSavedSets(): Promise<SavedSetRow[]> {
  return prisma.savedSet.findMany({ orderBy: { addedAt: 'desc' } });
}

export async function isSaved(setNumber: string): Promise<boolean> {
  return (await prisma.savedSet.findUnique({ where: { setNumber } })) !== null;
}

export interface QuotaUsage {
  brickeconomy: number;
  rebrickable: number;
  /**
   * Today's Brickset requests, counted locally. Deliberately has no limit beside it: Brickset's
   * getKeyUsageStats reports usage and never an allowance, so any denominator would be invented.
   */
  brickset: number;
  /** BrickEconomy's limit only — the one provider that publishes one. */
  limit: number;
  day: string;
}

/**
 * Exact request counts for today. Counts rows in ApiRequest, which the HTTP clients write once
 * per attempt — so variant retries and rejected requests are included, unlike a count derived
 * from cached snapshots.
 */
export async function readQuotaToday(): Promise<QuotaUsage> {
  const day = systemClock.today();
  const grouped = await prisma.apiRequest.groupBy({
    by: ['provider'],
    where: { requestedOn: day },
    _count: { _all: true },
  });

  const countFor = (provider: string): number =>
    grouped.find((g) => g.provider === provider)?._count._all ?? 0;

  return {
    brickeconomy: countFor('brickeconomy'),
    rebrickable: countFor('rebrickable'),
    brickset: countFor('brickset'),
    limit: DAILY_QUOTA,
    day,
  };
}
