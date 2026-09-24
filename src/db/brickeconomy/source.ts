import { systemClock } from '../clock.ts';
import { prisma } from '../client.ts';
import { fetchSetRaw } from './client.ts';
import { factorsFromEnv, mapSet, type MappedSet } from './map.ts';
import { BrickEconomyQuotaError, type BrickEconomySet } from './types.ts';

/**
 * The single door to BrickEconomy. Both the value provider and the catalog provider come
 * through here, so a set costs at most one API call per day — which is the whole game
 * against a 100-request daily quota.
 *
 * Three layers of protection, cheapest first:
 *   1. in-process promise memo — collapses the value+catalog pair within one CLI run
 *   2. SetSnapshot row for today — collapses repeat runs on the same day
 *   3. on 429, the newest snapshot of any age rather than a hard failure
 */

/** Keyed by `setNumber|day`; holds the in-flight promise so concurrent callers share one call. */
const inFlight = new Map<string, Promise<MappedSet>>();

interface SnapshotRow {
  payload: string;
  fetchedOn: string;
}

function parsePayload(row: SnapshotRow): BrickEconomySet | null {
  try {
    return JSON.parse(row.payload) as BrickEconomySet;
  } catch {
    return null;
  }
}

/**
 * Forms of a set number that denote the same set, so "10236" doesn't spend a second request
 * when "10236-1" was already fetched today.
 *
 * Only the "-1" variant is interchangeable with the bare number. "75192-2" is a genuinely
 * different variant and must never resolve to "75192"'s data.
 */
export function equivalentKeys(setNumber: string): string[] {
  if (setNumber.endsWith('-1')) return [setNumber, setNumber.slice(0, -2)];
  if (/-\d+$/.test(setNumber)) return [setNumber];
  return [setNumber, `${setNumber}-1`];
}

/**
 * Today's real snapshot. Provisional rows are excluded on purpose: they record that we served
 * stale data, and treating one as a cache hit would stop the next run from retrying after the
 * quota resets.
 */
async function readTodaySnapshot(setNumber: string, day: string): Promise<BrickEconomySet | null> {
  const row = await prisma.setSnapshot.findFirst({
    where: { setNumber: { in: equivalentKeys(setNumber) }, fetchedOn: day, provisional: false },
  });
  return row === null ? null : parsePayload(row);
}

async function readNewestSnapshot(setNumber: string): Promise<{ data: BrickEconomySet; fetchedOn: string } | null> {
  const row = await prisma.setSnapshot.findFirst({
    where: { setNumber: { in: equivalentKeys(setNumber) }, provisional: false },
    orderBy: { fetchedAt: 'desc' },
  });
  if (row === null) return null;
  const data = parsePayload(row);
  return data === null ? null : { data, fetchedOn: row.fetchedOn };
}

interface SnapshotFlags {
  provisional?: boolean;
  sourceFetchedOn?: string;
}

async function writeSnapshot(
  setNumber: string,
  day: string,
  data: BrickEconomySet,
  derived: string[],
  flags: SnapshotFlags = {},
): Promise<void> {
  const record = {
    payload: JSON.stringify(data),
    derived: JSON.stringify(derived),
    provisional: flags.provisional ?? false,
    sourceFetchedOn: flags.sourceFetchedOn ?? null,
  };
  await prisma.setSnapshot.upsert({
    where: { setNumber_fetchedOn: { setNumber, fetchedOn: day } },
    create: { setNumber, fetchedOn: day, ...record },
    update: record,
  });
}

/**
 * Keeps the Set row current. resolveSet in the engine only consults the catalog on first sight,
 * so without this a set that later retires would keep printing "in production" next to freshly
 * fetched prices. The engine reads the Set row before the adapter fetches, so a change here
 * shows up from the next run onward.
 */
async function refreshSetRow(meta: MappedSet['meta']): Promise<void> {
  await prisma.set.upsert({
    where: { setNumber: meta.setNumber },
    create: meta,
    update: meta,
  });
}

async function load(setNumber: string, day: string): Promise<MappedSet> {
  const factors = factorsFromEnv();

  // 2. Today's snapshot: serve both providers with no network at all.
  const cached = await readTodaySnapshot(setNumber, day);
  if (cached !== null) return mapSet(setNumber, cached, factors);

  try {
    const { data } = await fetchSetRaw(setNumber);

    // Snapshot the payload even if mapping fails. Otherwise a set whose payload cannot be
    // mapped is re-fetched on every single run, quietly draining the daily quota.
    let mapped: MappedSet;
    try {
      mapped = mapSet(setNumber, data, factors);
    } catch (mappingError) {
      await writeSnapshot(setNumber, day, data, []);
      throw mappingError;
    }

    await writeSnapshot(setNumber, day, data, mapped.derived);
    await refreshSetRow(mapped.meta);
    return mapped;
  } catch (error) {
    // 3. Quota spent: stale data beats no data, as long as we keep saying it is stale.
    if (error instanceof BrickEconomyQuotaError) {
      const fallback = await readNewestSnapshot(setNumber);
      if (fallback !== null) {
        const mapped = mapSet(setNumber, fallback.data, factors);

        // Record the staleness under today's key so every later run that day reports it —
        // including runs answered by the valuation cache, which never reach this code. The row
        // is provisional, so it is a disclosure and not a cache entry: reads skip it and the
        // next run still retries in case the quota has reset.
        await writeSnapshot(setNumber, day, fallback.data, mapped.derived, {
          provisional: true,
          sourceFetchedOn: fallback.fetchedOn,
        });

        console.warn(
          `  ! BrickEconomy daily limit hit — using cached data from ${fallback.fetchedOn}`,
        );
        return mapped;
      }
      throw new BrickEconomyQuotaError(
        'BrickEconomy daily limit hit (100 requests/day, resets 00:00 UTC) and no cached ' +
          `data exists for ${setNumber}. Try again after the reset.`,
      );
    }
    throw error;
  }
}

/** Returns the mapped set for today, fetching at most once per set per day. */
export function getSetData(setNumber: string): Promise<MappedSet> {
  const day = systemClock.today();
  const key = `${setNumber}|${day}`;

  // 1. Share the result between the value and catalog providers.
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  // Retained for the life of the process on success, not just while in flight: the engine
  // awaits the catalog leg fully before starting the value leg, so the two never overlap and
  // an in-flight-only memo would never once fire. Rejections are evicted so a failure stays
  // retryable rather than being cached.
  const pending = load(setNumber, day).catch((error: unknown) => {
    inFlight.delete(key);
    throw error;
  });
  inFlight.set(key, pending);
  return pending;
}

export interface Provenance {
  /** Engine fields estimated rather than observed. */
  derived: string[];
  /** Set when the numbers came from an earlier day because the quota was spent. */
  staleFrom: string | null;
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
 * How trustworthy today's numbers are, for the CLI to disclose.
 *
 * Reads today's row *including* provisional ones — that is the whole point of writing them.
 * A run answered by the valuation cache never enters load(), so the transient console.warn on
 * the quota path fires once and never again; without this lookup, month-old prices would show
 * as ordinary cached data for the rest of the day.
 *
 * Falls back to the newest row of any age so estimated bands are still disclosed when today
 * has no row at all.
 */
export async function getProvenance(setNumber: string): Promise<Provenance> {
  const keys = equivalentKeys(setNumber);
  const row =
    (await prisma.setSnapshot.findFirst({
      where: { setNumber: { in: keys }, fetchedOn: systemClock.today() },
    })) ??
    (await prisma.setSnapshot.findFirst({
      where: { setNumber: { in: keys } },
      orderBy: { fetchedAt: 'desc' },
    }));

  if (row === null) return { derived: [], staleFrom: null };

  // Recompute from the payload rather than trusting the stored list. `derived` is a pure
  // function of payload + factors, so a stored copy goes stale the moment either changes —
  // and a stale copy claims a field was estimated when it is now reported as unavailable.
  // The column is kept as a debugging record and used only if re-mapping fails.
  const payload = parsePayload(row);
  let derived = parseDerived(row.derived);
  if (payload !== null) {
    try {
      derived = mapSet(row.setNumber, payload, factorsFromEnv()).derived;
    } catch {
      // Unmappable payload: fall back to whatever was recorded at write time.
    }
  }

  return {
    derived,
    staleFrom: row.provisional ? row.sourceFetchedOn : null,
  };
}
