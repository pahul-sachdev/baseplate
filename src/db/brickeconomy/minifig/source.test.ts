import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * The caching and absence policy for minifigures — where the quota is actually spent or saved.
 *
 * fetch is stubbed and COUNTED, so every assertion is about how many requests a sequence of user
 * actions costs. The rule that matters most: a figure BrickEconomy has no record of is asked once,
 * ever — and a quota error is never mistaken for that answer.
 */

const DB_PATH = join(tmpdir(), `baseplate-minifigsource-test-${process.pid}.db`);

let source: typeof import('./source.ts');
let prisma: import('@prisma/client').PrismaClient;
let today: string;

let fetchCalls = 0;
let respond: () => Response = () => new Response(JSON.stringify({ data: {} }), { status: 200 });

function figBody(minifigNumber: string, value: number | null): Response {
  return new Response(
    JSON.stringify({
      data: {
        minifig_number: minifigNumber,
        name: `Figure ${minifigNumber}`,
        ...(value === null ? {} : { current_value_new: value }),
        set_count: 1,
        sets: ['10236-1'],
        currency: 'USD',
      },
    }),
    { status: 200 },
  );
}

before(async () => {
  copyFileSync(join(process.cwd(), 'prisma', 'dev.db'), DB_PATH);
  process.env['DATABASE_URL'] = `file:${DB_PATH}`;
  // No pacing in tests; the real 1100ms gap would dominate a suite of stubbed calls.
  process.env['BRICKECONOMY_MIN_GAP_MS'] = '1';
  process.env['BRICKECONOMY_API_KEY'] = 'test-key';

  ({ prisma } = await import('../../client.ts'));
  source = await import('./source.ts');
  const { systemClock } = await import('../../clock.ts');
  today = systemClock.today();

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return respond();
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  source.resetMinifigSource();
  fetchCalls = 0;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(DB_PATH, { force: true });
});

describe('cache-first', () => {
  it('spends one request, then none for the rest of the day', async () => {
    respond = () => figBody('ms0001', 37.77);

    const first = await source.getMinifigLookup('ms0001');
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.facts.currentValueNew, 37.77);
    assert.equal(fetchCalls, 1);

    // A fresh process (memo cleared) still answers from the snapshot on disk.
    source.resetMinifigSource();
    const second = await source.getMinifigLookup('ms0001');
    assert.equal(second.ok, true);
    assert.equal(fetchCalls, 1);
  });

  it('collapses concurrent callers into one request', async () => {
    respond = () => figBody('ms0002', 10);
    const [a, b, c] = await Promise.all([
      source.getMinifigLookup('ms0002'),
      source.getMinifigLookup('ms0002'),
      source.getMinifigLookup('ms0002'),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.ok, true);
    assert.equal(fetchCalls, 1);
  });

  it('normalises case, so SW0509 and sw0509 are one figure and one request', async () => {
    respond = () => figBody('ms0003', 10);
    await source.getMinifigLookup('MS0003');
    source.resetMinifigSource();
    await source.getMinifigLookup('ms0003');
    assert.equal(fetchCalls, 1);
  });

  it('a figure with no published value is cached as such, not re-asked', async () => {
    respond = () => figBody('ms0004', null);
    const first = await source.getMinifigLookup('ms0004');
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.facts.currentValueNew, null);

    source.resetMinifigSource();
    await source.getMinifigLookup('ms0004');
    assert.equal(fetchCalls, 1);
  });
});

describe('the permanent negative cache', () => {
  it('records a 400 once and never asks again — not today, not on a later day', async () => {
    // The id is part-SHAPED but deliberately not a real one. Using the genuine 90398pb015 made
    // this test depend on dev.db never having a confirmed absence for it — which stopped being
    // true the first time the feature was exercised against the live API.
    respond = () => new Response('Bad Request', { status: 400 });

    const first = await source.getMinifigLookup('90398pbzz9');
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.reason, 'no_record');
    assert.equal(fetchCalls, 1);

    source.resetMinifigSource();
    const second = await source.getMinifigLookup('90398pbzz9');
    assert.equal(second.ok, false);
    assert.equal(fetchCalls, 1);

    // Simulate tomorrow by backdating the row: a day-keyed negative cache would re-spend here.
    await prisma.minifigAbsence.update({
      where: { minifigNumber: '90398pbzz9' },
      data: { confirmedOn: '2020-01-01' },
    });
    source.resetMinifigSource();
    const later = await source.getMinifigLookup('90398pbzz9');
    assert.equal(later.ok, false);
    assert.equal(fetchCalls, 1);
  });

  it('a 429 is NEVER recorded as an absence', async () => {
    // A quota error is not evidence that a figure does not exist. Caching one would permanently
    // mark a valuable figure unvaluable.
    respond = () => new Response('Too Many Requests', { status: 429 });

    const result = await source.getMinifigLookup('ms0005');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'quota');

    assert.equal(await prisma.minifigAbsence.findUnique({ where: { minifigNumber: 'ms0005' } }), null);
    // And nothing was written that could masquerade as data.
    assert.equal(await prisma.minifigSnapshot.findFirst({ where: { minifigNumber: 'ms0005' } }), null);
  });

  it('a network failure is never recorded as an absence either', async () => {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const result = await source.getMinifigLookup('ms0006');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unavailable');
    assert.equal(await prisma.minifigAbsence.findUnique({ where: { minifigNumber: 'ms0006' } }), null);

    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return respond();
    }) as unknown as typeof fetch;
  });

  it('"ask again" overrides the absence exactly once and bumps attempts', async () => {
    respond = () => new Response('Bad Request', { status: 400 });
    await source.getMinifigLookup('ms0007');
    const before = await prisma.minifigAbsence.findUnique({ where: { minifigNumber: 'ms0007' } });
    assert.equal(before?.attempts, 1);

    fetchCalls = 0;
    respond = () => figBody('ms0007', 42);
    const retried = await source.askAgainMinifig('ms0007');
    assert.equal(fetchCalls, 1);
    assert.equal(retried.ok, true);
    if (retried.ok) assert.equal(retried.facts.currentValueNew, 42);
  });

  it('a Rebrickable id is refused before any request is made', async () => {
    const result = await source.getMinifigLookup('fig-001549');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unaddressable');
    assert.equal(fetchCalls, 0);
    // And nothing is recorded: there is no mapping to ask through, so this is not an absence.
    assert.equal(await prisma.minifigAbsence.findUnique({ where: { minifigNumber: 'fig-001549' } }), null);
  });
});

describe('quota exhaustion serves stale data, and says so', () => {
  it('falls back to the newest snapshot and marks the row provisional', async () => {
    respond = () => figBody('ms0008', 100);
    await source.getMinifigLookup('ms0008');

    // Backdate it so today has no real row, then exhaust the quota.
    await prisma.minifigSnapshot.updateMany({
      where: { minifigNumber: 'ms0008' },
      data: { fetchedOn: '2026-06-01' },
    });
    source.resetMinifigSource();
    fetchCalls = 0;
    respond = () => new Response('Too Many Requests', { status: 429 });

    const result = await source.getMinifigLookup('ms0008');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.facts.currentValueNew, 100);
    // The disclosure: these numbers are real, and they are not today's.
    assert.equal(result.staleFrom, '2026-06-01');

    const provisional = await prisma.minifigSnapshot.findFirst({
      where: { minifigNumber: 'ms0008', fetchedOn: today, provisional: true },
    });
    assert.ok(provisional !== null);
    assert.equal(provisional.sourceFetchedOn, '2026-06-01');
  });

  it('a provisional row is a disclosure, not a cache entry — the next click still retries', async () => {
    source.resetMinifigSource();
    fetchCalls = 0;
    respond = () => figBody('ms0008', 123);

    const result = await source.getMinifigLookup('ms0008');
    assert.equal(fetchCalls, 1);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.staleFrom, null);
  });
});

describe('refresh', () => {
  it('discards the cached numbers and spends one request', async () => {
    respond = () => figBody('ms0009', 10);
    await source.getMinifigLookup('ms0009');
    assert.equal(fetchCalls, 1);

    respond = () => figBody('ms0009', 20);
    const refreshed = await source.refreshMinifig('ms0009');
    assert.equal(fetchCalls, 2);
    assert.equal(refreshed.ok, true);
    if (refreshed.ok) assert.equal(refreshed.facts.currentValueNew, 20);
  });

  it('does NOT clear an absence — re-asking is its own decision, with its own button', async () => {
    respond = () => new Response('Bad Request', { status: 400 });
    await source.getMinifigLookup('ms0010');
    fetchCalls = 0;

    const result = await source.refreshMinifig('ms0010');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'no_record');
    assert.equal(fetchCalls, 0);
  });
});
