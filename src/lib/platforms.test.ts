import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { round2 } from './money.ts';
import {
  ANCHOR_PLATFORM,
  feeForPlatform,
  netForPlatform,
  platformById,
  platformsForPlay,
  SELL_PLATFORMS,
  type PlatformId,
} from './platforms.ts';
import { STRATEGIES, type Strategy } from './types.ts';

/**
 * fees.test.ts already pins every published rate to a hand-computed value through platformFee(),
 * which now delegates here — that suite passing unchanged IS the parity proof for the four
 * marketplaces. This file covers what it cannot: the config's own invariants, and BrickLink, which
 * never went through platformFee() before.
 */

describe('BrickLink — the 8% fee reproduces the old 0.92 multiplier', () => {
  const bricklink = platformById('bricklink');

  it('nets a part-out identically to the multiplier it replaced', () => {
    // The three figures verdict.test.ts pins. 812.40 * 0.92 = 747.408 -> 747.41
    assert.equal(netForPlatform(812.4, bricklink), 747.41);
    // 135.87 * 0.92 = 125.0004 -> 125.00, the exact-threshold case
    assert.equal(netForPlatform(135.87, bricklink), 125);
    // 135.88 * 0.92 = 125.0096 -> 125.01, one cent past it
    assert.equal(netForPlatform(135.88, bricklink), 125.01);
  });

  it('agrees with the multiplier across the whole realistic range', () => {
    // Exhaustive to the cent from $0 to $5000. The refactor moved part-out's cut from a bare
    // `gross * 0.92` into a fee row; anything but exact agreement would silently reprice sets.
    for (let cents = 0; cents <= 500_000; cents += 1) {
      const total = cents / 100;
      if (round2(total * 0.92) !== netForPlatform(total, bricklink)) {
        assert.fail(`diverged at $${total}`);
      }
    }
  });

  it('charges no fixed fee, so a small lot is not eaten by one', () => {
    // 1 * 0.08 = 0.08
    assert.equal(round2(feeForPlatform(1, bricklink)), 0.08);
  });
});

describe('the config is total — every play can be priced and anchored', () => {
  it('gives every strategy at least one venue that can host it', () => {
    // Derived from STRATEGIES, so a play added later cannot ship without a venue.
    for (const strategy of STRATEGIES) {
      assert.ok(platformsForPlay(strategy).length > 0, `${strategy} has nowhere to sell`);
    }
  });

  it('anchors every strategy to a platform that exists and lists it', () => {
    for (const strategy of STRATEGIES) {
      const anchor = platformById(ANCHOR_PLATFORM[strategy]);
      assert.ok(
        (anchor.plays as readonly Strategy[]).includes(strategy),
        `${anchor.id} anchors ${strategy} but does not list it`,
      );
    }
  });

  it('anchors every strategy to a SHIPPED venue', () => {
    // comparePlatforms() seeds its "best" reduce with the anchor row to guarantee the winner is
    // shipped-reach. A local anchor would quietly break that guarantee.
    for (const strategy of STRATEGIES) {
      assert.equal(platformById(ANCHOR_PLATFORM[strategy]).reach, 'shipped', `${strategy}`);
    }
  });

  it('leaves every strategy a shipped avenue to crown', () => {
    for (const strategy of STRATEGIES) {
      const shipped = platformsForPlay(strategy).filter((p) => p.reach === 'shipped');
      assert.ok(shipped.length > 0, `${strategy} has only local venues`);
    }
  });

  it('gives every platform a non-empty effort tag and note', () => {
    // The tag is the whole reason a 0%-fee row does not read as a free win.
    for (const platform of SELL_PLATFORMS) {
      assert.ok(platform.effort.tag.length > 0, `${platform.id} has no effort tag`);
      assert.ok(platform.effort.note.length > 0, `${platform.id} has no effort note`);
    }
  });
});

describe('channel availability — a venue only hosts what it can actually sell', () => {
  it('keeps Facebook local away from part-out', () => {
    // You are not meeting a stranger in a car park to hand over 3,000 loose bricks. Without this,
    // fb_local's 0% fees would make it the top-netting "avenue" for every part-out.
    const locals = platformsForPlay('part_out').filter((platform) => platform.id === 'fb_local');
    assert.deepEqual(locals, []);
  });

  it('sells a part-out through BrickLink and nothing else', () => {
    assert.deepEqual(
      platformsForPlay('part_out').map((platform) => platform.id),
      ['bricklink'],
    );
  });

  it('keeps BrickLink out of the marketplace plays', () => {
    for (const strategy of ['flip_sealed', 'resell_used'] as const) {
      const ids = platformsForPlay(strategy).map((platform) => platform.id);
      assert.ok(!ids.includes('bricklink'), `bricklink should not host ${strategy}`);
    }
  });

  it('offers all four marketplaces for a sealed flip and a used resale', () => {
    for (const strategy of ['flip_sealed', 'resell_used'] as const) {
      assert.deepEqual(platformsForPlay(strategy).map((platform) => platform.id), [
        'ebay',
        'mercari',
        'fb_shipped',
        'fb_local',
      ]);
    }
  });
});

describe('platformById — a missing venue is loud, never free', () => {
  it('throws rather than returning undefined', () => {
    // A venue with no fee row cannot be netted. Returning undefined would net the full gross,
    // publishing a fabricated number — the one thing this app must never do.
    assert.throws(() => platformById('etsy' as PlatformId), /src\/lib\/platforms\.ts/);
  });

  it('round-trips every configured id', () => {
    for (const platform of SELL_PLATFORMS) {
      assert.equal(platformById(platform.id).label, platform.label);
    }
  });
});

describe('fee shape — the declarative fields reproduce each real schedule', () => {
  it('applies eBay’s small-order fixed fee at exactly $10 and the full one a cent above', () => {
    const ebay = platformById('ebay');
    // 10 * 0.136 = 1.36, + 0.30 (smallOrder binds at <= 10) = 1.66
    assert.equal(round2(feeForPlatform(10, ebay)), 1.66);
    // 10.01 * 0.136 = 1.36136, + 0.40 = 1.76136
    assert.equal(round2(feeForPlatform(10.01, ebay)), 1.76);
  });

  it('floors Facebook shipped at $0.40 below the $8 crossover', () => {
    const fb = platformById('fb_shipped');
    // 5 * 0.05 = 0.25, floored to 0.40
    assert.equal(round2(feeForPlatform(5, fb)), 0.4);
    // 8 * 0.05 = 0.40 — both sides of the floor are equal here
    assert.equal(round2(feeForPlatform(8, fb)), 0.4);
    // 100 * 0.05 = 5.00, above the floor
    assert.equal(round2(feeForPlatform(100, fb)), 5);
  });

  it('takes nothing at all on a local cash sale', () => {
    const local = platformById('fb_local');
    assert.equal(feeForPlatform(1000, local), 0);
    assert.equal(netForPlatform(1000, local), 1000);
  });

  it('subtracts shipping on top of the platform cut', () => {
    // fee = 100 * 0.136 + 0.40 = 14.00; 100 - 14 - 12 = 74
    assert.equal(netForPlatform(100, platformById('ebay'), 12), 74);
  });
});
