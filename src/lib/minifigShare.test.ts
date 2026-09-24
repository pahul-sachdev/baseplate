import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MinifigPreview, MinifigValue } from './minifigPreview.ts';
import { readRoster, type MinifigRoster } from './minifigRoster.ts';
import {
  DEFAULT_MINIFIG_SHARE_THRESHOLD,
  coverageOf,
  minifigShare,
  richFlag,
  shareLines,
  shareThresholdFromEnv,
} from './minifigShare.ts';
import type { MinifigFacts } from './minifigValuePort.ts';

const DAY = '2026-07-30';

function facts(minifigNumber: string, value: number | null): MinifigFacts {
  return {
    minifigNumber,
    name: `Figure ${minifigNumber}`,
    description: null,
    theme: 'Star Wars',
    subtheme: null,
    year: 2013,
    releasedOn: null,
    currentValueNew: value,
    appearsIn: { listed: ['10236-1'], reported: 1 },
    priceEvents: [],
    currency: 'USD',
  };
}

function fig(minifigNumber: string, state: MinifigValue): MinifigPreview {
  return { minifigNumber, idKind: 'brickeconomy', name: null, imageUrl: null, state };
}

function valued(id: string, value: number, opts: { on?: string; staleFrom?: string } = {}): MinifigPreview {
  const on = opts.on ?? DAY;
  return fig(id, {
    kind: 'valued',
    minifigNumber: id,
    facts: facts(id, value),
    value,
    fetchedOn: on,
    freshness: opts.staleFrom === undefined && on === DAY ? 'fresh' : 'stale',
    provenance: { staleFrom: opts.staleFrom ?? null },
  });
}

const unvalued = (id: string): MinifigPreview =>
  fig(id, { kind: 'unvalued', minifigNumber: id, idKind: 'brickeconomy' });

const noPrice = (id: string): MinifigPreview =>
  fig(id, {
    kind: 'no_price',
    minifigNumber: id,
    facts: facts(id, null),
    fetchedOn: DAY,
    freshness: 'fresh',
    provenance: { staleFrom: null },
  });

const absent = (id: string): MinifigPreview =>
  fig(id, { kind: 'absent', minifigNumber: id, status: 400, confirmedOn: DAY, attempts: 1 });

const unaddressable = (id: string): MinifigPreview =>
  fig(id, { kind: 'unaddressable', minifigNumber: id, idKind: 'rebrickable' });

/** A roster naming `ids`, optionally reporting a higher count (duplicates upstream). */
function roster(ids: string[], reported?: number): MinifigRoster {
  return readRoster({
    kind: 'payload',
    data: { minifigs: ids, minifigs_count: reported ?? ids.length },
  });
}

function share(args: {
  figs: MinifigPreview[];
  reported?: number;
  setSealed?: number | null;
  setFetchedOn?: string | null;
  setStaleFrom?: string | null;
}) {
  const ids = args.figs.map((f) => f.minifigNumber);
  return minifigShare({
    roster: roster(ids, args.reported),
    figs: args.figs,
    setSealed: args.setSealed === undefined ? 1000 : args.setSealed,
    setFetchedOn: args.setFetchedOn === undefined ? DAY : args.setFetchedOn,
    setStaleFrom: args.setStaleFrom ?? null,
  });
}

describe('a partial sum is never presented as a complete one', () => {
  it('1 of 9 valued is a floor, and the headline says "at least"', () => {
    const figs = [valued('sw0001', 580), ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => unvalued(`sw000${s}`))];
    const result = share({ figs });
    assert.equal(result.kind, 'floor');
    if (result.kind !== 'floor') return;

    const lines = shareLines(result, richFlag(result, 0.5));
    assert.match(lines.headline, /At least/i);
    assert.match(lines.coverage, /1 of 9 named figures valued/);
    assert.equal(lines.tone, 'warn');
  });

  it('full coverage with nothing missing is a measurement, not a floor', () => {
    const result = share({ figs: [valued('sw0001', 300), valued('sw0002', 250)] });
    assert.equal(result.kind, 'measured');
    if (result.kind !== 'measured') return;
    assert.equal(result.coverage.isFloor, false);
    assert.match(shareLines(result, richFlag(result, 0.5)).headline, /Minifigures are 55%/);
  });

  it('stays a floor while BrickEconomy counts figures it did not name', () => {
    // Ewok Village: 17 counted, 15 named. The two unnamed ones cannot be valued, so even a
    // fully-valued roster understates the set's true figure content.
    const result = share({ figs: [valued('sw0001', 300), valued('sw0002', 250)], reported: 4 });
    assert.equal(result.kind, 'floor');
    if (result.kind !== 'floor') return;
    assert.equal(result.coverage.notNamed, 2);
    assert.match(shareLines(result, richFlag(result, 0.5)).coverage, /counts 4 figures .* names 2/);
  });

  it('always discloses that quantities are unknown', () => {
    const result = share({ figs: [valued('sw0001', 300), valued('sw0002', 250)] });
    assert.match(
      shareLines(result, richFlag(result, 0.5)).coverage,
      /counted once; BrickEconomy publishes no per-figure quantities/,
    );
  });
});

describe('no_price is its own bucket — the "$340 over a sum of two" bug', () => {
  it('a priceless figure is never counted as valued and contributes nothing', () => {
    const figs = [valued('sw0001', 200), valued('sw0002', 140), noPrice('sw0003'), noPrice('sw0004'), noPrice('sw0005')];
    const result = share({ figs });
    assert.equal(result.kind, 'floor');
    if (result.kind !== 'floor') return;

    assert.equal(result.coverage.valued, 2);
    assert.equal(result.coverage.noPrice, 3);
    assert.equal(result.figTotal, 340);

    const lines = shareLines(result, richFlag(result, 0.5));
    // The count beside the money must be 2, never 5.
    assert.match(lines.coverage, /2 of 5 named figures valued — \$340\.00 so far/);
    assert.match(lines.coverage, /3 have no published value/);
  });

  it('every non-valued state contributes zero and is named in the coverage line', () => {
    const figs = [valued('sw0001', 100), noPrice('sw0002'), absent('sw0003'), unaddressable('fig-000001')];
    const result = share({ figs });
    if (result.kind !== 'floor') throw new Error('expected floor');
    assert.equal(result.figTotal, 100);

    const coverage = shareLines(result, richFlag(result, 0.5)).coverage;
    assert.match(coverage, /1 has no published value/);
    assert.match(coverage, /1 is not in BrickEconomy’s minifigure catalogue/);
    assert.match(coverage, /1 cannot be looked up/);
  });
});

describe('the three-valued flag', () => {
  it('a floor that CLEARS the bar is a proof', () => {
    // 580 of 1000 = 58%, from one figure of nine. Valuing the rest can only raise it.
    const figs = [valued('sw0001', 580), unvalued('sw0002'), unvalued('sw0003')];
    const result = share({ figs });
    const flag = richFlag(result, 0.5);
    assert.equal(flag.kind, 'rich');
    if (flag.kind !== 'rich') return;
    assert.equal(flag.proven, 'floor');
    assert.match(shareLines(result, flag).headline, /can only rise/);
  });

  it('a floor that MISSES the bar is not_assessable, NEVER not_rich', () => {
    // 200 of 1000 = 20%, with two figures unvalued. They could carry it past 50%.
    const figs = [valued('sw0001', 200), unvalued('sw0002'), unvalued('sw0003')];
    const flag = richFlag(share({ figs }), 0.5);
    assert.equal(flag.kind, 'not_assessable');
    assert.notEqual(flag.kind, 'not_rich');
  });

  it('not_rich requires complete coverage', () => {
    const flag = richFlag(share({ figs: [valued('sw0001', 100), valued('sw0002', 100)] }), 0.5);
    assert.equal(flag.kind, 'not_rich');
  });

  it('not_rich is unreachable while any figure is unaccounted for', () => {
    const incomplete = [
      [valued('sw0001', 100), unvalued('sw0002')],
      [valued('sw0001', 100), noPrice('sw0002')],
      [valued('sw0001', 100), absent('sw0002')],
      [valued('sw0001', 100), unaddressable('fig-000001')],
    ];
    for (const figs of incomplete) {
      assert.notEqual(richFlag(share({ figs }), 0.5).kind, 'not_rich');
    }
    // …and with duplicates counted but unnamed.
    assert.notEqual(
      richFlag(share({ figs: [valued('sw0001', 100), valued('sw0002', 100)], reported: 3 }), 0.5).kind,
      'not_rich',
    );
  });

  it('a measured share exactly on the threshold is rich (lower bound inclusive)', () => {
    const flag = richFlag(share({ figs: [valued('sw0001', 500)] }), 0.5);
    assert.equal(flag.kind, 'rich');
  });
});

describe('the printed percentage and the flag can never disagree', () => {
  it('rounds down, so 49.96% never prints as 50% beside "not minifig-rich"', () => {
    const result = share({ figs: [valued('sw0001', 499.6)] });
    if (result.kind !== 'measured') throw new Error('expected measured');
    const flag = richFlag(result, 0.5);
    assert.equal(flag.kind, 'not_rich');
    assert.match(shareLines(result, flag).headline, /are 49%/);
  });

  it('agrees at the boundary across a sweep of totals', () => {
    for (let cents = 4900; cents <= 5100; cents += 1) {
      const result = share({ figs: [valued('sw0001', cents / 10)] });
      if (result.kind !== 'measured') continue;
      const flag = richFlag(result, 0.5);
      const printed = Number(/are (\d+)%/.exec(shareLines(result, flag).headline)?.[1] ?? '-1');
      if (flag.kind === 'rich') assert.ok(printed >= 50, `${cents} printed ${printed}`);
      if (flag.kind === 'not_rich') assert.ok(printed < 50, `${cents} printed ${printed}`);
    }
  });
});

describe('never divide by a guess', () => {
  it('an unvalued set yields no_denominator, and the variant carries no ratio', () => {
    const result = share({ figs: [valued('sw0001', 300)], setSealed: null, setFetchedOn: null });
    assert.equal(result.kind, 'no_denominator');
    if (result.kind !== 'no_denominator') return;
    assert.ok(!('ratio' in result));
    assert.equal(result.figTotal, 300);
    assert.equal(richFlag(result, 0.5).kind, 'not_assessable');
    // The dollar total is still useful and still shown — it is the percentage that cannot exist.
    assert.match(shareLines(result, richFlag(result, 0.5)).headline, /\$300\.00 of minifigures so far/);
  });

  it('a zero or negative sealed value yields no_denominator — no Infinity, no NaN', () => {
    for (const sealed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = share({ figs: [valued('sw0001', 300)], setSealed: sealed });
      assert.equal(result.kind, 'no_denominator', String(sealed));
      const rendered = JSON.stringify(shareLines(result, richFlag(result, 0.5)));
      assert.ok(!/Infinity|NaN/.test(rendered), String(sealed));
    }
  });

  it('no named figures yields no_numerator', () => {
    const result = minifigShare({
      roster: readRoster({ kind: 'payload', data: {} }),
      figs: [],
      setSealed: 1000,
      setFetchedOn: DAY,
      setStaleFrom: null,
    });
    assert.equal(result.kind, 'no_numerator');
    assert.equal(richFlag(result, 0.5).kind, 'not_assessable');
  });

  it('named but none valued yields no_numerator, and coverage reads 0 of N', () => {
    const result = share({ figs: [unvalued('sw0001'), unvalued('sw0002')] });
    assert.equal(result.kind, 'no_numerator');
    if (result.kind !== 'no_numerator') return;
    assert.equal(result.reason, 'no_fig_valued');
    assert.match(shareLines(result, richFlag(result, 0.5)).coverage, /0 of 2 named figures valued/);
  });
});

describe('a ratio that never held on one day says so', () => {
  it('flags mixed vintages and names both dates', () => {
    const result = share({ figs: [valued('sw0001', 600, { on: DAY })], setFetchedOn: '2026-07-01' });
    if (result.kind !== 'floor' && result.kind !== 'measured') throw new Error('expected a ratio');
    assert.equal(result.asOf.mixed, true);
    assert.equal(result.asOf.oldest, '2026-07-01');
    assert.equal(result.asOf.newest, DAY);

    const dates = shareLines(result, richFlag(result, 0.5)).dates;
    assert.ok(dates !== null);
    assert.match(dates, /never held on any one day/);
  });

  it('reports quota staleness independently of mixed dates', () => {
    const result = share({
      figs: [valued('sw0001', 600, { staleFrom: '2026-06-01' })],
      setFetchedOn: DAY,
    });
    if (result.kind !== 'floor' && result.kind !== 'measured') throw new Error('expected a ratio');
    assert.equal(result.asOf.mixed, false);
    assert.equal(result.asOf.quotaStaleFrom, '2026-06-01');
    assert.match(shareLines(result, richFlag(result, 0.5)).dates ?? '', /daily quota/);
  });

  it('says nothing about dates when every number is from the same fresh day', () => {
    const result = share({ figs: [valued('sw0001', 300), valued('sw0002', 200)] });
    if (result.kind !== 'measured') throw new Error('expected measured');
    assert.equal(shareLines(result, richFlag(result, 0.5)).dates, null);
    assert.equal(shareLines(result, richFlag(result, 0.5)).tone, 'neutral');
  });
});

describe('coverageOf — exhaustion', () => {
  it('is exhausted when no further click could help', () => {
    const figs = [valued('sw0001', 100), noPrice('sw0002'), absent('sw0003'), unaddressable('fig-000001')];
    const coverage = coverageOf(roster(figs.map((f) => f.minifigNumber)), figs);
    assert.equal(coverage.exhausted, true);
    assert.equal(coverage.asked, true);
  });

  it('is not exhausted while a figure is still unvalued', () => {
    const figs = [valued('sw0001', 100), unvalued('sw0002')];
    const coverage = coverageOf(roster(figs.map((f) => f.minifigNumber)), figs);
    assert.equal(coverage.exhausted, false);
  });
});

describe('shareThresholdFromEnv', () => {
  it('defaults to 0.50, pinned so retuning it is a deliberate edit', () => {
    assert.equal(DEFAULT_MINIFIG_SHARE_THRESHOLD, 0.5);
    assert.equal(shareThresholdFromEnv({}), 0.5);
  });

  it('reads a valid override', () => {
    assert.equal(shareThresholdFromEnv({ MINIFIG_SHARE_THRESHOLD: '0.6' }), 0.6);
    assert.equal(shareThresholdFromEnv({ MINIFIG_SHARE_THRESHOLD: '1' }), 1);
  });

  it('falls back rather than throwing on junk or out-of-range values', () => {
    for (const raw of ['', 'abc', '-0.5', '0', '1.5', '50', 'Infinity', 'NaN']) {
      assert.equal(shareThresholdFromEnv({ MINIFIG_SHARE_THRESHOLD: raw }), 0.5, raw);
    }
  });
});
