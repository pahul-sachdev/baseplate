import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BATCH_SKIP_NOTES,
  BATCH_STOP_NOTES,
  DEFAULT_MINIFIG_BATCH_MAX,
  DEFAULT_MINIFIG_GAP_MS,
  minifigBatchMaxFromEnv,
  minifigGapFromEnv,
  planMinifigBatch,
  type BatchSkipReason,
} from './minifigBatch.ts';
import type { MinifigIdKind } from './minifigNumber.ts';
import type { MinifigPreview, MinifigValue } from './minifigPreview.ts';
import type { MinifigFacts } from './minifigValuePort.ts';

const DAY = '2026-07-30';

function facts(minifigNumber: string): MinifigFacts {
  return {
    minifigNumber,
    name: null,
    description: null,
    theme: null,
    subtheme: null,
    year: null,
    releasedOn: null,
    currentValueNew: 10,
    appearsIn: null,
    priceEvents: [],
    currency: 'USD',
  };
}

function fig(id: string, state: MinifigValue, idKind: MinifigIdKind = 'brickeconomy'): MinifigPreview {
  return { minifigNumber: id, idKind, name: null, imageUrl: null, state };
}

const unvalued = (id: string, kind: MinifigIdKind = 'brickeconomy'): MinifigPreview =>
  fig(id, { kind: 'unvalued', minifigNumber: id, idKind: kind }, kind);

const valuedOn = (id: string, on: string): MinifigPreview =>
  fig(id, {
    kind: 'valued',
    minifigNumber: id,
    facts: facts(id),
    value: 10,
    fetchedOn: on,
    freshness: on === DAY ? 'fresh' : 'stale',
    provenance: { staleFrom: null },
  });

const noPrice = (id: string): MinifigPreview =>
  fig(id, {
    kind: 'no_price',
    minifigNumber: id,
    facts: facts(id),
    fetchedOn: DAY,
    freshness: 'fresh',
    provenance: { staleFrom: null },
  });

const absent = (id: string): MinifigPreview =>
  fig(id, { kind: 'absent', minifigNumber: id, status: 400, confirmedOn: DAY, attempts: 1 });

const unaddressable = (id: string): MinifigPreview =>
  fig(id, { kind: 'unaddressable', minifigNumber: id, idKind: 'rebrickable' }, 'rebrickable');

function plan(figs: MinifigPreview[], max = DEFAULT_MINIFIG_BATCH_MAX) {
  return planMinifigBatch({ figs, today: DAY, gapMs: DEFAULT_MINIFIG_GAP_MS, max });
}

function reasonFor(result: ReturnType<typeof plan>, id: string): BatchSkipReason | undefined {
  return result.skipped.find((s) => s.minifigNumber === id)?.reason;
}

describe('planMinifigBatch — the button’s number is the truth', () => {
  it('costs exactly the number of figures it will actually ask about', () => {
    const result = plan([unvalued('sw0001'), unvalued('sw0002'), unvalued('sw0003')]);
    assert.equal(result.requestCost, 3);
    assert.deepEqual([...result.askable], ['sw0001', 'sw0002', 'sw0003']);
    assert.equal(result.remaining, 0);
  });

  it('never exceeds the cap, and reports what is left for the next click', () => {
    const figs = Array.from({ length: 10 }, (_, i) => unvalued(`sw000${i}`));
    const result = plan(figs, 4);
    assert.equal(result.requestCost, 4);
    assert.equal(result.remaining, 6);
    assert.equal(reasonFor(result, 'sw0009'), 'over_cap');
  });

  it('turns Hogwarts Castle’s 24 ids into 4 requests, not 24', () => {
    // 20 part-shaped ids that would each answer HTTP 400 — a fifth of the daily allowance spent
    // learning nothing. They are excluded from bulk valuing and askable only one at a time.
    const parts = Array.from({ length: 20 }, (_, i) =>
      unvalued(`90398pb${String(15 + i).padStart(3, '0')}`, 'unclassified'),
    );
    const real = ['hp159', 'hp160', 'hp161', 'hp162'].map((id) => unvalued(id));
    const result = plan([...parts, ...real], 4);

    assert.equal(result.requestCost, 4);
    assert.deepEqual([...result.askable], ['hp159', 'hp160', 'hp161', 'hp162']);
    assert.equal(reasonFor(result, '90398pb015'), 'not_batchable');
    assert.equal(result.remaining, 0);
  });
});

describe('planMinifigBatch — what it refuses to spend on', () => {
  it('skips a figure already valued today, at zero cost', () => {
    const result = plan([valuedOn('sw0001', DAY), unvalued('sw0002')]);
    assert.equal(result.requestCost, 1);
    assert.equal(reasonFor(result, 'sw0001'), 'valued_today');
  });

  it('skips a figure valued on an earlier day — that is a Refresh, not a bulk decision', () => {
    const result = plan([valuedOn('sw0001', '2026-07-01'), unvalued('sw0002')]);
    assert.equal(result.requestCost, 1);
    assert.equal(reasonFor(result, 'sw0001'), 'valued_earlier');
  });

  it('skips a permanently absent figure, so an absence is never re-spent by a batch', () => {
    const result = plan([absent('90398pb015'), unvalued('sw0002')]);
    assert.equal(result.requestCost, 1);
    assert.equal(reasonFor(result, '90398pb015'), 'absent');
  });

  it('skips a priceless figure and an unaddressable one', () => {
    const result = plan([noPrice('sw0001'), unaddressable('fig-000001'), unvalued('sw0003')]);
    assert.equal(result.requestCost, 1);
    assert.equal(reasonFor(result, 'sw0001'), 'no_price_today');
    assert.equal(reasonFor(result, 'fig-000001'), 'unaddressable');
  });

  it('costs nothing at all when every figure is already accounted for', () => {
    const result = plan([valuedOn('sw0001', DAY), noPrice('sw0002'), absent('sw0003'), unaddressable('fig-1')]);
    assert.equal(result.requestCost, 0);
    assert.equal(result.askable.length, 0);
  });

  it('names a reason for every single skipped figure', () => {
    const figs = [valuedOn('sw0001', DAY), noPrice('sw0002'), absent('sw0003'), unaddressable('fig-1'),
      unvalued('90398pb015', 'unclassified'), ...Array.from({ length: 8 }, (_, i) => unvalued(`sw10${i}`))];
    const result = plan(figs, 4);
    const accounted = result.askable.length + result.skipped.length;
    assert.equal(accounted, figs.length);
    for (const skip of result.skipped) {
      assert.ok(BATCH_SKIP_NOTES[skip.reason].length > 0, skip.reason);
    }
  });
});

describe('planMinifigBatch — resumability', () => {
  it('a second plan over the post-batch state continues rather than restarting', () => {
    const figs = Array.from({ length: 9 }, (_, i) => unvalued(`sw000${i}`));
    const first = plan(figs, 4);
    assert.deepEqual([...first.askable], ['sw0000', 'sw0001', 'sw0002', 'sw0003']);

    // Everything the first click resolved is now on disk, so it drops out of the next plan.
    const after = figs.map((f) => (first.askable.includes(f.minifigNumber) ? valuedOn(f.minifigNumber, DAY) : f));
    const second = plan(after, 4);
    assert.deepEqual([...second.askable], ['sw0004', 'sw0005', 'sw0006', 'sw0007']);
    assert.equal(second.remaining, 1);
  });

  it('estimates the wall time from the real gap', () => {
    const result = planMinifigBatch({
      figs: Array.from({ length: 4 }, (_, i) => unvalued(`sw000${i}`)),
      today: DAY,
      gapMs: 1100,
      max: 4,
    });
    assert.equal(result.estimatedSeconds, 4);
  });

  it('handles an empty roster', () => {
    const result = plan([]);
    assert.equal(result.requestCost, 0);
    assert.equal(result.estimatedSeconds, 0);
  });
});

describe('env tunables', () => {
  it('pins the defaults, so retuning them is a deliberate edit', () => {
    // 1100ms matches the Rebrickable client. The 15500ms an earlier draft used was there to
    // respect a reported 4-requests-per-minute ceiling that measurement disproved.
    assert.equal(DEFAULT_MINIFIG_GAP_MS, 1100);
    assert.equal(DEFAULT_MINIFIG_BATCH_MAX, 4);
  });

  it('reads valid overrides', () => {
    assert.equal(minifigBatchMaxFromEnv({ MINIFIG_BATCH_MAX: '10' }), 10);
    assert.equal(minifigGapFromEnv({ BRICKECONOMY_MIN_GAP_MS: '2500' }), 2500);
  });

  it('falls back rather than throwing on junk', () => {
    for (const raw of ['', 'abc', '-3', '0', '3.5', '999999']) {
      assert.equal(minifigBatchMaxFromEnv({ MINIFIG_BATCH_MAX: raw }), 4, raw);
    }
    for (const raw of ['', 'abc', '-3', '0', '3.5', '999999999']) {
      assert.equal(minifigGapFromEnv({ BRICKECONOMY_MIN_GAP_MS: raw }), 1100, raw);
    }
  });
});

describe('BATCH_STOP_NOTES', () => {
  it('gives every stop reason words, including the two that are not errors', () => {
    for (const reason of ['user', 'quota', 'auth', 'unavailable', 'cap'] as const) {
      assert.ok(BATCH_STOP_NOTES[reason].length > 0, reason);
    }
    assert.match(BATCH_STOP_NOTES.user, /kept/);
    assert.match(BATCH_STOP_NOTES.quota, /kept/);
  });
});
