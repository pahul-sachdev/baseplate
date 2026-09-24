import { equivalentKeys } from '../brickeconomy/source.ts';
import type { BrickEconomySet } from '../brickeconomy/types.ts';
import { prisma } from '../client.ts';
import { systemClock } from '../clock.ts';
import {
  isCandidate,
  rankCandidates,
  RETIRING_AVAILABILITY,
  windowEnd,
  type CachedForecast,
  type RetiringRow,
} from '../../lib/retiring.ts';

// Re-exported so existing importers keep working. The definitions moved to src/lib/retiring.ts,
// which is pure — the board is a client component and must not reach this module, where the
// Prisma client is a value import.
export type { CachedForecast, RetiringRow };

/**
 * Read-only queries for the retiring board.
 *
 * Every function here touches the database and nothing else — no Brickset call, no BrickEconomy
 * call. That is what makes /retiring free to load and free to reload: the only paths that spend a
 * request are the sync button and the per-set value button, both Server Actions.
 *
 * Kept in its own file rather than added to src/db/readModels.ts so this feature lands as new
 * files, and does not collide with concurrent work on the shared read model.
 */

/** Midnight of the app's day key, so window maths never depends on the machine's timezone. */
export function todayUtc(): Date {
  return new Date(`${systemClock.today()}T00:00:00Z`);
}

/**
 * Candidates from the cache, ranked soonest-exit first.
 *
 * The SQL fetches a superset — anything with an exit date inside the window, plus anything whose
 * availability is an inclusion signal — and src/lib/retiring.ts makes the actual decision. Two
 * bounded queries rather than one broad scan, so an unsynced or enormous table cannot turn a page
 * load into a full-catalogue read.
 */
export async function readRetiringCandidates(months: number, today = todayUtc()): Promise<RetiringRow[]> {
  const horizon = windowEnd(today, months);

  const byExitDate = await prisma.bricksetSet.findMany({
    where: { exitDate: { gte: today, lte: horizon } },
    orderBy: { exitDate: 'asc' },
  });

  // Skipped entirely while RETIRING_AVAILABILITY is empty — see the note on that constant.
  const byAvailability =
    RETIRING_AVAILABILITY.length === 0
      ? []
      : await prisma.bricksetSet.findMany({
          where: { availability: { in: [...RETIRING_AVAILABILITY] } },
        });

  const merged = new Map<string, RetiringRow>();
  for (const row of [...byExitDate, ...byAvailability]) merged.set(row.setNumber, row);

  const candidates = [...merged.values()].filter((row) => isCandidate(row, today, months));
  return rankCandidates(candidates);
}

export interface SyncState {
  /** Null until the first sync has run. */
  lastRunAt: Date | null;
  lastRunMode: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  /** True once a run with mode 'full' and status 'ok' exists. */
  hasFullSync: boolean;
  /** Rows currently in the cache, so an empty board can say whether it is empty or unsynced. */
  cachedSets: number;
  /** Brickset's own reported 30-day usage at the last pre-flight, and when it said so. */
  reportedUsage30d: number | null;
  reportedUsageOn: string | null;
}

export async function readSyncState(): Promise<SyncState> {
  const [last, fullOk, cachedSets] = await Promise.all([
    prisma.bricksetSyncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.bricksetSyncRun.findFirst({ where: { mode: 'full', status: 'ok' } }),
    prisma.bricksetSet.count(),
  ]);

  return {
    lastRunAt: last?.finishedAt ?? last?.startedAt ?? null,
    lastRunMode: last?.mode ?? null,
    lastRunStatus: last?.status ?? null,
    lastRunMessage: last?.message ?? null,
    hasFullSync: fullOk !== null,
    cachedSets,
    reportedUsage30d: last?.reportedUsage30d ?? null,
    reportedUsageOn: last?.reportedUsageOn ?? null,
  };
}

function parsePayload(payload: string): BrickEconomySet | null {
  try {
    return JSON.parse(payload) as BrickEconomySet;
  } catch {
    return null;
  }
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * BrickEconomy reports retired_date as a bare "YYYY-MM-DD". Parsed as UTC midnight so it lines up
 * with Brickset's dates, which already arrive with a Z suffix. Unparseable means absent, not epoch.
 */
function parseRetiredDate(value: string | undefined): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Forecast figures for sets that ALREADY have a BrickEconomy snapshot. Reads SetSnapshot and
 * stops — a set with no snapshot is simply absent from the result, which is what makes the board
 * render "not valued yet" instead of quietly fetching 200 sets and torching the daily quota.
 *
 * Provisional rows are skipped, matching the adapter's own rule: they record that stale data was
 * served, and are not cache entries.
 */
export async function readCachedForecasts(
  setNumbers: readonly string[],
): Promise<Map<string, CachedForecast>> {
  const byNumber = new Map<string, CachedForecast>();
  if (setNumbers.length === 0) return byNumber;

  // "10312-1" and "10312" denote the same set, and the snapshot may be filed under either.
  const lookup = new Map<string, string>();
  for (const setNumber of setNumbers) {
    for (const key of equivalentKeys(setNumber)) lookup.set(key, setNumber);
  }

  const rows = await prisma.setSnapshot.findMany({
    where: { setNumber: { in: [...lookup.keys()] }, provisional: false },
    orderBy: { fetchedAt: 'asc' },
  });

  // Ascending, so a later row overwrites an earlier one and the newest snapshot wins.
  for (const row of rows) {
    const canonical = lookup.get(row.setNumber);
    if (canonical === undefined) continue;

    const payload = parsePayload(row.payload);
    if (payload === null) continue;

    const growthPercent = finite(payload.rolling_growth_12months);
    byNumber.set(canonical, {
      sealed: finite(payload.current_value_new),
      forecast2y: finite(payload.forecast_value_new_2_years),
      // The API reports a percentage (3.11 = +3.11%); the app stores a fraction, as Valuation does.
      growth12m: growthPercent === null ? null : Math.round(growthPercent * 100) / 10_000,
      // Step 2 of the retirement-date chain. Comes free — the payload is already parsed here, so
      // reading it costs no extra query and certainly no request.
      retiredDate: parseRetiredDate(payload.retired_date),
      fetchedOn: row.fetchedOn,
    });
  }

  return byNumber;
}
