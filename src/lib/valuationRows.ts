import { CONDITIONS, isCondition } from './types.ts';

/**
 * Choosing which stored valuation answers for a set.
 *
 * A Valuation row carries every price band — sealed, used-with-box, used-no-box, part-out, trend —
 * whatever condition it was filed under. `condition` is part of the cache key and a stored label,
 * nothing more: the engine never passes it to a provider, and one BrickEconomy request fills all
 * four bands at once. So reads must NOT filter on it. Filtering is what made changing the Lookup
 * dropdown erase a card that had perfectly good numbers on disk.
 *
 * The cost of dropping that filter is ambiguity: one set can now match rows filed under any
 * condition, across several days and both spellings of its number. This module is the tiebreak,
 * and it has to be a TOTAL order — the real database contains rows that tie on every obvious key.
 *
 * Pure, and deliberately DOM-free: tsconfig.node.json compiles src/lib with lib: ["ES2023"].
 */

/**
 * The columns selection needs. Structural on purpose, so src/db/previews.ts and
 * src/db/readModels.ts can both pass Prisma rows without this module importing Prisma.
 */
export interface ValuationRowKey {
  setNumber: string;
  condition: string;
  /** Day key in the app's fixed timezone, "YYYY-MM-DD". Lexicographic order is chronological. */
  fetchedOn: string;
  fetchedAt: Date;
  id: string;
}

/**
 * Sealed first, matching CONDITIONS order.
 *
 * This decides which row is canonical when several conditions were valued the same day, and it is
 * load-bearing rather than cosmetic: 10236-1's used_box and used_nobox rows share `fetchedAt` to
 * the second in the real database, so without it the winner would be SQLite's row order.
 */
function conditionRank(condition: string): number {
  const index = CONDITIONS.indexOf(condition as (typeof CONDITIONS)[number]);
  return index === -1 ? CONDITIONS.length : index;
}

/**
 * Ranks two rows, best first. A total order — every key below is checked, ending on `id`, which is
 * a cuid and therefore unique.
 *
 *   1. Newest `fetchedOn`. The day key, not `fetchedAt`, because `fetchedOn` is what
 *      classifyValuation() grades staleness on — selecting on one and grading on the other is how
 *      a card ends up claiming staleness it does not have.
 *   2. The exact spelling asked for, but only WITHIN a day. This reverses the old rule in
 *      src/db/previews.ts, where exact spelling beat freshness outright; that made a card pick a
 *      week-old "10236" row over today's "10236-1" one, show a stale banner, and offer a Refresh
 *      that spends a request for nothing. Spelling still breaks same-day ties because the mock
 *      part-out provider seeds off the number string, so the two spellings carry different
 *      partOut figures until BrickLink lands.
 *   3. Sealed over the used conditions — see conditionRank.
 *   4. Newest `fetchedAt`, then lowest `id`, purely to make the order total.
 */
function compareRows(a: ValuationRowKey, b: ValuationRowKey, requested: string): number {
  if (a.fetchedOn !== b.fetchedOn) return a.fetchedOn > b.fetchedOn ? -1 : 1;

  const aExact = a.setNumber === requested ? 0 : 1;
  const bExact = b.setNumber === requested ? 0 : 1;
  if (aExact !== bExact) return aExact - bExact;

  const aRank = conditionRank(a.condition);
  const bRank = conditionRank(b.condition);
  if (aRank !== bRank) return aRank - bRank;

  const aTime = a.fetchedAt.getTime();
  const bTime = b.fetchedAt.getTime();
  if (aTime !== bTime) return bTime - aTime;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The one row that answers for `requested`, or null when nothing usable matched.
 *
 * Rows with an unrecognised `condition` are dropped BEFORE the pick, not after. The old code
 * checked validity on the row it had already chosen, so a single junk row could blank a card that
 * had a perfectly good one sitting beside it — likelier now that every condition competes.
 */
export function pickValuationRow<T extends ValuationRowKey>(
  rows: readonly T[],
  requested: string,
): T | null {
  return rows.reduce<T | null>((best, row) => {
    if (!isCondition(row.condition)) return best;
    if (best === null) return row;
    return compareRows(row, best, requested) < 0 ? row : best;
  }, null);
}
