import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainVerdict } from './explain.ts';
import { callsByCondition, maxBuyPrice } from './setPreview.ts';
import { CONDITIONS, type Condition, type Valuation } from './types.ts';
import { NO_DATA_REASON, verdict } from './verdict.ts';

const MOCK: readonly string[] = ['part_out'];

function valuation(overrides: Partial<Valuation> = {}): Valuation {
  return {
    setNumber: '10236-1',
    condition: 'sealed',
    sealed: 918,
    usedWithBox: 590.46,
    usedNoBox: 550,
    partOut: 301.12,
    trend: 0.0311,
    fetchedAt: new Date('2026-07-29T12:00:00Z'),
    fetchedOn: '2026-07-29',
    ...overrides,
  };
}

function explain(buyPrice: number | null, figures = valuation(), condition: Condition = 'sealed') {
  return explainVerdict({ valuation: figures, buyPrice, condition, mockStrategies: MOCK });
}

describe('explainVerdict — ceiling mode, before a price is typed', () => {
  it('gives a ceiling instead of a verdict, because there is nothing to judge yet', () => {
    const result = explain(null);
    assert.equal(result.mode, 'ceiling');
    if (result.mode !== 'ceiling') return assert.fail('expected ceiling mode');

    // The union is the point: there is no `buy` field to render as a BUY chip.
    assert.ok(!('buy' in result));
    assert.equal(result.ceiling, maxBuyPrice(verdict(0, valuation(), 'sealed').net));
    assert.match(result.ceilingLine, /Pay under \$/);
    assert.match(result.ceilingLine, /25%/);
  });

  it('says so plainly when no price could ever work', () => {
    // Nothing nets anything: no ceiling exists, and "$0.00" would read as one that does.
    const worthless = valuation({ sealed: 0, usedWithBox: null, usedNoBox: null, partOut: 0 });
    const result = explain(null, worthless);
    if (result.mode !== 'ceiling') return assert.fail('expected ceiling mode');

    assert.equal(result.ceiling, null);
    assert.match(result.ceilingLine, /No buy price clears/);
    assert.doesNotMatch(result.ceilingLine, /\$0\.00/);
  });
});

describe('explainVerdict — verdict mode, with a real buy price', () => {
  it('explains a BUY with the arithmetic behind it', () => {
    const result = explain(300);
    if (result.mode !== 'verdict') return assert.fail('expected verdict mode');

    assert.equal(result.buy, true);
    assert.equal(result.play, 'flip_sealed');
    assert.equal(result.threshold, 75);
    assert.match(result.lead, /^Flip sealed is the best play for a sealed copy/);
    assert.match(result.lead, /after eBay fees/);
    assert.match(result.marginLine, /A \$300\.00 buy leaves/);
    assert.match(result.marginLine, /past the \$75\.00/);
  });

  it('explains a PASS as falling short, not as an error', () => {
    const result = explain(900);
    if (result.mode !== 'verdict') return assert.fail('expected verdict mode');

    assert.equal(result.buy, false);
    assert.match(result.marginLine, /short of the \$225\.00/);
  });

  it('scores at the buy price it was given, never at whatever a caller scored earlier', () => {
    // The regression. callsByCondition() scores at a ZERO buy price — that is how a card shows a
    // ceiling before anyone types one — and its `margin` is therefore the whole net and its `buy`
    // is always true. Passing that call in alongside a real price rendered BUY on an overpriced
    // deal, with the full net printed as the margin. explainVerdict scores it itself now, so the
    // two can no longer disagree.
    const figures = valuation();
    const zeroPriced = callsByCondition(figures).find((entry) => entry.condition === 'sealed');
    assert.ok(zeroPriced);
    assert.equal(zeroPriced.call.buy, true); // the trap: true at any net above zero
    assert.equal(zeroPriced.call.margin, zeroPriced.call.net);

    const overpriced = explain(900, figures);
    if (overpriced.mode !== 'verdict') return assert.fail('expected verdict mode');

    assert.equal(overpriced.buy, false);
    assert.equal(overpriced.margin, verdict(900, figures, 'sealed').margin);
    assert.notEqual(overpriced.margin, overpriced.net);
    assert.ok(overpriced.margin < 0);
    assert.match(overpriced.marginLine, /leaves -\$/);
  });

  it('returns the same scored call it explained, so the table cannot disagree with the prose', () => {
    const result = explain(300);
    if (result.mode !== 'verdict') return assert.fail('expected verdict mode');

    assert.equal(result.call.play, result.play);
    assert.equal(result.call.net, result.net);
    assert.equal(result.call.margin, result.margin);
    assert.equal(result.call.buy, result.buy);
    assert.equal(result.ceiling, maxBuyPrice(result.call.net));
  });

  it('quotes the same margin the engine computed, never a recomputed one', () => {
    const call = verdict(300, valuation(), 'sealed');
    const result = explain(300);
    if (result.mode !== 'verdict') return assert.fail('expected verdict mode');

    assert.equal(result.margin, call.margin);
    assert.equal(result.net, call.net);
  });

  it('agrees with the ceiling: the ceiling buys, a cent more does not', () => {
    const ceiling = maxBuyPrice(verdict(0, valuation(), 'sealed').net);
    assert.ok(ceiling !== null);

    const at = explain(ceiling);
    const over = explain(ceiling + 0.01);
    if (at.mode !== 'verdict' || over.mode !== 'verdict') return assert.fail('expected verdict');
    assert.equal(at.buy, true);
    assert.equal(over.buy, false);
  });
});

describe('explainVerdict — what was ruled out, verbatim', () => {
  it('carries the engine’s own reason for each ineligible play', () => {
    const result = explain(300);
    const resell = result.ruledOut.find((entry) => entry.strategy === 'resell_used');
    assert.ok(resell);
    // Exactly the string ELIGIBILITY produced — relabelled, never re-worded.
    assert.equal(resell.reason, 'set is sealed; sell it sealed');
    assert.equal(resell.label, 'Resell used');
  });

  it('reports missing used data as unavailable, not as a zero-value play', () => {
    const noUsed = valuation({ usedWithBox: null, usedNoBox: null });
    const result = explain(300, noUsed, 'used_box');

    const resell = result.ruledOut.find((entry) => entry.strategy === 'resell_used');
    assert.ok(resell);
    assert.equal(resell.reason, NO_DATA_REASON);
    // And with resell gone, part-out is all that is left — which is mock.
    assert.equal(result.play, 'part_out');
    assert.equal(result.mockPlay, true);
  });

  it('lists nothing when every play is on the table', () => {
    const result = explain(300, valuation(), 'used_box');
    assert.deepEqual(
      result.ruledOut.map((entry) => entry.strategy),
      ['flip_sealed'],
    );
  });
});

describe('explainVerdict — the condition is never left implicit', () => {
  it('names the condition it assumed in the lead sentence', () => {
    assert.match(explain(300, valuation(), 'used_nobox').lead, /used, no box copy/);
    assert.match(explain(300, valuation(), 'incomplete').lead, /incomplete copy/);
    assert.match(explain(300, valuation(), 'open_box').lead, /open box, bags sealed copy/);
  });

  it('picks the right indefinite article for every condition', () => {
    // "a incomplete copy" was live before open_box arrived and made it two bugs instead of one.
    assert.match(explain(300, valuation(), 'incomplete').lead, /an incomplete copy/);
    assert.match(explain(300, valuation(), 'open_box').lead, /an open box, bags sealed copy/);
    assert.match(explain(300, valuation(), 'sealed').lead, /a sealed copy/);
    assert.match(explain(300, valuation(), 'used_box').lead, /a used, with box copy/);
  });

  it('carries the condition as data so a caller cannot forget to show it', () => {
    // Derived from CONDITIONS, not listed: a literal array here silently skipped open_box.
    for (const condition of CONDITIONS) {
      assert.equal(explain(300, valuation(), condition).condition, condition);
    }
  });
});

describe('explainVerdict — mock disclosure', () => {
  it('flags a recommendation that rests on mock data', () => {
    // part_out dominates here, and part-out is mock until BrickLink lands.
    const partOutWins = valuation({ sealed: 1, usedWithBox: null, usedNoBox: null, partOut: 5000 });
    const result = explain(300, partOutWins);
    assert.equal(result.play, 'part_out');
    assert.equal(result.mockPlay, true);
  });

  it('does not flag a play backed by real data', () => {
    assert.equal(explain(300).mockPlay, false);
  });
});
