import { systemClock } from '../clock.ts';
import { prisma } from '../client.ts';
import { getKeyUsageStats, getSets, type GetSetsParams } from './client.ts';
import { mapBricksetPage, type BricksetRow } from './map.ts';
import { BricksetError, BricksetLimitError } from './types.ts';

/**
 * The ONLY place Brickset is called. Runs from an explicit "Sync retiring list" click, never on
 * render — the same discipline the BrickEconomy adapter follows, for the same reason.
 *
 * Two modes:
 *   full         — pages the current year and the prior four. ~10-12 requests for ~4,500 sets.
 *   incremental  — the same years with updatedSince, so only changed sets come back. ~5 requests.
 *
 * The mode is chosen from recorded history, not inferred from the data: incremental is used only
 * once a run with mode 'full' AND status 'ok' exists. A first sync that died halfway would
 * otherwise advance the cursor and skip every set it never reached, forever, while the board
 * looked complete.
 */

/** Brickset's documented maximum, and the whole point of using it as the candidate pool. */
const PAGE_SIZE = 500;
/** Current year plus this many prior ones. */
const PRIOR_YEARS = 4;
/**
 * Pages are already serialised, but Brickset publishes no rate limit, so a small gap keeps a
 * 12-page sync from looking like a burst.
 */
const PAGE_GAP_MS = 250;
/**
 * A stop against a malformed `matches` sending the pager round forever. At 500/page this is far
 * more than any single year holds.
 */
const MAX_PAGES_PER_YEAR = 12;

export type SyncMode = 'full' | 'incremental';
export type SyncStatus = 'ok' | 'partial' | 'failed';

export interface SyncResult {
  mode: SyncMode;
  status: SyncStatus;
  /** Sets written this run. For an incremental run, zero is a normal, healthy answer. */
  upserted: number;
  requests: number;
  yearFrom: number;
  yearTo: number;
  /** Why a run ended partial or failed. Null on a clean run. */
  message: string | null;
}

export interface SyncOptions {
  /** Forces a full pass even when an incremental one would do. */
  force?: boolean;
  now?: Date;
  /** Skipped in tests, where the gap only adds wall-clock time. */
  gapMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The cursor for the next incremental run: the startedAt of the most recent successful run.
 *
 * startedAt rather than finishedAt on purpose. A set updated while the run was in flight sits
 * between the two timestamps, and anchoring on finishedAt would step straight over it. Re-pulling
 * a handful of sets is free; missing one is silent.
 */
export async function readIncrementalCursor(): Promise<string | null> {
  const lastFull = await prisma.bricksetSyncRun.findFirst({
    where: { mode: 'full', status: 'ok' },
    orderBy: { startedAt: 'desc' },
  });
  if (lastFull === null) return null;

  const lastGood = await prisma.bricksetSyncRun.findFirst({
    where: { status: 'ok' },
    orderBy: { startedAt: 'desc' },
  });
  const anchor = lastGood ?? lastFull;
  return anchor.startedAt.toISOString().slice(0, 10);
}

async function upsertRows(rows: BricksetRow[], now: Date): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const { setNumber, ...rest } = row;
    const record = { ...rest, lastSynced: now };
    await prisma.bricksetSet.upsert({
      where: { setNumber },
      create: { setNumber, ...record },
      update: record,
    });
    written += 1;
  }
  return written;
}

interface PageOutcome {
  upserted: number;
  requests: number;
}

/**
 * Pages one year to exhaustion. `matches` is the total for the query (measured — a pageSize of 1
 * against year 2023 reported 936), so it is what decides when to stop.
 *
 * orderBy is pinned to Number purely so the page boundaries are stable; Brickset offers no
 * exit-date sort, and ranking happens locally from the cache regardless.
 */
async function syncYear(
  year: number,
  updatedSince: string | null,
  now: Date,
  gapMs: number,
): Promise<PageOutcome> {
  let upserted = 0;
  let requests = 0;
  let collected = 0;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_YEAR; pageNumber += 1) {
    const params: GetSetsParams = {
      year: String(year),
      orderBy: 'Number',
      pageSize: PAGE_SIZE,
      pageNumber,
    };
    if (updatedSince !== null) params.updatedSince = updatedSince;

    if (pageNumber > 1 && gapMs > 0) await sleep(gapMs);

    const { matches, sets } = await getSets(params);
    requests += 1;

    upserted += await upsertRows(mapBricksetPage(sets), now);
    collected += sets.length;

    // A short page means the year is exhausted; `matches` closes it out when a page happens to
    // land exactly on the boundary.
    if (sets.length === 0 || sets.length < PAGE_SIZE || collected >= matches) break;
  }

  return { upserted, requests };
}

/**
 * Reads Brickset's own usage before a run, so the record shows what was already spent rather than
 * a guess. Free, and never fatal: a failed pre-flight must not block a sync the user asked for.
 *
 * Usage only — getKeyUsageStats reports no limit, which is why nothing downstream shows one.
 */
async function preflightUsage(): Promise<{ total30d: number | null; on: string | null }> {
  try {
    const usage = await getKeyUsageStats();
    return {
      total30d: usage.reduce((sum, row) => sum + row.count, 0),
      on: systemClock.today(),
    };
  } catch {
    return { total30d: null, on: null };
  }
}

/**
 * Syncs the recent-years window into BricksetSet.
 *
 * Never throws for the expected failures. A spent Brickset allowance ends the run as 'partial'
 * and returns the reason, so the board keeps serving whatever is already cached with the
 * shortfall stated — a crashed page would tell the user nothing and lose the rows already written.
 */
export async function syncBricksetSets(options: SyncOptions = {}): Promise<SyncResult> {
  const now = options.now ?? systemClock.now();
  const gapMs = options.gapMs ?? PAGE_GAP_MS;

  const cursor = options.force === true ? null : await readIncrementalCursor();
  const mode: SyncMode = cursor === null ? 'full' : 'incremental';

  const yearTo = now.getUTCFullYear();
  const yearFrom = yearTo - PRIOR_YEARS;

  const usage = await preflightUsage();

  const run = await prisma.bricksetSyncRun.create({
    data: {
      mode,
      status: 'partial',
      startedAt: now,
      yearFrom,
      yearTo,
      reportedUsage30d: usage.total30d,
      reportedUsageOn: usage.on,
    },
  });

  let upserted = 0;
  let requests = 0;
  let status: SyncStatus = 'ok';
  let message: string | null = null;

  for (let year = yearFrom; year <= yearTo; year += 1) {
    try {
      const outcome = await syncYear(year, cursor, now, gapMs);
      upserted += outcome.upserted;
      requests += outcome.requests;
    } catch (error) {
      // Requests spent before the failure are unknowable from here; the ApiRequest log has them.
      if (error instanceof BricksetLimitError) {
        status = 'partial';
        message = `Brickset limit reached part-way through ${year}. Years ${year}-${yearTo} were not synced; the list below is incomplete.`;
      } else if (error instanceof BricksetError) {
        status = upserted > 0 ? 'partial' : 'failed';
        message = error.message;
      } else {
        status = upserted > 0 ? 'partial' : 'failed';
        message = error instanceof Error ? error.message : String(error);
      }
      break;
    }
  }

  await prisma.bricksetSyncRun.update({
    where: { id: run.id },
    data: { status, message, requests, setsUpserted: upserted, finishedAt: new Date() },
  });

  return { mode, status, upserted, requests, yearFrom, yearTo, message };
}

/**
 * What a sync will cost, for the confirmation dialog. An estimate, and labelled as one in the UI:
 * the real count depends on how many sets changed, which is exactly what we do not know yet.
 */
export function estimateSyncRequests(mode: SyncMode): number {
  const years = PRIOR_YEARS + 1;
  // Measured: ~900-1,000 sets per recent year, so two pages of 500 each.
  return mode === 'full' ? years * 2 : years;
}
