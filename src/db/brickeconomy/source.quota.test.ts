import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Covers the quota-exhaustion path, which is pure I/O wiring and was where the confirmed
 * staleness defect lived. Runs against a throwaway copy of dev.db (for its schema) with a
 * stubbed fetch — no network, no quota, and the real database is never touched.
 */

const DB_PATH = join(tmpdir(), `baseplate-quota-test-${process.pid}.db`);
const OLD_DAY = '2026-07-01';

const STALE_PAYLOAD = {
  set_number: '10236-1',
  name: 'Ewok Village',
  theme: 'Star Wars',
  year: 2013,
  pieces_count: 1990,
  retail_price_us: 249.99,
  retired: true,
  retired_date: '2016-11-29',
  current_value_new: 918,
  current_value_used: 590.46,
  current_value_used_low: 550,
  rolling_growth_12months: 3.11,
};

let fetchCalls = 0;
/** Flipped by the refresh suite below to exercise the success path. */
let stubResponse: () => Response = () => new Response('Too Many Requests', { status: 429 });
let source: typeof import('./source.ts');
let prisma: import('@prisma/client').PrismaClient;
let today: string;

before(async () => {
  copyFileSync(join(process.cwd(), 'prisma', 'dev.db'), DB_PATH);
  process.env['DATABASE_URL'] = `file:${DB_PATH}`;
  process.env['BRICKECONOMY_API_KEY'] = 'test-key';

  // Imported after DATABASE_URL is set so the client binds to the copy.
  ({ prisma } = await import('../client.ts'));
  const clock = await import('../clock.ts');
  today = clock.systemClock.today();
  source = await import('./source.ts');

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return stubResponse();
  }) as unknown as typeof fetch;

  await prisma.setSnapshot.deleteMany({});
  await prisma.setSnapshot.create({
    data: {
      setNumber: '10236-1',
      fetchedOn: OLD_DAY,
      payload: JSON.stringify(STALE_PAYLOAD),
      derived: '[]',
      provisional: false,
    },
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(DB_PATH, { force: true });
});

describe('quota exhausted, older data available', () => {
  it('serves the stale prices rather than failing', async () => {
    const { values } = await source.getSetData('10236-1');
    assert.equal(values.sealed, 918);
    assert.equal(fetchCalls, 1);
  });

  it('spends only one request for the whole run, via the retained memo', async () => {
    // The catalog and value legs are sequential in the engine, so an in-flight-only memo
    // would have let the second leg issue a second request.
    await source.getSetData('10236-1');
    assert.equal(fetchCalls, 1);
  });

  it('records the staleness under today so later runs can still report it', async () => {
    const row = await prisma.setSnapshot.findFirst({
      where: { setNumber: '10236-1', fetchedOn: today },
    });
    assert.ok(row, 'expected a provisional row for today');
    assert.equal(row.provisional, true);
    assert.equal(row.sourceFetchedOn, OLD_DAY);
  });

  it('reports staleness through provenance — the channel a cached run reads', async () => {
    // This is the fix for the confirmed defect: a later run that day is answered by the
    // valuation cache and never enters load(), so the transient console.warn never fires.
    const provenance = await source.getProvenance('10236-1');
    assert.equal(provenance.staleFrom, OLD_DAY);
  });

  it('does not serve the provisional row as cache, so the next run retries', async () => {
    // '10236' resolves to the same snapshot via equivalentKeys but is a separate memo key,
    // standing in for a subsequent run. It must attempt the API again rather than settle
    // for the provisional row — otherwise a quota reset could never be noticed.
    const before = fetchCalls;
    await source.getSetData('10236');
    assert.equal(fetchCalls, before + 1);
  });
});

describe('quota exhausted, nothing cached', () => {
  it('fails with a clear message rather than inventing data', async () => {
    await assert.rejects(
      () => source.getSetData('99999999'),
      (error: unknown) => {
        assert.match(String(error), /daily limit hit/i);
        assert.match(String(error), /no cached data/i);
        return true;
      },
    );
  });
});

describe('successful fetch keeps the Set row current', () => {
  const RETIRED_NOW = { ...STALE_PAYLOAD, set_number: '10276-1', name: 'Colosseum', retired: true, retired_date: '2023-06-30' };

  before(() => {
    stubResponse = () => new Response(JSON.stringify({ data: RETIRED_NOW }), { status: 200 });
  });

  it('upserts Set metadata from the fresh payload', async () => {
    // Without this the row is written once by the engine and frozen, so a set that later
    // retires keeps printing "in production" beside freshly fetched prices.
    await source.getSetData('10276');

    const row = await prisma.set.findUnique({ where: { setNumber: '10276' } });
    assert.ok(row, 'expected the adapter to have created the Set row');
    assert.equal(row.name, 'Colosseum');
    assert.equal(row.retired, true);
    assert.equal(row.retireDate?.toISOString().slice(0, 10), '2023-06-30');
  });

  it('writes a non-provisional snapshot that then serves as cache', async () => {
    const row = await prisma.setSnapshot.findFirst({
      where: { setNumber: '10276', fetchedOn: today },
    });
    assert.ok(row);
    assert.equal(row.provisional, false);
    assert.equal((await source.getProvenance('10276')).staleFrom, null);
  });
});
