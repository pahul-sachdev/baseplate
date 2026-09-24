import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The invariant this whole feature rests on: a set's figure panel renders from cache, so opening
 * a set with twenty-four minifigures spends nothing.
 *
 * fetch is stubbed to THROW for the entire suite. Every assertion below therefore doubles as proof
 * that assembling panels — for one set or twenty, valued or not — cannot reach BrickEconomy. The
 * expensive mistake here is not a wrong number; it is a burst of requests nobody asked for.
 *
 * Same shape as previews.test.ts: a throwaway copy of dev.db for its schema, and the real database
 * is never touched.
 */

const DB_PATH = join(tmpdir(), `baseplate-minifigreads-test-${process.pid}.db`);

let reads: typeof import('./minifigReads.ts');
let prisma: import('@prisma/client').PrismaClient;
let today: string;
let fetchCalls = 0;

/** Unique to this suite so a seeded row can never collide with whatever dev.db already holds. */
const BIG_SET = 'MQ9001-1';       // 24 figures, none valued — the burst risk
const PART_SET = 'MQ9002-1';      // part-shaped ids, one permanently absent
const MIXED_SET = 'MQ9003-1';     // valued + priceless + unvalued + unreadable
const UNVALUED_SET = 'MQ9004-1';  // never valued at all
const DUPES_SET = 'MQ9005-1';     // count exceeds the named list

const BIG_IDS = Array.from({ length: 24 }, (_, i) => `mq${String(i + 1).padStart(4, '0')}`);

function yesterdayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString().slice(0, 10);
}

async function seedSetWithFigs(
  setNumber: string,
  minifigs: string[],
  opts: { count?: number; sealed?: number | null } = {},
): Promise<void> {
  await prisma.setSnapshot.create({
    data: {
      setNumber,
      fetchedOn: today,
      payload: JSON.stringify({
        name: `Set ${setNumber}`,
        current_value_new: opts.sealed ?? 1000,
        minifigs,
        minifigs_count: opts.count ?? minifigs.length,
      }),
    },
  });
  if (opts.sealed === null) return;
  await prisma.set.create({
    data: {
      setNumber,
      name: `Set ${setNumber}`,
      theme: 'Test',
      pieces: 1000,
      msrp: 199.99,
      releaseYear: 2020,
      retired: false,
    },
  });
  await prisma.valuation.create({
    data: {
      setNumber,
      condition: 'sealed',
      sealed: opts.sealed ?? 1000,
      usedWithBox: null,
      usedNoBox: null,
      partOut: 400,
      trend: 0.05,
      fetchedOn: today,
    },
  });
}

async function seedFig(minifigNumber: string, value: number | null, on?: string): Promise<void> {
  await prisma.minifigSnapshot.create({
    data: {
      minifigNumber,
      fetchedOn: on ?? today,
      payload: JSON.stringify({
        minifig_number: minifigNumber,
        name: `Figure ${minifigNumber}`,
        ...(value === null ? {} : { current_value_new: value }),
        set_count: 1,
        sets: ['MQ9003-1'],
        currency: 'USD',
      }),
    },
  });
}

before(async () => {
  copyFileSync(join(process.cwd(), 'prisma', 'dev.db'), DB_PATH);
  process.env['DATABASE_URL'] = `file:${DB_PATH}`;

  // Imported after DATABASE_URL is set so the client binds to the copy.
  ({ prisma } = await import('./client.ts'));
  reads = await import('./minifigReads.ts');
  const { systemClock } = await import('./clock.ts');
  today = systemClock.today();

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('reading a minifig panel must never reach the network');
  }) as unknown as typeof fetch;

  await seedSetWithFigs(BIG_SET, BIG_IDS);

  // Hogwarts-shaped: part numbers BrickEconomy answers 400 for, one already confirmed absent.
  const partIds = Array.from({ length: 6 }, (_, i) => `90398pb${String(100 + i)}`);
  await seedSetWithFigs(PART_SET, [...partIds, 'mqhp001', 'mqhp002']);
  await prisma.minifigAbsence.create({
    data: {
      minifigNumber: partIds[0] as string,
      status: 400,
      // Thirty days old: a day-keyed negative cache would have re-spent this twenty-nine times.
      confirmedOn: yesterdayOf(today),
      attempts: 1,
    },
  });

  await seedSetWithFigs(MIXED_SET, ['mqmx001', 'mqmx002', 'mqmx003', 'mqmx004'], { sealed: 1000 });
  await seedFig('mqmx001', 400);
  await seedFig('mqmx002', null); // a record with no published value
  await prisma.minifigSnapshot.create({
    data: { minifigNumber: 'mqmx004', fetchedOn: today, payload: '{not json' },
  });

  await seedSetWithFigs(DUPES_SET, ['mqdp001', 'mqdp002'], { count: 4, sealed: 1000 });
  await seedFig('mqdp001', 300);
  await seedFig('mqdp002', 300);
});

after(async () => {
  await prisma.$disconnect();
  rmSync(DB_PATH, { force: true });
});

describe('the quota invariant — rendering is free', () => {
  it('builds a 24-figure panel with nothing valued and never reaches the network', async () => {
    const panel = await reads.readSetMinifigPanel(BIG_SET);
    assert.equal(panel.figs.length, 24);
    assert.ok(panel.figs.every((fig) => fig.state.kind === 'unvalued'));
    assert.equal(fetchCalls, 0);
  });

  it('does not degrade with N — twenty panels are still zero requests', async () => {
    for (const setNumber of [BIG_SET, PART_SET, MIXED_SET, UNVALUED_SET, DUPES_SET]) {
      for (let i = 0; i < 4; i += 1) await reads.readSetMinifigPanel(setNumber);
    }
    assert.equal(fetchCalls, 0);
  });

  it('reads one figure’s detail page for free, even one never seen', async () => {
    const known = await reads.readMinifigDetail('mqmx001');
    const unknown = await reads.readMinifigDetail('mqzz999');
    assert.equal(known?.preview.state.kind, 'valued');
    assert.equal(unknown?.preview.state.kind, 'unvalued');
    assert.equal(fetchCalls, 0);
  });

  it('searches cached figures for free', async () => {
    const results = await reads.searchCachedMinifigs('Figure mqmx001');
    assert.ok(results.length >= 1);
    assert.equal(fetchCalls, 0);
  });

  it('an unvalued set has no roster and still spends nothing', async () => {
    const panel = await reads.readSetMinifigPanel(UNVALUED_SET);
    assert.equal(panel.roster.kind, 'no_payload');
    assert.equal(panel.figs.length, 0);
    assert.equal(fetchCalls, 0);
  });
});

describe('the batch plan cannot overstate its cost', () => {
  it('caps at the configured maximum and names what is left', async () => {
    const panel = await reads.readSetMinifigPanel(BIG_SET);
    assert.equal(panel.plan.requestCost, 4);
    assert.equal(panel.plan.remaining, 20);
    assert.equal(panel.plan.askable.length, 4);
  });

  it('excludes part-shaped ids and a confirmed absence from the plan', async () => {
    const panel = await reads.readSetMinifigPanel(PART_SET);
    // Six part-shaped ids (one already absent) plus two real ones. Only the real ones are askable.
    assert.deepEqual([...panel.plan.askable], ['mqhp001', 'mqhp002']);
    assert.equal(panel.plan.requestCost, 2);

    const reasons = new Set(panel.plan.skipped.map((s) => s.reason));
    assert.ok(reasons.has('not_batchable'));
    assert.ok(reasons.has('absent'));
  });

  it('a thirty-day-old absence is still absent — the negative cache is age-blind', async () => {
    // A day-keyed negative row would have re-opened this spend every midnight for a month.
    const panel = await reads.readSetMinifigPanel(PART_SET);
    const first = panel.figs.find((fig) => fig.minifigNumber === '90398pb100');
    assert.equal(first?.state.kind, 'absent');
    assert.ok(!panel.plan.askable.includes('90398pb100'));
  });

  it('costs nothing more once every figure is accounted for', async () => {
    const panel = await reads.readSetMinifigPanel(DUPES_SET);
    assert.equal(panel.plan.requestCost, 0);
  });
});

describe('honest states survive the round trip through the database', () => {
  it('separates valued, priceless, unvalued and unreadable', async () => {
    const panel = await reads.readSetMinifigPanel(MIXED_SET);
    const kinds = Object.fromEntries(panel.figs.map((f) => [f.minifigNumber, f.state.kind]));
    assert.equal(kinds['mqmx001'], 'valued');
    assert.equal(kinds['mqmx002'], 'no_price');
    assert.equal(kinds['mqmx003'], 'unvalued');
    assert.equal(kinds['mqmx004'], 'unreadable');
  });

  it('one unreadable payload cannot take the panel down', async () => {
    const panel = await reads.readSetMinifigPanel(MIXED_SET);
    assert.equal(panel.figs.length, 4);
    assert.equal(panel.share.kind, 'floor');
  });

  it('a priceless figure is not counted as valued in the share', async () => {
    const panel = await reads.readSetMinifigPanel(MIXED_SET);
    assert.equal(panel.share.coverage.valued, 1);
    assert.equal(panel.share.coverage.noPrice, 1);
    if (panel.share.kind !== 'floor') throw new Error('expected floor');
    assert.equal(panel.share.figTotal, 400);
  });

  it('a fully-valued roster stays a floor while the count exceeds the named list', async () => {
    // 4 counted, 2 named, both valued. The two unnamed figures cannot be valued, so 60% is a
    // floor rather than a measurement — and 60% already clears the bar, which IS a proof.
    const panel = await reads.readSetMinifigPanel(DUPES_SET);
    assert.equal(panel.share.kind, 'floor');
    assert.equal(panel.share.coverage.notNamed, 2);
    assert.equal(panel.flag.kind, 'rich');
    if (panel.flag.kind !== 'rich') return;
    assert.equal(panel.flag.proven, 'floor');
  });
});

describe('figure numbers have no equivalence rule', () => {
  it('matches case-insensitively', async () => {
    const [preview] = await reads.readMinifigPreviews(['MQMX001']);
    assert.equal(preview?.state.kind, 'valued');
  });

  it('does NOT fold a variant letter, unlike set numbers', async () => {
    // equivalentKeys() folds "10236" into "10236-1". Copying that here would file Chewbacca's
    // price under a different figure's name.
    await seedFig('mqvr001a', 99);
    const [withLetter] = await reads.readMinifigPreviews(['mqvr001a']);
    const [without] = await reads.readMinifigPreviews(['mqvr001']);
    assert.equal(withLetter?.state.kind, 'valued');
    assert.equal(without?.state.kind, 'unvalued');
  });

  it('ignores blank and whitespace-only ids without querying for them', async () => {
    assert.deepEqual(await reads.readMinifigPreviews(['', '   ']), []);
    assert.deepEqual(await reads.readMinifigPreviews([]), []);
  });
});

describe('the network was never reached, across every test above', () => {
  it('fetchCalls is still zero', () => {
    assert.equal(fetchCalls, 0);
  });
});
