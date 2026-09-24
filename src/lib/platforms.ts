import { round2 } from './money.ts';
import type { Strategy } from './types.ts';

/**
 * The sell platforms, and what each one takes.
 *
 * EDIT THIS FILE FREELY — add, remove, reorder or re-rate a platform. It is the single source of
 * truth for every net in the app: the verdict, the "ways to act" matrix and the platform strip all
 * read it, so a rate corrected here is corrected everywhere at once.
 *
 * It is NOT a live fee feed. Nothing here is fetched or verified — these are the 2026 published
 * rates, entered by hand. Check the platform's live fee schedule before changing one, and note
 * that fees.test.ts pins several of them to hand-computed values: an accidental edit fails the
 * suite rather than quietly repricing every set in the app.
 *
 * Format: one row per platform.
 *   fee     — percent of the sale, a flat per-order fixed fee, an optional floor (minFee) and an
 *             optional smaller flat fee for small orders.
 *             fee = max(total * percent + flat, minFee).
 *   plays   — which plays can ACTUALLY sell here. A real constraint, not bookkeeping: you are not
 *             meeting a stranger in a car park to hand over 3,000 loose bricks, so fb_local does
 *             not list part_out and is therefore never ranked as its fee-free winner.
 *   reach   — 'shipped' nets are comparable with each other; a 'local' net is not. A local sale
 *             keeps the whole price only by giving up shipping reach and buyer protection, so it
 *             is shown and ranked but never CROWNED the best avenue on net alone.
 *   effort  — what selling here costs you BEYOND fees. Shown as a tag beside the net, never
 *             subtracted from it: a made-up dollar cost sitting in a column of real ones is the
 *             one thing this app must not do. Rows rank by net dollars; the tag says why the top
 *             net is not free.
 */

export interface PlatformFee {
  /** Fraction of the sale price. 0.136 = 13.6%. */
  percent: number;
  /** Flat per-order fee on top of the percentage. */
  fixed: number;
  /** The fee never comes out below this. 0 for no floor. */
  minFee: number;
  /** A smaller flat fee on small orders — eBay charges $0.30 at or below $10. Null for none. */
  smallOrder: { atOrBelow: number; fixed: number } | null;
}

export interface PlatformEffort {
  /** Short chip beside the net: the work, not the money. */
  tag: string;
  /** One clause for prose, completing "…but it <note>". */
  note: string;
}

export interface SellPlatform {
  id: string;
  label: string;
  plays: readonly Strategy[];
  reach: 'shipped' | 'local';
  fee: PlatformFee;
  effort: PlatformEffort;
}

export const SELL_PLATFORMS = [
  {
    id: 'ebay',
    label: 'eBay',
    plays: ['flip_sealed', 'resell_used'],
    reach: 'shipped',
    fee: { percent: 0.136, fixed: 0.4, minFee: 0, smallOrder: { atOrBelow: 10, fixed: 0.3 } },
    effort: {
      tag: 'pack & ship',
      note: 'takes the biggest cut, but it is the deepest pool of buyers',
    },
  }, // the anchor: widest reach, highest fees
  {
    id: 'mercari',
    label: 'Mercari',
    plays: ['flip_sealed', 'resell_used'],
    reach: 'shipped',
    fee: { percent: 0.1, fixed: 0, minFee: 0, smallOrder: null },
    effort: { tag: 'pack & ship', note: 'is cheaper than eBay but a thinner pool of buyers' },
  },
  {
    id: 'fb_shipped',
    label: 'Facebook (shipped)',
    plays: ['flip_sealed', 'resell_used'],
    reach: 'shipped',
    fee: { percent: 0.05, fixed: 0, minFee: 0.4, smallOrder: null },
    effort: { tag: 'pack & ship', note: 'is cheap, but Marketplace buyers haggle and cancel' },
  },
  {
    id: 'fb_local',
    label: 'Facebook (local)',
    plays: ['flip_sealed', 'resell_used'],
    reach: 'local',
    fee: { percent: 0, fixed: 0, minFee: 0, smallOrder: null },
    effort: {
      tag: 'meet in person',
      note: 'is cash in hand: local demand only, no shipping reach, no buyer protection, and your time',
    },
  }, // 0% fees, so it tops the net — which is exactly why reach: 'local' exists
  {
    id: 'bricklink',
    label: 'BrickLink',
    plays: ['part_out'],
    reach: 'shipped',
    fee: { percent: 0.08, fixed: 0, minFee: 0, smallOrder: null },
    effort: { tag: 'sort & list lots', note: 'means sorting and listing every lot yourself' },
  }, // the ONLY part-out venue. The 8% is real; the part-out VALUE is still mock.
] as const satisfies readonly SellPlatform[];

export type PlatformId = (typeof SELL_PLATFORMS)[number]['id'];

/**
 * The venue whose net anchors the verdict, the prose and the "ways to act" matrix, per play.
 *
 * A total Record over Strategy, so a new play cannot be added without saying where it sells. This
 * is the one place the old hardcoded `netAfterFees(gross, 'ebay')` used to live.
 */
export const ANCHOR_PLATFORM: Readonly<Record<Strategy, PlatformId>> = {
  flip_sealed: 'ebay',
  part_out: 'bricklink',
  resell_used: 'ebay',
};

/**
 * The row for an id.
 *
 * Throws rather than returning undefined: a venue with no fee row cannot be netted, and quietly
 * treating it as free would publish a fabricated number. Deleting a row that ANCHOR_PLATFORM
 * still points at is a mistake, and it should be a loud one.
 */
export function platformById(id: PlatformId): SellPlatform {
  const hit = SELL_PLATFORMS.find((platform) => platform.id === id);
  if (hit === undefined) {
    throw new Error(`No platform "${id}" in src/lib/platforms.ts — a venue with no fee row cannot be netted.`);
  }
  return hit;
}

/** Every venue that can actually host a play, in config order. */
export function platformsForPlay(strategy: Strategy): SellPlatform[] {
  return SELL_PLATFORMS.filter((platform) =>
    (platform.plays as readonly Strategy[]).includes(strategy),
  );
}

/**
 * What the platform takes on a sale of `total`. Unrounded — round at the point of display, as
 * netForPlatform does, so a fee and a net never round in opposite directions.
 */
export function feeForPlatform(total: number, platform: SellPlatform): number {
  const { percent, fixed, minFee, smallOrder } = platform.fee;
  const flat = smallOrder !== null && total <= smallOrder.atOrBelow ? smallOrder.fixed : fixed;
  return Math.max(total * percent + flat, minFee);
}

/** What lands in your hand after the platform's cut, and after shipping if you are paying it. */
export function netForPlatform(total: number, platform: SellPlatform, shipCost = 0): number {
  return round2(total - feeForPlatform(total, platform) - shipCost);
}
