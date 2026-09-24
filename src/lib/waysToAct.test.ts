import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONDITIONS, type Valuation } from './types.ts';
import { NO_DATA_REASON, scoreStrategies } from './verdict.ts';
import { actMatrix } from './waysToAct.ts';

function valuation(overrides: Partial<Valuation> = {}): Valuation {
  return {
    setNumber: '75192',
    condition: 'sealed',
    sealed: 749.99,
    usedWithBox: 520,
    usedNoBox: 430,
    partOut: 812.4,
    trend: 0.042,
    fetchedAt: new Date('2026-07-28T16:00:00Z'),
    fetchedOn: '2026-07-28',
    ...overrides,
  };
}

function matrix(figures = valuation()) {
  return actMatrix(figures);
}

function keys(figures = valuation()): string[] {
  return actMatrix(figures).rows.map((row) => row.key);
}

describe('actMatrix — the 5x3 grid, deduplicated to its distinct priced cells', () => {
  it('prices exactly four plays: a sealed flip, a part-out, and both used bands', () => {
    // part_out is condition-blind and flip_sealed only ever reads the sealed band, so the fifteen
    // (condition, strategy) pairs collapse to four distinct figures.
    assert.deepEqual(keys().sort(), [
      'flip_sealed:sealed',
      'part_out:partOut',
      'resell_used:usedNoBox',
      'resell_used:usedWithBox',
    ]);
  });

  it('names the band each row assumes, so two resell rows are never both "Resell used"', () => {
    const labels = matrix().rows.map((row) => row.label);
    assert.ok(labels.includes('Resell used, with box'));
    assert.ok(labels.includes('Resell used, no box'));
    assert.ok(labels.includes('Flip sealed'));
    assert.ok(labels.includes('Part out'));
  });

  it('says which conditions can execute each play', () => {
    const rows = matrix().rows;
    const partOut = rows.find((row) => row.strategy === 'part_out');
    const noBox = rows.find((row) => row.key === 'resell_used:usedNoBox');
    assert.ok(partOut && noBox);
    assert.equal(partOut.appliesTo, 'any condition');
    assert.equal(noBox.appliesTo, 'used, no box');
  });

  it('names the venue each net is after', () => {
    const rows = matrix().rows;
    assert.equal(rows.find((row) => row.strategy === 'flip_sealed')?.venueLabel, 'eBay');
    assert.equal(rows.find((row) => row.strategy === 'part_out')?.venueLabel, 'BrickLink');
  });
});

describe('actMatrix — condition independence, the regression this exists to prevent', () => {
  it('shows BOTH used bands at once, which no single condition ever does', () => {
    // scoreStrategies('used_box') prices resell at usedWithBox and scoreStrategies('used_nobox')
    // at usedNoBox. Neither can produce both, which is exactly why the matrix is not built from it.
    const withBox = scoreStrategies(valuation(), 'used_box').find(
      (result) => result.strategy === 'resell_used',
    );
    const noBox = scoreStrategies(valuation(), 'used_nobox').find(
      (result) => result.strategy === 'resell_used',
    );
    assert.ok(withBox?.eligible && noBox?.eligible);
    assert.equal(withBox.gross, 520);
    assert.equal(noBox.gross, 430);

    const rows = matrix().rows;
    assert.equal(rows.find((row) => row.key === 'resell_used:usedWithBox')?.marketValue, 520);
    assert.equal(rows.find((row) => row.key === 'resell_used:usedNoBox')?.marketValue, 430);
  });

  it('keeps the sealed flip on the map even for a valuation labelled used', () => {
    // The stored `condition` on a row is a label, not a filter. Reading it here would reintroduce
    // the coupling the detail view just shed.
    for (const condition of CONDITIONS) {
      assert.deepEqual(keys(valuation({ condition })).sort(), keys().sort(), condition);
    }
  });

  it('produces byte-identical output whatever condition the row is filed under', () => {
    for (const condition of CONDITIONS) {
      assert.deepEqual(actMatrix(valuation({ condition })), actMatrix(valuation()));
    }
  });
});

describe('actMatrix — the numbers agree with the engine', () => {
  it('nets each row exactly as scoreStrategies nets the same play', () => {
    // The matrix and the verdict must never disagree about what a play nets; both go through
    // netForStrategy(). Pairs a row with the condition that scores it.
    const pairs = [
      { key: 'flip_sealed:sealed', condition: 'sealed', strategy: 'flip_sealed' },
      { key: 'part_out:partOut', condition: 'sealed', strategy: 'part_out' },
      { key: 'resell_used:usedWithBox', condition: 'used_box', strategy: 'resell_used' },
      { key: 'resell_used:usedNoBox', condition: 'used_nobox', strategy: 'resell_used' },
    ] as const;

    const rows = matrix().rows;
    for (const pair of pairs) {
      const scored = scoreStrategies(valuation(), pair.condition).find(
        (result) => result.strategy === pair.strategy,
      );
      const row = rows.find((entry) => entry.key === pair.key);
      assert.ok(scored?.eligible && row, pair.key);
      assert.equal(row.net, scored.net, pair.key);
      assert.equal(row.marketValue, scored.gross, pair.key);
    }
  });

  it('reports fees as the gap between market value and net', () => {
    const flip = matrix().rows.find((row) => row.key === 'flip_sealed:sealed');
    assert.ok(flip);
    // 749.99 * 0.136 = 101.99864, + 0.40 = 102.39864 -> net 647.59, so fees read 102.40
    assert.equal(flip.net, 647.59);
    assert.equal(flip.fees, 102.4);
  });

  it('ranks by net, best first', () => {
    // part_out 812.40 * 0.92 = 747.41 beats the sealed flip's 647.59 on this fixture.
    assert.deepEqual(keys(), [
      'part_out:partOut',
      'flip_sealed:sealed',
      'resell_used:usedWithBox',
      'resell_used:usedNoBox',
    ]);
    assert.equal(matrix().bestKey, 'part_out:partOut');
  });
});

describe('actMatrix — honest blanks, never a fabricated cell', () => {
  it('drops a null used band and discloses it with the engine’s own reason', () => {
    const result = actMatrix(valuation({ usedWithBox: null }));
    assert.ok(!keys(valuation({ usedWithBox: null })).includes('resell_used:usedWithBox'));

    const absent = result.absent.find((entry) => entry.key === 'resell_used:usedWithBox');
    assert.ok(absent);
    assert.equal(absent.reason, NO_DATA_REASON);
    assert.equal(absent.label, 'Resell used, with box');
  });

  it('gates each band independently — one missing does not blank the other', () => {
    const result = actMatrix(valuation({ usedNoBox: null }));
    const rowKeys = result.rows.map((row) => row.key);
    assert.ok(rowKeys.includes('resell_used:usedWithBox'));
    assert.ok(!rowKeys.includes('resell_used:usedNoBox'));
  });

  it('treats a $0.00 band as a gap in the data, not a worthless play', () => {
    // A zero band is missing data upstream. Pricing it would render "market value $0.00, net
    // -$0.30" — a fabricated row that reads as a real, terrible deal.
    const result = actMatrix(valuation({ sealed: 0 }));
    assert.ok(!result.rows.some((row) => row.key === 'flip_sealed:sealed'));
    const absent = result.absent.find((entry) => entry.key === 'flip_sealed:sealed');
    assert.ok(absent);
    assert.equal(absent.reason, 'no sealed price on file for this set');
  });

  it('never explains a missing sealed or part-out figure as a used-market gap', () => {
    // NO_DATA_REASON says "used-market data", which is only true of the two used bands.
    const result = actMatrix(valuation({ sealed: 0, partOut: 0 }));
    for (const entry of result.absent) {
      assert.doesNotMatch(entry.reason, /used-market/, entry.key);
    }
  });

  it('carries no net or market value for an absent play', () => {
    // Same discipline as StrategyResult: an unpriced play has no number to render by mistake.
    const result = actMatrix(valuation({ usedWithBox: null, usedNoBox: null }));
    for (const entry of result.absent) {
      assert.ok(!('net' in entry));
      assert.ok(!('marketValue' in entry));
    }
  });

  it('survives a set with nothing priced at all, with no bestKey', () => {
    const worthless = valuation({ sealed: 0, usedWithBox: null, usedNoBox: null, partOut: 0 });
    const result = actMatrix(worthless);
    assert.deepEqual(result.rows, []);
    assert.equal(result.bestKey, null);
    assert.equal(result.absent.length, 4);
  });
});
