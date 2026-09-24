import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { comparePlatforms } from './platformNets.ts';
import { maxBuyPrice } from './setPreview.ts';
import type { Condition, Valuation } from './types.ts';
import { verdict } from './verdict.ts';

/**
 * The fixture is tuned so resell_used wins at used_nobox with a market value of $625 — the worked
 * example the feature was specified against. partOut is deliberately tiny so it cannot take the
 * play away from resell_used.
 */
function valuation(overrides: Partial<Valuation> = {}): Valuation {
  return {
    setNumber: '10236-1',
    condition: 'sealed',
    sealed: 900,
    usedWithBox: 700,
    usedNoBox: 625,
    partOut: 100,
    trend: 0.031,
    fetchedAt: new Date('2026-07-29T12:00:00Z'),
    fetchedOn: '2026-07-29',
    ...overrides,
  };
}

function compare(buyPrice: number | null, figures = valuation(), condition: Condition = 'used_nobox') {
  const result = comparePlatforms({
    call: verdict(buyPrice ?? 0, figures, condition),
    condition,
    buyPrice,
  });
  assert.ok(result, 'expected a comparison');
  return result;
}

function netOf(result: ReturnType<typeof compare>, id: string): number {
  const row = result.rows.find((entry) => entry.platform.id === id);
  assert.ok(row, `expected a ${id} row`);
  return row.net;
}

describe('comparePlatforms — the same play priced on every venue that can host it', () => {
  it('nets a $625 used resale on all four marketplaces', () => {
    const result = compare(500);
    assert.equal(result.play, 'resell_used');
    assert.equal(result.marketValue, 625);

    // eBay:       625 * 0.136 = 85.00, + 0.40 = 85.40 -> 539.60
    assert.equal(netOf(result, 'ebay'), 539.6);
    // Mercari:    625 * 0.10  = 62.50            -> 562.50
    assert.equal(netOf(result, 'mercari'), 562.5);
    // FB shipped: 625 * 0.05  = 31.25            -> 593.75
    assert.equal(netOf(result, 'fb_shipped'), 593.75);
    // FB local:   no fee at all                  -> 625.00
    assert.equal(netOf(result, 'fb_local'), 625);
  });

  it('ranks by net dollars, best first', () => {
    assert.deepEqual(
      compare(500).rows.map((row) => row.platform.id),
      ['fb_local', 'fb_shipped', 'mercari', 'ebay'],
    );
  });

  it('anchors on eBay with a zero delta, and measures every other row against it', () => {
    const result = compare(500);
    assert.equal(result.anchor.platform.id, 'ebay');
    assert.equal(result.anchor.deltaVsAnchor, 0);

    const deltas = new Map(result.rows.map((row) => [row.platform.id, row.deltaVsAnchor]));
    // 562.50 - 539.60 = 22.90; 593.75 - 539.60 = 54.15; 625.00 - 539.60 = 85.40
    assert.equal(deltas.get('mercari'), 22.9);
    assert.equal(deltas.get('fb_shipped'), 54.15);
    assert.equal(deltas.get('fb_local'), 85.4);
  });

  it('names the band the market value came from, never a price we invented', () => {
    assert.equal(compare(500).marketValueLabel, 'used market value, no box');
    assert.equal(compare(500, valuation(), 'sealed').marketValueLabel, 'sealed market value');
  });
});

describe('comparePlatforms — a fee-free local sale is never crowned on net alone', () => {
  it('leaves the crown with the best SHIPPED avenue even though local nets most', () => {
    const result = compare(500);
    // fb_local tops the ranking at $625.00 — and is still not `best`.
    assert.equal(result.rows[0]?.platform.id, 'fb_local');
    assert.equal(result.best.platform.id, 'fb_shipped');
    assert.equal(result.best.platform.reach, 'shipped');
  });

  it('surfaces the local row as a trade-off instead', () => {
    const result = compare(500);
    assert.equal(result.topLocal?.platform.id, 'fb_local');
    // 625.00 - 593.75 = 31.25 more than the crowned avenue
    assert.match(result.avenueLine, /Facebook \(local\) would keep \$31\.25 more/);
    assert.match(result.avenueLine, /a trade, not a better price/);
  });

  it('spells out what the local sale actually costs, beyond fees', () => {
    assert.match(compare(500).avenueLine, /local demand only, no shipping reach/);
    assert.match(compare(500).avenueLine, /no buyer protection, and your time/);
  });

  it('leaves topLocal null when no local row beats the crowned avenue', () => {
    // A part-out has no local venue at all, so there is nothing to trade off against.
    const result = compare(500, valuation({ partOut: 5000 }));
    assert.equal(result.play, 'part_out');
    assert.equal(result.topLocal, null);
  });

  it('never subtracts an invented cost of your time from any net', () => {
    // Effort is a tag and a clause. The moment it becomes dollars, a made-up number is sitting in
    // a column of measured ones.
    const result = compare(500);
    assert.equal(netOf(result, 'fb_local'), result.marketValue);
    for (const row of result.rows) {
      assert.ok(row.platform.effort.tag.length > 0, row.platform.id);
    }
  });
});

describe('comparePlatforms — the market value is never a pricing recommendation', () => {
  it('says "suggested" nowhere, in any mode or play', () => {
    // The brief's worked example called this a "suggested resale". It is the observed market
    // value; BasePlate computes no asking price and must not imply that it has.
    const samples = [
      compare(500),
      compare(null),
      compare(500, valuation({ partOut: 5000 })),
      compare(500, valuation(), 'sealed'),
      compare(500, valuation({ usedNoBox: null }), 'used_nobox'),
    ];
    for (const result of samples) {
      assert.doesNotMatch(result.avenueLine, /suggest/i);
      assert.doesNotMatch(result.marketValueLabel, /suggest/i);
      assert.match(result.marketValueLabel, /value/);
    }
  });
});

describe('comparePlatforms — the buy threshold, per avenue', () => {
  it('clears only where margin beats 25% of the buy price, strictly', () => {
    const result = compare(500);
    const clears = new Map(
      result.rows.map((row) => [row.platform.id, row.mode === 'verdict' && row.clears]),
    );
    // Threshold is 500 * 0.25 = 125.00.
    // eBay 539.60 - 500 = 39.60; Mercari 62.50; FB shipped 93.75 — all short.
    assert.equal(clears.get('ebay'), false);
    assert.equal(clears.get('mercari'), false);
    assert.equal(clears.get('fb_shipped'), false);
    // FB local 625.00 - 500 = 125.00, exactly the bar. The test is `>`, so it does NOT clear.
    assert.equal(clears.get('fb_local'), false);
  });

  it('clears one cent below that buy price, where the margin edges past the bar', () => {
    // At 499.99 the bar is 124.9975 and FB local's margin is 125.01 — past it.
    const result = compare(499.99);
    const local = result.rows.find((row) => row.platform.id === 'fb_local');
    assert.ok(local && local.mode === 'verdict');
    assert.equal(local.margin, 125.01);
    assert.equal(local.clears, true);
  });

  it('clears everywhere on a cheap enough buy', () => {
    const result = compare(300);
    for (const row of result.rows) {
      assert.ok(row.mode === 'verdict' && row.clears, row.platform.id);
    }
  });
});

describe('comparePlatforms — ceiling mode, before a price is typed', () => {
  it('gives each avenue its own ceiling and no margin to render', () => {
    const result = compare(null);
    assert.equal(result.mode, 'ceiling');
    for (const row of result.rows) {
      assert.equal(row.mode, 'ceiling');
      // The union is the point: there is no margin field to mistake for a real one.
      assert.ok(!('margin' in row));
      assert.ok(!('clears' in row));
      if (row.mode !== 'ceiling') return assert.fail('expected ceiling mode');
      assert.equal(row.ceiling, maxBuyPrice(row.net));
    }
  });

  it('gives a higher ceiling to the avenue that keeps more', () => {
    const result = compare(null);
    const local = result.rows.find((row) => row.platform.id === 'fb_local');
    const ebay = result.rows.find((row) => row.platform.id === 'ebay');
    assert.ok(local?.mode === 'ceiling' && ebay?.mode === 'ceiling');
    assert.ok(local.ceiling !== null && ebay.ceiling !== null);
    assert.ok(local.ceiling > ebay.ceiling);
  });
});

describe('comparePlatforms — a play with one venue', () => {
  it('collapses a part-out to BrickLink and says there is nothing to compare', () => {
    const result = compare(500, valuation({ partOut: 5000 }));
    assert.equal(result.play, 'part_out');
    assert.equal(result.singleVenue, true);
    assert.deepEqual(result.rows.map((row) => row.platform.id), ['bricklink']);
    assert.match(result.avenueLine, /sells through BrickLink only/);
    assert.match(result.avenueLine, /no marketplace to compare/);
  });

  it('names the real work a part-out costs', () => {
    const result = compare(500, valuation({ partOut: 5000 }));
    assert.match(result.avenueLine, /sorting and listing every lot yourself/);
  });

  it('nets the part-out through BrickLink’s cut, not a marketplace fee', () => {
    // 5000 * 0.92 = 4600
    const result = compare(500, valuation({ partOut: 5000 }));
    assert.equal(result.rows[0]?.net, 4600);
  });
});

describe('comparePlatforms — driven by the config, not by code', () => {
  it('offers exactly the venues platforms.ts lists for the play', () => {
    // Adding a row to src/lib/platforms.ts is the whole way to add an avenue; this pins that the
    // strip is read off the config rather than a hand-written list.
    assert.deepEqual(compare(500).rows.map((row) => row.platform.id).sort(), [
      'ebay',
      'fb_local',
      'fb_shipped',
      'mercari',
    ]);
  });

  it('builds its prose from the winning platform’s own label and effort note', () => {
    const result = compare(500);
    assert.match(result.avenueLine, new RegExp(result.best.platform.label.replace(/[()]/g, '\\$&')));
    assert.match(result.avenueLine, /Selling there /);
  });
});
