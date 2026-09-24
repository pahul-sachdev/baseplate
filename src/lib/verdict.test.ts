import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONDITIONS, type Condition, type Strategy, type StrategyResult, type Valuation } from './types.ts';
import { NO_DATA_REASON, scoreStrategies, verdict } from './verdict.ts';

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

function eligibleStrategies(condition: Condition): Strategy[] {
  return scoreStrategies(valuation(), condition)
    .filter((s) => s.eligible)
    .map((s) => s.strategy);
}

function find(results: StrategyResult[], strategy: Strategy): StrategyResult {
  const hit = results.find((r) => r.strategy === strategy);
  assert.ok(hit, `expected a result for ${strategy}`);
  return hit;
}

describe('gating — the eligibility map, condition by condition', () => {
  it('sealed → flip_sealed + part_out', () => {
    assert.deepEqual(eligibleStrategies('sealed').sort(), ['flip_sealed', 'part_out']);
  });

  it('open_box → part_out only', () => {
    // The bags are sealed, so the parts are genuinely new and part_out is worth its full figure.
    // Nothing else is on the table: the box is open, and no open-box band exists to resell at.
    assert.deepEqual(eligibleStrategies('open_box'), ['part_out']);
  });

  it('used_box → resell_used + part_out', () => {
    assert.deepEqual(eligibleStrategies('used_box').sort(), ['part_out', 'resell_used']);
  });

  it('used_nobox → resell_used + part_out', () => {
    assert.deepEqual(eligibleStrategies('used_nobox').sort(), ['part_out', 'resell_used']);
  });

  it('incomplete → part_out only', () => {
    assert.deepEqual(eligibleStrategies('incomplete'), ['part_out']);
  });

  it('every ineligible strategy carries a reason and no score, for every condition', () => {
    for (const condition of CONDITIONS) {
      for (const result of scoreStrategies(valuation(), condition)) {
        if (result.eligible) continue;
        assert.ok(result.reason.length > 0, `${condition}/${result.strategy} needs a reason`);
        assert.ok(!('net' in result), `${condition}/${result.strategy} must not carry a net`);
        assert.ok(!('gross' in result), `${condition}/${result.strategy} must not carry a gross`);
      }
    }
  });

  it('never scores a sealed flip for a set that is not sealed', () => {
    // Derived from CONDITIONS rather than listed, so a new condition joins this automatically —
    // the literal list this replaced would have let open_box past without a word.
    for (const condition of CONDITIONS.filter((c) => c !== 'sealed')) {
      const result = find(scoreStrategies(valuation(), condition), 'flip_sealed');
      assert.equal(result.eligible, false, `${condition} must not flip sealed`);
    }
  });

  it('leaves every condition at least one play, so verdict() can never throw', () => {
    // verdict() throws outright on a condition with an empty eligible list. These two are the
    // guard for that: part_out is never null, so every condition must keep it or name a
    // replacement.
    for (const condition of CONDITIONS) {
      assert.ok(
        eligibleStrategies(condition).length > 0,
        `${condition} has no eligible strategy`,
      );
      assert.doesNotThrow(() => verdict(100, valuation(), condition), `${condition} threw`);
    }
  });
});

describe('scoring', () => {
  it('flip_sealed nets the sealed value through eBay fees', () => {
    // 749.99 - (749.99 * 0.136 + 0.40) = 647.59
    const result = find(scoreStrategies(valuation(), 'sealed'), 'flip_sealed');
    assert.equal(result.eligible && result.net, 647.59);
  });

  it('part_out takes BrickLink’s 8% and no eBay fee', () => {
    // 812.40 * 0.92 = 747.408 -> 747.41
    const result = find(scoreStrategies(valuation(), 'sealed'), 'part_out');
    assert.equal(result.eligible && result.net, 747.41);
  });

  it('resell_used reads usedWithBox for used_box', () => {
    // 520 - (520 * 0.136 + 0.40) = 448.88
    const result = find(scoreStrategies(valuation(), 'used_box'), 'resell_used');
    assert.equal(result.eligible && result.gross, 520);
    assert.equal(result.eligible && result.net, 448.88);
  });

  it('resell_used reads usedNoBox for used_nobox', () => {
    // 430 - (430 * 0.136 + 0.40) = 371.12
    const result = find(scoreStrategies(valuation(), 'used_nobox'), 'resell_used');
    assert.equal(result.eligible && result.gross, 430);
    assert.equal(result.eligible && result.net, 371.12);
  });

  it('never prices an open box off the used-with-box band', () => {
    // The band ternary this replaced sent every non-used_nobox condition to usedWithBox. Had
    // open_box reached it, an open box would have quietly been quoted at a used set's price.
    const result = find(scoreStrategies(valuation(), 'open_box'), 'resell_used');
    assert.equal(result.eligible, false);
    assert.ok(!result.eligible && result.reason.includes('open-box'));
  });

  it('parts an open box out at the full figure — the bags were never opened', () => {
    // Identical to the sealed part_out: 812.40 * 0.92 = 747.41. No open-box discount is applied,
    // because there is nothing about an opened outer box that devalues the parts inside it.
    const sealedPartOut = find(scoreStrategies(valuation(), 'sealed'), 'part_out');
    const openPartOut = find(scoreStrategies(valuation(), 'open_box'), 'part_out');
    assert.equal(openPartOut.eligible && openPartOut.net, 747.41);
    assert.equal(
      openPartOut.eligible && openPartOut.net,
      sealedPartOut.eligible && sealedPartOut.net,
    );
  });
});

describe('best play', () => {
  it('picks part_out when it out-nets the sealed flip', () => {
    const result = verdict(120, valuation(), 'sealed');
    assert.equal(result.play, 'part_out');
    assert.equal(result.net, 747.41);
  });

  it('picks flip_sealed when parting out is weak', () => {
    const result = verdict(120, valuation({ partOut: 500 }), 'sealed');
    assert.equal(result.play, 'flip_sealed');
    assert.equal(result.net, 647.59);
  });

  it('picks the only eligible strategy for an incomplete set', () => {
    const result = verdict(40, valuation(), 'incomplete');
    assert.equal(result.play, 'part_out');
  });

  it('reports every strategy, scored or not', () => {
    const result = verdict(120, valuation(), 'used_box');
    assert.equal(result.strategies.length, 3);
  });
});

describe('data gating — no used-market data', () => {
  const noUsedData = valuation({ usedWithBox: null, usedNoBox: null });

  it('makes resell_used unavailable for used_box instead of scoring a guess', () => {
    const result = find(scoreStrategies(noUsedData, 'used_box'), 'resell_used');
    assert.equal(result.eligible, false);
    assert.equal(result.eligible === false && result.reason, NO_DATA_REASON);
  });

  it('makes resell_used unavailable for used_nobox', () => {
    const result = find(scoreStrategies(noUsedData, 'used_nobox'), 'resell_used');
    assert.equal(result.eligible, false);
  });

  it('carries no net or gross for the unpriceable strategy', () => {
    const result = find(scoreStrategies(noUsedData, 'used_box'), 'resell_used');
    assert.ok(!('net' in result));
    assert.ok(!('gross' in result));
  });

  it('gates each band independently — no-box missing does not block with-box', () => {
    const partial = valuation({ usedNoBox: null });
    assert.equal(find(scoreStrategies(partial, 'used_box'), 'resell_used').eligible, true);
    assert.equal(find(scoreStrategies(partial, 'used_nobox'), 'resell_used').eligible, false);
  });

  it('still returns a verdict, falling through to part_out', () => {
    const result = verdict(120, noUsedData, 'used_box');
    assert.equal(result.play, 'part_out');
    assert.equal(result.buy, true);
  });

  it('leaves sealed sets completely unaffected', () => {
    const result = verdict(120, noUsedData, 'sealed');
    assert.equal(find(result.strategies, 'flip_sealed').eligible, true);
    assert.equal(result.net, 747.41);
  });
});

describe('margin and the buy threshold', () => {
  it('margin is dollar profit over the buy price', () => {
    const result = verdict(120, valuation(), 'sealed');
    assert.equal(result.margin, 747.41 - 120);
    assert.equal(result.buy, true);
  });

  it('is false when margin is exactly 25% of the buy price (strictly greater)', () => {
    // 135.87 * 0.92 = 125.0004 -> net 125.00; margin 25.00; threshold 100 * 0.25 = 25.00
    const result = verdict(100, valuation({ partOut: 135.87 }), 'incomplete');
    assert.equal(result.net, 125);
    assert.equal(result.margin, 25);
    assert.equal(result.buy, false);
  });

  it('is true one cent above the threshold', () => {
    // 135.88 * 0.92 = 125.0096 -> net 125.01; margin 25.01 > 25.00
    const result = verdict(100, valuation({ partOut: 135.88 }), 'incomplete');
    assert.equal(result.margin, 25.01);
    assert.equal(result.buy, true);
  });

  it('goes negative, and passes, on an overpriced buy', () => {
    const result = verdict(5000, valuation(), 'sealed');
    assert.ok(result.margin < 0);
    assert.equal(result.buy, false);
  });
});
