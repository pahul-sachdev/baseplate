import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Covers the sync, which is pure I/O wiring: pagination, the incremental cursor, and the
 * allowance-exhausted path. Runs against a throwaway copy of dev.db (for its schema) with a
 * stubbed fetch — no network, no Brickset usage, and the real database is never touched.
 *
 * Same shape as brickeconomy/source.quota.test.ts, for the same reason: these are the branches
 * where a silent failure produces a board that looks complete and is not.
 */

const DB_PATH = join(tmpdir(), `baseplate-brickset-test-${process.pid}.db`);
const NOW = new Date('2026-07-28T12:00:00Z');

interface StubPage {
  matches: number;
  count: number;
}

/** year -> the pages it answers with, in order. */
let pagesByYear = new Map<string, StubPage[]>();
/** Years that answer "API limit exceeded" instead of data. */
let limitYears = new Set<string>();
let getSetsCalls: Array<{ year: string; pageNumber: number; updatedSince: string | null }> = [];
let usageCalls = 0;

let sync: typeof import('./sync.ts');
let prisma: import('@prisma/client').PrismaClient;

function fakeSets(year: string, pageNumber: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: `${year}${String(pageNumber).padStart(2, '0')}${String(index).padStart(3, '0')}`,
    numberVariant: 1,
    name: `Set ${index}`,
    theme: 'Icons',
    year: Number(year),
    exitDate: '2026-11-30T00:00:00Z',
    LEGOCom: { US: { retailPrice: 99.99 } },
  }));
}

before(async () => {
  copyFileSync(join(process.cwd(), 'prisma', 'dev.db'), DB_PATH);
  process.env['DATABASE_URL'] = `file:${DB_PATH}`;
  process.env['BRICKSET_API_KEY'] = 'test-key';

  // Imported after DATABASE_URL is set so the client binds to the copy.
  ({ prisma } = await import('../client.ts'));
  sync = await import('./sync.ts');

  globalThis.fetch = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));

    if (parsed.pathname.endsWith('/getKeyUsageStats')) {
      usageCalls += 1;
      return new Response(
        JSON.stringify({ status: 'success', apiKeyUsage: [{ dateStamp: '2026-07-29T00:00:00Z', count: 7 }] }),
      );
    }

    const params = JSON.parse(parsed.searchParams.get('params') ?? '{}') as {
      year?: string;
      pageNumber?: number;
      updatedSince?: string;
    };
    const year = params.year ?? '';
    const pageNumber = params.pageNumber ?? 1;
    getSetsCalls.push({ year, pageNumber, updatedSince: params.updatedSince ?? null });

    if (limitYears.has(year)) {
      return new Response(JSON.stringify({ status: 'error', message: 'API limit exceeded' }));
    }

    const page = pagesByYear.get(year)?.[pageNumber - 1] ?? { matches: 0, count: 0 };
    return new Response(
      JSON.stringify({ status: 'success', matches: page.matches, sets: fakeSets(year, pageNumber, page.count) }),
    );
  }) as unknown as typeof fetch;

  await prisma.bricksetSet.deleteMany({});
  await prisma.bricksetSyncRun.deleteMany({});
});

after(async () => {
  await prisma.$disconnect();
  rmSync(DB_PATH, { force: true });
});

function reset(): void {
  getSetsCalls = [];
  limitYears = new Set();
  pagesByYear = new Map();
  usageCalls = 0;
}

describe('first sync', () => {
  before(async () => {
    reset();
    // 2022-2025 fit on one page; 2026 needs two, which is the case that matters.
    for (const year of ['2022', '2023', '2024', '2025']) {
      pagesByYear.set(year, [{ matches: 3, count: 3 }]);
    }
    pagesByYear.set('2026', [
      { matches: 503, count: 500 },
      { matches: 503, count: 3 },
    ]);

    await prisma.bricksetSet.deleteMany({});
    await prisma.bricksetSyncRun.deleteMany({});
  });

  it('runs in full mode when no completed full sync exists', async () => {
    const result = await sync.syncBricksetSets({ now: NOW, gapMs: 0 });

    assert.equal(result.mode, 'full');
    assert.equal(result.status, 'ok');
    assert.equal(result.message, null);
  });

  it('covers the current year and the prior four', async () => {
    const years = [...new Set(getSetsCalls.map((call) => call.year))].sort();
    assert.deepEqual(years, ['2022', '2023', '2024', '2025', '2026']);
  });

  it('pages a year until its matches are exhausted', async () => {
    // Driven by `matches`, which is the TOTAL for the query rather than the page length. Reading
    // it as a page count would stop after 500 sets and silently drop the rest of the year.
    const pages2026 = getSetsCalls.filter((call) => call.year === '2026').map((call) => call.pageNumber);
    assert.deepEqual(pages2026, [1, 2]);
  });

  it('stops paging a year that fits on one page', () => {
    assert.equal(getSetsCalls.filter((call) => call.year === '2023').length, 1);
  });

  it('sends no updatedSince on a full run', () => {
    assert.equal(getSetsCalls.every((call) => call.updatedSince === null), true);
  });

  it('writes the rows — the row count is the point of the whole sync', async () => {
    // 4 years x 3 + 2026's 500 + 3.
    assert.equal(await prisma.bricksetSet.count(), 515);
  });

  it('maps what it wrote', async () => {
    const row = await prisma.bricksetSet.findFirst({ where: { year: 2023 } });
    assert.ok(row);
    assert.equal(row.theme, 'Icons');
    assert.equal(row.usRetailPrice, 99.99);
    assert.equal(row.exitDate?.toISOString(), '2026-11-30T00:00:00.000Z');
    assert.match(row.setNumber, /-1$/);
  });

  it('records the run, with Brickset’s own reported usage from the free pre-flight', async () => {
    const run = await prisma.bricksetSyncRun.findFirst({ orderBy: { startedAt: 'desc' } });
    assert.ok(run);
    assert.equal(run.mode, 'full');
    assert.equal(run.status, 'ok');
    assert.equal(run.setsUpserted, 515);
    assert.equal(run.requests, 6);
    assert.equal(run.yearFrom, 2022);
    assert.equal(run.yearTo, 2026);
    assert.equal(run.reportedUsage30d, 7);
    assert.ok(run.finishedAt);
    assert.equal(usageCalls, 1);
  });
});

describe('subsequent sync', () => {
  before(() => {
    reset();
    for (const year of ['2022', '2023', '2024', '2025', '2026']) {
      pagesByYear.set(year, [{ matches: 1, count: 1 }]);
    }
  });

  it('switches to incremental once a full run has completed', async () => {
    const result = await sync.syncBricksetSets({ now: NOW, gapMs: 0 });
    assert.equal(result.mode, 'incremental');
    assert.equal(result.status, 'ok');
  });

  it('passes updatedSince from the previous run’s startedAt', () => {
    // startedAt, not finishedAt: a set updated while the previous run was in flight sits between
    // the two, and anchoring on finishedAt would step straight over it.
    assert.equal(getSetsCalls.length, 5);
    assert.equal(getSetsCalls.every((call) => call.updatedSince === '2026-07-28'), true);
  });

  it('upserts rather than duplicating', async () => {
    // 515 from the first run; the five re-sent sets already exist under the same primary key.
    assert.equal(await prisma.bricksetSet.count(), 515);
  });
});

describe('Brickset allowance exhausted part-way', () => {
  before(async () => {
    reset();
    for (const year of ['2022', '2023', '2024', '2025', '2026']) {
      pagesByYear.set(year, [{ matches: 1, count: 1 }]);
    }
    limitYears = new Set(['2024']);
    await prisma.bricksetSyncRun.deleteMany({});
  });

  it('stops and reports rather than throwing', async () => {
    // A thrown error would lose the rows already written and tell the user nothing.
    const result = await sync.syncBricksetSets({ now: NOW, force: true, gapMs: 0 });

    assert.equal(result.status, 'partial');
    assert.match(result.message ?? '', /limit reached/i);
    assert.match(result.message ?? '', /incomplete/i);
  });

  it('does not attempt the years after the failure', () => {
    const years = [...new Set(getSetsCalls.map((call) => call.year))].sort();
    assert.deepEqual(years, ['2022', '2023', '2024']);
  });

  it('records the run as partial, so the next sync still runs a full pass', async () => {
    // This is the whole reason BricksetSyncRun exists: without it, a half-finished first sync
    // would advance the incremental cursor and skip every set it never reached, forever.
    const run = await prisma.bricksetSyncRun.findFirst({ orderBy: { startedAt: 'desc' } });
    assert.equal(run?.status, 'partial');
    assert.equal(await sync.readIncrementalCursor(), null);
  });
});
