import { feeForPlatform, netForPlatform, platformById, type PlatformId } from './platforms.ts';

/**
 * Marketplace selling fees, keyed by platform id.
 *
 * The rates themselves live in ./platforms.ts, which is the single source of truth every net in
 * the app reads. This module is the thin id-keyed adapter over it, kept because fees.test.ts pins
 * every branch to a hand-computed value: that suite passing unchanged is the proof the config
 * reproduces the published rates exactly.
 */
export function platformFee(total: number, platform: PlatformId): number {
  return feeForPlatform(total, platformById(platform));
}

export function netAfterFees(price: number, platform: PlatformId, shipCost = 0): number {
  return netForPlatform(price, platformById(platform), shipCost);
}
