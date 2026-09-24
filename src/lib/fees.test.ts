import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { netAfterFees, platformFee } from './fees.ts';
import { round2 } from './money.ts';

describe('platformFee — eBay', () => {
  it('applies the $0.30 fixed fee at exactly $10 (the branch is `> 10`)', () => {
    // 10 * 0.136 = 1.36, + 0.30 = 1.66
    assert.equal(round2(platformFee(10, 'ebay')), 1.66);
  });

  it('applies the $0.40 fixed fee one cent above the boundary', () => {
    // 10.01 * 0.136 = 1.36136, + 0.40 = 1.76136
    assert.equal(round2(platformFee(10.01, 'ebay')), 1.76);
  });

  it('computes a typical sealed-set fee', () => {
    // 749.99 * 0.136 = 101.99864, + 0.40 = 102.39864
    assert.equal(round2(platformFee(749.99, 'ebay')), 102.4);
    assert.equal(netAfterFees(749.99, 'ebay'), 647.59);
  });
});

describe('platformFee — Mercari', () => {
  it('is a flat 10% with no fixed component', () => {
    assert.equal(round2(platformFee(100, 'mercari')), 10);
    assert.equal(round2(platformFee(9, 'mercari')), 0.9);
    assert.equal(netAfterFees(100, 'mercari'), 90);
  });
});

describe('platformFee — Facebook', () => {
  it('shipped: takes the $0.40 floor below the $8 crossover', () => {
    // 5 * 0.05 = 0.25, floored to 0.40
    assert.equal(round2(platformFee(5, 'fb_shipped')), 0.4);
  });

  it('shipped: both sides of the max are equal at exactly $8', () => {
    // 8 * 0.05 = 0.40 === the floor
    assert.equal(round2(platformFee(8, 'fb_shipped')), 0.4);
  });

  it('shipped: takes the 5% rate above the crossover', () => {
    assert.equal(round2(platformFee(100, 'fb_shipped')), 5);
    assert.equal(netAfterFees(100, 'fb_shipped'), 95);
  });

  it('local: always zero', () => {
    assert.equal(platformFee(0, 'fb_local'), 0);
    assert.equal(platformFee(1000, 'fb_local'), 0);
    assert.equal(netAfterFees(1000, 'fb_local'), 1000);
  });
});

describe('netAfterFees', () => {
  it('subtracts shipping on top of the platform fee', () => {
    // fee = 100 * 0.136 + 0.40 = 14.00; 100 - 14 - 12 = 74
    assert.equal(netAfterFees(100, 'ebay', 12), 74);
  });

  it('defaults shipCost to zero', () => {
    assert.equal(netAfterFees(100, 'ebay'), netAfterFees(100, 'ebay', 0));
  });

  it('can go negative when shipping exceeds the take', () => {
    assert.equal(netAfterFees(10, 'ebay', 20), -11.66);
  });
});
