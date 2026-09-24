import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Covers the read that makes this whole feature free: a set's figure list comes out of the
 * BrickEconomy payload already cached on disk, so building a figure panel spends nothing.
 *
 * fetch is stubbed to THROW for the whole suite. Every assertion below therefore doubles as proof
 * that reading a roster — for one set or twenty — cannot reach BrickEconomy. Same shape as
 * previews.test.ts: a throwaway copy of dev.db for its schema, and the real database is untouched.
 */

const DB_PATH = join(tmpdir(), `baseplate-minifigrefs-test-${process.pid}.db`);

let refs: typeof import('./minifigRefs.ts');
let prisma: import('@prisma/client').PrismaClient;
let fetchCalls = 0;

/** Unique to this suite so a seeded row can never collide with whatever dev.db already holds. */
const EWOK = 'MR9001-1';
/** Stored BARE while its equivalent carries "-1" — the shape 75192 really has in this database. */
const BARE = 'MR9002';
/** A payload mentioning minifigures nowhere, like Big Ben and the helmets. */
const NO_FIGS = 'MR9003-1';
/** A snapshot whose payload will not parse. */
const BROKEN = 'MR9004-1';
/** Never valued at all. */
const UNVALUED = 'MR9005-1';
/** An older real snapshot plus a newer PROVISIONAL one — the real row must win. */
const PROVISIONAL = 'MR9006-1';

async function seedSnapshot(
  setNumber: string,
  fetchedOn: string,
  payload: string,
  flags: { provisional?: boolean } = {},
): Promise<void> {
  await prisma.setSnapshot.create({
    data: {
      setNumber,
      fetchedOn,
      payload,
      provisional: flags.provisional ?? false,
      sourceFetchedOn: flags.provisional === true ? '2026-01-01' : null,
    },
  });
}

before(async () => {
  copyFileSync(join(process.cwd(), 'prisma', 'dev.db'), DB_PATH);
  process.env['DATABASE_URL'] = `file:${DB_PATH}`;

  // Imported after DATABASE_URL is set so the client binds to the copy.
  ({ prisma } = await import('../client.ts'));
  refs = await import('./minifigRefs.ts');

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('readSetRoster must never reach the network');
  }) as unknown as typeof fetch;

  await seedSnapshot(
    EWOK,
    '2026-07-30',
    JSON.stringify({
      name: 'Ewok Village',
      current_value_new: 1900,
      minifigs_count: 17,
      minifigs: ['sw0011a', 'sw0509', 'sw0510', 'sw0511'],
    }),
  );

  // Filed under the bare number, queried by either spelling.
  await seedSnapshot(
    BARE,
    '2026-07-30',
    JSON.stringify({ minifigs_count: 8, minifigs: ['sw0532', 'sw0661'] }),
  );

  await seedSnapshot(NO_FIGS, '2026-07-30', JSON.stringify({ name: 'Big Ben', current_value_new: 300 }));
  await seedSnapshot(BROKEN, '2026-07-30', '{not json at all');

  // Older real row, newer provisional row. The provisional one must be skipped.
  await seedSnapshot(PROVISIONAL, '2026-07-01', JSON.stringify({ minifigs: ['sw0001c'] }));
  await seedSnapshot(PROVISIONAL, '2026-07-30', JSON.stringify({ minifigs: ['sw9999'] }), {
    provisional: true,
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(DB_PATH, { force: true });
});

describe('readSetRoster', () => {
  it('reads a figure list straight out of a cached set payload', async () => {
    const { roster, fetchedOn } = await refs.readSetRoster(EWOK);
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.deepEqual(roster.figs.listed, ['sw0011a', 'sw0509', 'sw0510', 'sw0511']);
    assert.equal(roster.figs.reported, 17);
    assert.equal(fetchedOn, '2026-07-30');
  });

  it('resolves through equivalentKeys, so a bare-numbered snapshot is not invisible', async () => {
    // 75192 is stored bare in the real database while everything else carries "-1". An exact
    // match here would report "no minifigures" for a set whose figures are sitting on disk.
    const viaBare = await refs.readSetRoster(BARE);
    const viaSuffix = await refs.readSetRoster(`${BARE}-1`);
    assert.equal(viaBare.roster.kind, 'listed');
    assert.equal(viaSuffix.roster.kind, 'listed');
    if (viaSuffix.roster.kind !== 'listed') return;
    assert.deepEqual(viaSuffix.roster.figs.listed, ['sw0532', 'sw0661']);
  });

  it('reports not_listed for a payload that never mentions minifigures', async () => {
    const { roster } = await refs.readSetRoster(NO_FIGS);
    assert.equal(roster.kind, 'not_listed');
  });

  it('reports unreadable for a payload that will not parse, never "no minifigures"', async () => {
    const { roster } = await refs.readSetRoster(BROKEN);
    assert.equal(roster.kind, 'unreadable');
  });

  it('reports no_payload for a set that has never been valued', async () => {
    const { roster, fetchedOn } = await refs.readSetRoster(UNVALUED);
    assert.equal(roster.kind, 'no_payload');
    assert.equal(fetchedOn, null);
  });

  it('skips a provisional row and uses the older real one', async () => {
    // A provisional row is a staleness disclosure, not a cache entry — same rule as every other
    // snapshot read in this app.
    const { roster, fetchedOn } = await refs.readSetRoster(PROVISIONAL);
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.deepEqual(roster.figs.listed, ['sw0001c']);
    assert.equal(fetchedOn, '2026-07-01');
  });
});

describe('readSetRosters — batched', () => {
  it('returns one entry per requested set, in one query', async () => {
    const rosters = await refs.readSetRosters([EWOK, NO_FIGS, UNVALUED, BROKEN, `${BARE}-1`]);
    assert.equal(rosters.size, 5);
    assert.equal(rosters.get(EWOK)?.roster.kind, 'listed');
    assert.equal(rosters.get(NO_FIGS)?.roster.kind, 'not_listed');
    assert.equal(rosters.get(UNVALUED)?.roster.kind, 'no_payload');
    assert.equal(rosters.get(BROKEN)?.roster.kind, 'unreadable');
    assert.equal(rosters.get(`${BARE}-1`)?.roster.kind, 'listed');
  });

  it('handles an empty request without touching the database', async () => {
    assert.equal((await refs.readSetRosters([])).size, 0);
  });
});

describe('the quota invariant', () => {
  it('never reaches the network, however many rosters are read', async () => {
    // The whole feature rests on this: opening a set's detail page shows every figure it
    // contains, and costs nothing.
    await refs.readSetRoster(EWOK);
    await refs.readSetRosters([EWOK, BARE, NO_FIGS, BROKEN, UNVALUED, PROVISIONAL]);
    assert.equal(fetchCalls, 0);
  });
});
