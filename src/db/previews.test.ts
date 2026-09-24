import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Covers the read model behind the Lookup grid, where the expensive mistake is not a wrong number
 * but a request nobody asked for.
 *
 * fetch is stubbed to THROW for the whole suite. Every assertion below therefore doubles as proof
 * that assembling preview cards — twenty of them, most with no cached data at all — cannot reach
 * BrickEconomy. That is the invariant the feature rests on: browsing is free, valuing is not.
 *
 * Same shape as brickset/sync.test.ts: a throwaway copy of dev.db for its schema, and the real
 * database is never touched.
 */

const DB_PATH = join(tmpdir(), `baseplate-previews-test-${process.pid}.db`);

let previews: typeof import('./previews.ts');
let prisma: import('@prisma/client').PrismaClient;
let today: string;
let fetchCalls = 0;

/** Unique to this suite so a seeded row can never collide with whatever dev.db already holds. */
const FRESH = 'PV9001-1';
const STALE = 'PV9002-1';
const UNVALUED = 'PV9003-1';
/** Valued ONLY under a used condition — the shape that used to read as "not valued yet". */
const USED_ONLY = 'PV9004-1';
/** Two conditions on different days, to pin which one answers. */
const TWO_DAYS = 'PV9005-1';
/** Filed under the bare number today, and under the "-1" form yesterday. */
const SPLIT_FRESH = 'PV9006-1';

function snapshotPayload(sealed: number): string {
  return JSON.stringify({ name: 'Test Set', current_value_new: sealed });
}

function yesterdayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function seedSet(setNumber: string): Promise<void> {
  await prisma.set.create({
    data: {
      setNumber,
      name: `Name ${setNumber}`,
      theme: 'Icons',
      pieces: 1000,
      msrp: 199.99,
      releaseYear: 2020,
      retired: false,
    },
  });
}

async function seedValuation(
  setNumber: string,
  fetchedOn: string,
  condition = 'sealed',
  overrides: { sealed?: number; usedWithBox?: number | null; usedNoBox?: number | null } = {},
): Promise<void> {
  await prisma.valuation.create({
    data: {
      setNumber,
      condition,
      sealed: overrides.sealed ?? 1000,
      usedWithBox: overrides.usedWithBox === undefined ? 800 : overrides.usedWithBox,
      usedNoBox: overrides.usedNoBox === undefined ? null : overrides.usedNoBox,
      partOut: 400,
      trend: 0.084,
      fetchedOn,
    },
  });
}

before(async () => {
  copyFileSync(join(process.cwd(), 'prisma', 'dev.db'), DB_PATH);
  process.env['DATABASE_URL'] = `file:${DB_PATH}`;

  // Imported after DATABASE_URL is set so the client binds to the copy.
  ({ prisma } = await import('./client.ts'));
  previews = await import('./previews.ts');
  const { systemClock } = await import('./clock.ts');
  today = systemClock.today();

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('readSetPreviews must never reach the network');
  }) as unknown as typeof fetch;

  await seedSet(FRESH);
  await seedSet(STALE);
  await seedValuation(FRESH, today);
  await seedValuation(STALE, today);

  // Mirrors 10232-1 / 75021-1 in the real database: valued, but never under 'sealed'.
  await seedSet(USED_ONLY);
  await seedValuation(USED_ONLY, today, 'used_box', {
    sealed: 371.99,
    usedWithBox: 253.67,
    usedNoBox: 244.46,
  });

  // Yesterday's sealed row against today's used_nobox row — freshness has to win.
  await seedSet(TWO_DAYS);
  await seedValuation(TWO_DAYS, yesterdayOf(today), 'sealed', { sealed: 111 });
  await seedValuation(TWO_DAYS, today, 'used_nobox', { sealed: 222 });

  // A stale row under the exact spelling, a fresh one under the equivalent bare number.
  await seedSet(SPLIT_FRESH);
  await seedSet(SPLIT_FRESH.slice(0, -2));
  await seedValuation(SPLIT_FRESH, yesterdayOf(today), 'sealed', { sealed: 333 });
  await seedValuation(SPLIT_FRESH.slice(0, -2), today, 'sealed', { sealed: 444 });

  // Filed under the BARE number while every card asks for the "-1" form — the split-key case that
  // exists in the real database.
  await prisma.setSnapshot.create({
    data: {
      setNumber: FRESH.slice(0, -2),
      fetchedOn: today,
      payload: snapshotPayload(1000),
      derived: '[]',
      provisional: false,
    },
  });

  // Quota-exhausted disclosure: filed under today, holding an earlier day's numbers.
  await prisma.setSnapshot.create({
    data: {
      setNumber: STALE,
      fetchedOn: today,
      payload: snapshotPayload(900),
      derived: '[]',
      provisional: true,
      sourceFetchedOn: '2026-07-01',
    },
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(DB_PATH, { force: true });
});

describe('readSetPreviews — a wide search is free', () => {
  it('builds twenty cards, mostly uncached, without one network call', async () => {
    const many = Array.from({ length: 20 }, (_, index) => `PV80${String(index).padStart(2, '0')}-1`);

    const rows = await previews.readSetPreviews(many);

    assert.equal(rows.length, 20);
    assert.equal(fetchCalls, 0);
    // Every one reports honestly that it has no numbers, rather than going and getting some.
    assert.ok(rows.every((row) => row.valuation.kind === 'none'));
  });

  it('returns one row per requested set, in order', async () => {
    const rows = await previews.readSetPreviews([UNVALUED, FRESH, STALE]);
    assert.deepEqual(
      rows.map((row) => row.meta.setNumber),
      [UNVALUED, FRESH, STALE],
    );
    assert.equal(fetchCalls, 0);
  });

  it('says nothing at all about a set it has never seen', async () => {
    const [row] = await previews.readSetPreviews(['PV7777-1']);
    assert.ok(row);
    assert.equal(row.valuation.kind, 'none');
    assert.equal(row.meta.name, 'Set PV7777-1');
    assert.equal(row.meta.msrp, null);
    assert.equal(row.meta.pieces, null);
    assert.equal(row.meta.retireDate, null);
  });
});

describe('readSetPreviews — grading what is cached', () => {
  it('auto-fills a set valued today', async () => {
    const [row] = await previews.readSetPreviews([FRESH]);
    assert.ok(row);
    assert.equal(row.valuation.kind, 'fresh');
    assert.equal(row.valuation.valuation.sealed, 1000);
    assert.equal(row.valuation.fetchedOn, today);
  });

  it('grades a provisional snapshot as stale even though it is filed under today', async () => {
    const [row] = await previews.readSetPreviews([STALE]);
    assert.ok(row);
    // The row carries today's date; only staleFrom reveals the numbers are from 2026-07-01.
    assert.equal(row.valuation.kind, 'stale');
    assert.equal(row.valuation.provenance.staleFrom, '2026-07-01');
  });

  it('finds a snapshot filed under the other spelling of the number', async () => {
    // The snapshot lives under the bare number; the card asked for the "-1" form.
    const [row] = await previews.readSetPreviews([FRESH]);
    assert.ok(row);
    if (row.valuation.kind === 'none') return assert.fail('expected a valuation');
    assert.equal(row.valuation.provenance.staleFrom, null);

    // And the figures are reported under the number the caller asked for, not the stored key.
    assert.equal(row.valuation.valuation.setNumber, FRESH);
  });

  it('does not treat a different variant as the same set', async () => {
    // "-2" is a genuinely different set and must never inherit "-1"'s data.
    const [row] = await previews.readSetPreviews([`${FRESH.slice(0, -2)}-2`]);
    assert.ok(row);
    assert.equal(row.valuation.kind, 'none');
  });

  it('answers for every condition from one stored row, whatever it was filed under', async () => {
    // The invariant this feature exists for. USED_ONLY was valued under 'used_box' and has no
    // sealed row at all — the shape of 10232-1 and 75021-1 in the real database. It used to read
    // as "not valued yet", offering to spend a request for numbers already sitting on disk.
    const [row] = await previews.readSetPreviews([USED_ONLY]);
    assert.ok(row);
    if (row.valuation.kind === 'none') return assert.fail('a used-only set must read as valued');

    // Every band is present, including the sealed figure the row always carried.
    assert.equal(row.valuation.valuation.sealed, 371.99);
    assert.equal(row.valuation.valuation.usedWithBox, 253.67);
    assert.equal(row.valuation.valuation.usedNoBox, 244.46);
    assert.equal(fetchCalls, 0);
  });

  it('takes the newest day, whichever condition that row happens to carry', async () => {
    const [row] = await previews.readSetPreviews([TWO_DAYS]);
    assert.ok(row);
    if (row.valuation.kind === 'none') return assert.fail('expected a valuation');

    // Today's used_nobox row (sealed 222) beats yesterday's sealed row (sealed 111).
    assert.equal(row.valuation.valuation.sealed, 222);
    assert.equal(row.valuation.kind, 'fresh');
    assert.equal(row.valuation.fetchedOn, today);
  });

  it('prefers a fresh equivalent spelling over a stale exact one', async () => {
    // Picking the stale exact row would show a stale banner on a set valued today and offer a
    // Refresh that spends a request for nothing.
    const [row] = await previews.readSetPreviews([SPLIT_FRESH]);
    assert.ok(row);
    if (row.valuation.kind === 'none') return assert.fail('expected a valuation');

    assert.equal(row.valuation.valuation.sealed, 444);
    assert.equal(row.valuation.kind, 'fresh');
    // Still reported under the number the caller asked for.
    assert.equal(row.valuation.valuation.setNumber, SPLIT_FRESH);
    assert.equal(fetchCalls, 0);
  });
});

describe('readSetPreviews — free catalogue data', () => {
  it('takes the piece count and photo from the search payload it was handed', async () => {
    const catalog = new Map([
      [
        UNVALUED,
        {
          name: 'Ewok Village',
          year: 2013,
          theme: 'Star Wars',
          pieces: 1990,
          imageUrl: 'https://cdn.rebrickable.com/media/sets/10236-1.jpg',
        },
      ],
    ]);

    const [row] = await previews.readSetPreviews([UNVALUED], catalog);
    assert.ok(row);
    assert.equal(row.meta.name, 'Ewok Village');
    assert.equal(row.meta.pieces, 1990);
    assert.equal(row.meta.theme, 'Star Wars');
    assert.equal(fetchCalls, 0);
  });

  it('falls back to the engine catalogue for a set that has been valued', async () => {
    const [row] = await previews.readSetPreviews([FRESH]);
    assert.ok(row);
    assert.equal(row.meta.name, `Name ${FRESH}`);
    assert.equal(row.meta.pieces, 1000);
    assert.equal(row.meta.msrp, 199.99);
  });
});

describe('the suite never reached the network', () => {
  it('made zero fetch calls in total', () => {
    assert.equal(fetchCalls, 0);
  });
});
