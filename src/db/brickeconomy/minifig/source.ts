import { prisma } from '../../client.ts';
import { systemClock } from '../../clock.ts';
import { minifigGapFromEnv } from '../../../lib/minifigBatch.ts';
import { classifyMinifigId, normaliseMinifigNumber } from '../../../lib/minifigNumber.ts';
import type { MinifigLookup } from '../../../lib/minifigValuePort.ts';
import {
  BrickEconomyAuthError,
  BrickEconomyQuotaError,
  BrickEconomyError,
} from '../types.ts';
import { fetchMinifigRaw } from './client.ts';
import { mapMinifig } from './map.ts';
import { BrickEconomyUnknownMinifigError, type BrickEconomyMinifig } from './types.ts';

/**
 * The single door to BrickEconomy's minifigure endpoint.
 *
 * Four layers of protection, cheapest first — the same shape as ../source.ts, plus one this
 * feature needs that sets never did:
 *   1. a PERMANENT negative cache — a figure BrickEconomy has no record of is never asked twice
 *   2. an in-process promise memo — concurrent callers for one figure share one call
 *   3. a MinifigSnapshot row for today — repeat clicks on the same day cost nothing
 *   4. on 429, the newest snapshot of any age rather than a hard failure
 *
 * Layer 1 is the expensive one to get wrong. Twenty of this database's figure ids are BrickLink
 * PART numbers that answer HTTP 400; without a permanent record of that, valuing one set's figures
 * would burn a fifth of the daily allowance to learn twenty nothings — and burn it again tomorrow.
 */

/** Keyed by `minifigNumber|day`; holds the in-flight promise so concurrent callers share one call. */
const inFlight = new Map<string, Promise<MinifigLookup>>();

/**
 * Serialises requests process-wide with a minimum gap, so a batch cannot burst.
 *
 * Lives here rather than in client.ts so the client stays free of policy and unit-testable with a
 * stubbed fetch. Measured 2026-07-30: seven requests in 9.2 seconds drew no 429, so the widely
 * repeated "4 per minute" figure is not enforced — but pacing costs almost nothing at the default
 * 1100ms and is the difference between a polite client and a banned one if that ever changes.
 */
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function throttle<T>(task: () => Promise<T>, minGapMs: number): Promise<T> {
  const run = queue.then(async () => {
    const wait = minGapMs - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return task();
  });
  // Keep the chain alive even if this task rejects, so one failure doesn't wedge the queue.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Tests only: both memos are module-level and node:test shares a module across a file's cases. */
export function resetMinifigSource(): void {
  inFlight.clear();
  queue = Promise.resolve();
  lastRequestAt = 0;
}

function parsePayload(payload: string): BrickEconomyMinifig | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null ? (parsed as BrickEconomyMinifig) : null;
  } catch {
    return null;
  }
}

async function readTodaySnapshot(minifigNumber: string, day: string): Promise<BrickEconomyMinifig | null> {
  const row = await prisma.minifigSnapshot.findFirst({
    where: { minifigNumber, fetchedOn: day, provisional: false },
  });
  return row === null ? null : parsePayload(row.payload);
}

async function readNewestSnapshot(
  minifigNumber: string,
): Promise<{ data: BrickEconomyMinifig; fetchedOn: string } | null> {
  const row = await prisma.minifigSnapshot.findFirst({
    where: { minifigNumber, provisional: false },
    orderBy: { fetchedAt: 'desc' },
  });
  if (row === null) return null;
  const data = parsePayload(row.payload);
  return data === null ? null : { data, fetchedOn: row.fetchedOn };
}

async function writeSnapshot(
  minifigNumber: string,
  day: string,
  data: BrickEconomyMinifig,
  flags: { provisional?: boolean; sourceFetchedOn?: string } = {},
): Promise<void> {
  const record = {
    payload: JSON.stringify(data),
    provisional: flags.provisional ?? false,
    sourceFetchedOn: flags.sourceFetchedOn ?? null,
  };
  await prisma.minifigSnapshot.upsert({
    where: { minifigNumber_fetchedOn: { minifigNumber, fetchedOn: day } },
    create: { minifigNumber, fetchedOn: day, ...record },
    update: record,
  });
}

/**
 * Records that BrickEconomy has no such figure — the ONLY place this table is ever written.
 *
 * Reached exclusively from the `BrickEconomyUnknownMinifigError` branch below. A quota error, a
 * timeout or a malformed body must never land here: none of them is evidence of absence, and
 * caching one would permanently mark a valuable figure unvaluable on the screen whose whole job is
 * honesty.
 */
async function recordAbsence(minifigNumber: string, status: number, day: string): Promise<void> {
  await prisma.minifigAbsence.upsert({
    where: { minifigNumber },
    create: { minifigNumber, status, confirmedOn: day, attempts: 1 },
    update: { status, attempts: { increment: 1 } },
  });
}

async function load(minifigNumber: string, day: string, ignoreAbsence: boolean): Promise<MinifigLookup> {
  // 1. Permanent negative cache. Age-blind on purpose: re-checking every midnight is exactly the
  //    quota leak this table exists to prevent.
  if (!ignoreAbsence) {
    const absence = await prisma.minifigAbsence.findUnique({ where: { minifigNumber } });
    if (absence !== null) {
      return {
        ok: false,
        reason: 'no_record',
        status: absence.status,
        confirmedOn: absence.confirmedOn,
      };
    }
  }

  // 3. Today's snapshot: answer with no network at all.
  const cached = await readTodaySnapshot(minifigNumber, day);
  if (cached !== null) {
    return { ok: true, facts: mapMinifig(minifigNumber, cached), fetchedOn: day, staleFrom: null };
  }

  try {
    const data = await throttle(() => fetchMinifigRaw(minifigNumber), minifigGapFromEnv());
    await writeSnapshot(minifigNumber, day, data);
    return { ok: true, facts: mapMinifig(minifigNumber, data), fetchedOn: day, staleFrom: null };
  } catch (error) {
    // The one branch that may write an absence.
    if (error instanceof BrickEconomyUnknownMinifigError) {
      await recordAbsence(minifigNumber, error.status ?? 400, day);
      return { ok: false, reason: 'no_record', status: error.status ?? 400, confirmedOn: day };
    }

    // 4. Quota spent: stale data beats no data, as long as we keep saying it is stale.
    if (error instanceof BrickEconomyQuotaError) {
      const fallback = await readNewestSnapshot(minifigNumber);
      if (fallback !== null) {
        // Recorded under today's key so every later read that day reports the staleness. The row
        // is provisional, so it is a disclosure and not a cache entry: reads skip it and the next
        // click still retries once the quota resets.
        await writeSnapshot(minifigNumber, day, fallback.data, {
          provisional: true,
          sourceFetchedOn: fallback.fetchedOn,
        });
        return {
          ok: true,
          facts: mapMinifig(minifigNumber, fallback.data),
          fetchedOn: fallback.fetchedOn,
          staleFrom: fallback.fetchedOn,
        };
      }
      // Nothing cached: fail, and write NOTHING. An empty row would masquerade as data, and an
      // absence row would be a permanent claim built on a quota error.
      return { ok: false, reason: 'quota', message: error.message };
    }

    if (error instanceof BrickEconomyAuthError) {
      return { ok: false, reason: 'auth', message: error.message };
    }
    return {
      ok: false,
      reason: 'unavailable',
      message: error instanceof BrickEconomyError ? error.message : 'BrickEconomy request failed',
    };
  }
}

/**
 * One figure's numbers, fetching at most once per figure per day — and never at all for a figure
 * already recorded absent.
 */
export function getMinifigLookup(
  minifigNumber: string,
  options: { ignoreAbsence?: boolean } = {},
): Promise<MinifigLookup> {
  const id = normaliseMinifigNumber(minifigNumber);
  const kind = classifyMinifigId(id);

  // No mapping exists from Rebrickable's id space to BrickEconomy's, so there is no request that
  // could answer this. Refused before anything else, and it costs nothing to refuse.
  if (kind === 'rebrickable') {
    return Promise.resolve({ ok: false, reason: 'unaddressable', kind });
  }

  const day = systemClock.today();
  const ignoreAbsence = options.ignoreAbsence ?? false;

  // An explicit "ask again" must not be answered by a memo that already knows the old answer.
  if (ignoreAbsence) return load(id, day, true);

  const key = `${id}|${day}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  // Rejections are evicted so a failure stays retryable rather than being cached. Note the
  // resolved value may itself be a failure — those are cached deliberately, because "BrickEconomy
  // has no record of this" is an answer, not an error.
  const pending = load(id, day, false).catch((error: unknown) => {
    inFlight.delete(key);
    throw error;
  });
  inFlight.set(key, pending);
  return pending;
}

/** Discards today's cached numbers for one figure, then re-reads. Up to one request. */
export async function refreshMinifig(minifigNumber: string): Promise<MinifigLookup> {
  const id = normaliseMinifigNumber(minifigNumber);
  const day = systemClock.today();

  await prisma.minifigSnapshot.deleteMany({ where: { minifigNumber: id } });
  inFlight.delete(`${id}|${day}`);

  // Deliberately does NOT clear an absence: a refresh is about stale numbers, and re-asking about
  // a figure BrickEconomy has never heard of is its own decision with its own button.
  return getMinifigLookup(id);
}

/**
 * The one deliberate override of the permanent negative cache. Exactly one request, and it bumps
 * `attempts` so a repeatedly-asked id is visible.
 *
 * BrickEconomy may add a catalogue entry later, so refusing forever would be a permanent claim
 * built on a single observation — but retrying silently would spend quota forever, so it takes a
 * click.
 */
export async function askAgainMinifig(minifigNumber: string): Promise<MinifigLookup> {
  const id = normaliseMinifigNumber(minifigNumber);
  inFlight.delete(`${id}|${systemClock.today()}`);
  return getMinifigLookup(id, { ignoreAbsence: true });
}
