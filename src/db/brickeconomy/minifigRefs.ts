import { prisma } from '../client.ts';
import { readRoster, type MinifigRoster, type RosterSource } from '../../lib/minifigRoster.ts';
import { equivalentKeys } from './source.ts';

/**
 * Which figures are in a set, read from the BrickEconomy payload ALREADY ON DISK.
 *
 * This is the file that removes Rebrickable from the critical path. BrickEconomy's set response
 * carries a `minifigs` array in its own (BrickLink) id space — the same space `/minifig/{n}` is
 * keyed by — and SetSnapshot.payload has been storing it verbatim since the adapter was written.
 * `BrickEconomySet` never modelled the field, so it has been arriving and being discarded. Reading
 * it back costs ZERO requests and works retroactively for every set ever valued.
 *
 * The alternative — Rebrickable's /lego/sets/{n}/minifigs/ — returns `fig-001549` ids that cannot
 * be joined to `sw0509`: Rebrickable publishes external_ids for parts but not minifigures, its
 * bulk CSV has no BrickLink column, and its staff closed the request to add one. So that path
 * could never have valued anything.
 *
 * Deliberately NOT a change to `BrickEconomySet` in the frozen types.ts. That interface already
 * omits `upc`, `ean` and four `retail_price_*` fields that every real payload carries — it is a
 * partial view by design, not drift. Both existing readers do an unchecked
 * `JSON.parse(payload) as BrickEconomySet`, so declaring one more field would buy no runtime
 * safety at all; validating here, at the read site, is strictly stronger.
 *
 * A read model: it touches the database and nothing else, and cannot reach the network.
 */

export interface SetRoster {
  roster: MinifigRoster;
  /** The day the payload the roster came from was fetched. Null when there is no payload. */
  fetchedOn: string | null;
}

function parseSource(payload: string): RosterSource | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null ? (parsed as RosterSource) : null;
  } catch {
    return null;
  }
}

/**
 * The newest real snapshot's figure list.
 *
 * Provisional rows are excluded, matching every other snapshot read: a provisional row is a
 * staleness disclosure rather than a cache entry. Note the roster does not go stale the way prices
 * do — a set's figure list does not change — so the newest payload of ANY age is the right source,
 * and `fetchedOn` is reported so the panel can say where it came from.
 *
 * Matched through equivalentKeys, which is not optional: this database stores "75192" bare while
 * every other row carries the "-1" suffix, so an exact-match read would return an empty roster for
 * a set whose figures are sitting right there.
 */
export async function readSetRoster(setNumber: string): Promise<SetRoster> {
  const row = await prisma.setSnapshot.findFirst({
    where: { setNumber: { in: equivalentKeys(setNumber) }, provisional: false },
    orderBy: { fetchedAt: 'desc' },
  });

  if (row === null) return { roster: readRoster({ kind: 'absent' }), fetchedOn: null };

  const source = parseSource(row.payload);
  if (source === null) {
    return {
      roster: readRoster({ kind: 'unreadable', reason: 'the cached response could not be parsed' }),
      fetchedOn: row.fetchedOn,
    };
  }

  return { roster: readRoster({ kind: 'payload', data: source }), fetchedOn: row.fetchedOn };
}

/**
 * Rosters for several sets at once, for a future board that wants the figure-rich flag in a grid.
 *
 * One query whatever N is, like readSetPreviews — the per-set alternative would be N queries for a
 * page that is supposed to be free.
 */
export async function readSetRosters(
  setNumbers: readonly string[],
): Promise<Map<string, SetRoster>> {
  const out = new Map<string, SetRoster>();
  if (setNumbers.length === 0) return out;

  const requested = [...new Set(setNumbers)];
  const lookup = new Map<string, string>();
  for (const setNumber of requested) {
    for (const key of equivalentKeys(setNumber)) lookup.set(key, setNumber);
  }

  const rows = await prisma.setSnapshot.findMany({
    where: { setNumber: { in: [...lookup.keys()] }, provisional: false },
    orderBy: { fetchedAt: 'asc' },
  });

  // Ascending, so the last row written for a requested number wins — the newest payload.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const requestedNumber = lookup.get(row.setNumber);
    if (requestedNumber !== undefined) newest.set(requestedNumber, row);
  }

  for (const setNumber of requested) {
    const row = newest.get(setNumber);
    if (row === undefined) {
      out.set(setNumber, { roster: readRoster({ kind: 'absent' }), fetchedOn: null });
      continue;
    }
    const source = parseSource(row.payload);
    out.set(setNumber, {
      roster:
        source === null
          ? readRoster({ kind: 'unreadable', reason: 'the cached response could not be parsed' })
          : readRoster({ kind: 'payload', data: source }),
      fetchedOn: row.fetchedOn,
    });
  }
  return out;
}
