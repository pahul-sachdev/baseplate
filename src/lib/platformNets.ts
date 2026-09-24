import { STRATEGY_LABELS } from './labels.ts';
import { formatUSD, round2 } from './money.ts';
import {
  ANCHOR_PLATFORM,
  netForPlatform,
  platformsForPlay,
  type SellPlatform,
} from './platforms.ts';
import { maxBuyPrice } from './setPreview.ts';
import type { Condition, PriceBand, Strategy, Verdict } from './types.ts';
import { bandFor, MARGIN_THRESHOLD } from './verdict.ts';

/**
 * What the recommended play nets on each venue that can actually host it.
 *
 * The verdict is anchored to one platform (eBay, per ANCHOR_PLATFORM) because a BUY/PASS has to be
 * a single call, and because a fee-free cash channel would otherwise flip almost everything to BUY
 * on the strength of its fees alone. This module is the rest of the truth: the same play priced on
 * every avenue, so "PASS on eBay" does not get mistaken for "PASS".
 *
 * Two rules keep it honest, and both are driven by config data rather than by naming a platform:
 *   - Rows RANK by net dollars, but `best` is only ever a reach: 'shipped' row. A local sale keeps
 *     the whole price by giving up shipping reach and buyer protection, so it is shown, ranked and
 *     annotated — never crowned the best avenue for having no fees.
 *   - Effort is a tag and a clause, never a dollar deduction. Subtracting an invented cost of your
 *     time would put a made-up number in a column of measured ones.
 *
 * Pure and DOM-free, like the rest of src/lib.
 */

/** Names the band the figure came from, so it can never read as an asking price we invented. */
const BAND_LABELS: Readonly<Record<PriceBand, string>> = {
  sealed: 'sealed market value',
  partOut: 'part-out value',
  usedWithBox: 'used market value, with box',
  usedNoBox: 'used market value, no box',
};

interface PlatformNetBase {
  platform: SellPlatform;
  net: number;
  /** Net minus the anchor's net. Zero on the anchor row itself. */
  deltaVsAnchor: number;
  isAnchor: boolean;
}

/**
 * Discriminated on `mode` for the same reason VerdictExplanation is: without a buy price there is
 * no margin and nothing to clear, so ceiling mode has no `margin` field to render by mistake.
 */
export type PlatformNet =
  | (PlatformNetBase & { mode: 'ceiling'; ceiling: number | null })
  | (PlatformNetBase & { mode: 'verdict'; margin: number; clears: boolean });

export interface PlatformComparison {
  mode: 'ceiling' | 'verdict';
  play: Strategy;
  playLabel: string;
  condition: Condition;
  /**
   * The observed market value for this play's band, before any fee. What the market says the set
   * is worth — NOT a suggested list price. BasePlate computes no asking price, and no surface may
   * phrase this one as though it had.
   */
  marketValue: number;
  /** What that figure IS, e.g. "used market value, no box". */
  marketValueLabel: string;
  /** Descending by net. Ties keep config order. Never empty. */
  rows: PlatformNet[];
  /** The venue the verdict is anchored to. */
  anchor: PlatformNet;
  /** Highest net among shipped-reach rows. A local-cash row is never crowned on net alone. */
  best: PlatformNet;
  /** A local row that out-nets `best`, surfaced as a trade-off rather than as the winner. */
  topLocal: PlatformNet | null;
  /** True when the play has exactly one venue — part_out sells through BrickLink, not a market. */
  singleVenue: boolean;
  /** Names the best avenue and what it costs beyond fees. */
  avenueLine: string;
}

/**
 * Compares every venue that can host the recommended play.
 *
 * Returns null only when the winning play carries no score, which verdict() makes unreachable —
 * it picks `play` from the scored strategies. Handled rather than assumed, because a silent throw
 * in a render path is worse than an absent section.
 */
export function comparePlatforms({
  call,
  condition,
  buyPrice,
}: {
  call: Verdict;
  condition: Condition;
  buyPrice: number | null;
}): PlatformComparison | null {
  const scored = call.strategies.find((result) => result.strategy === call.play);
  if (scored === undefined || !scored.eligible) return null;

  const marketValue = scored.gross;
  const anchorId = ANCHOR_PLATFORM[call.play];
  const venues = platformsForPlay(call.play);

  const anchorVenue = venues.find((platform) => platform.id === anchorId);
  if (anchorVenue === undefined) {
    throw new Error(
      `Platform "${anchorId}" anchors ${call.play} but does not list it in src/lib/platforms.ts.`,
    );
  }
  const anchorNet = netForPlatform(marketValue, anchorVenue);

  const mode = buyPrice === null ? 'ceiling' : 'verdict';
  const rows: PlatformNet[] = venues.map((platform) => {
    const net = netForPlatform(marketValue, platform);
    const base: PlatformNetBase = {
      platform,
      net,
      deltaVsAnchor: round2(net - anchorNet),
      isAnchor: platform.id === anchorId,
    };

    if (buyPrice === null) return { ...base, mode: 'ceiling', ceiling: maxBuyPrice(net) };

    const margin = round2(net - buyPrice);
    // The same bar verdict() applies, read from the same constant — never a second copy of 0.25.
    return { ...base, mode: 'verdict', margin, clears: margin > buyPrice * MARGIN_THRESHOLD };
  });

  // Stable sort, so equal nets keep config order rather than shuffling per render.
  rows.sort((a, b) => b.net - a.net);

  const anchor = rows.find((row) => row.isAnchor);
  if (anchor === undefined) throw new Error(`No anchor row for ${call.play}.`);

  // Seeded with the anchor, which config and platforms.test.ts guarantee is shipped-reach. That
  // makes `best` shipped by construction, and a tie never dethrones the anchor.
  const best = rows
    .filter((row) => row.platform.reach === 'shipped')
    .reduce((leader, row) => (row.net > leader.net ? row : leader), anchor);

  const topLocalRow = rows
    .filter((row) => row.platform.reach === 'local')
    .reduce<PlatformNet | null>(
      (leader, row) => (leader === null || row.net > leader.net ? row : leader),
      null,
    );
  const topLocal = topLocalRow !== null && topLocalRow.net > best.net ? topLocalRow : null;

  const band = bandFor(call.play, condition);

  return {
    mode,
    play: call.play,
    playLabel: STRATEGY_LABELS[call.play],
    condition,
    marketValue,
    marketValueLabel: band === null ? 'market value' : BAND_LABELS[band],
    rows,
    anchor,
    best,
    topLocal,
    singleVenue: rows.length === 1,
    avenueLine: avenueLine({ playLabel: STRATEGY_LABELS[call.play], anchor, best, topLocal, rows }),
  };
}

/**
 * The sentence that names the best avenue and what it costs beyond fees.
 *
 * Composed from config data — a platform's label and its effort note — so a row added to
 * platforms.ts gets prose here without a code change. Every note is written to complete
 * "Selling there ___", which is what keeps that possible.
 */
function avenueLine({
  playLabel,
  anchor,
  best,
  topLocal,
  rows,
}: {
  playLabel: string;
  anchor: PlatformNet;
  best: PlatformNet;
  topLocal: PlatformNet | null;
  rows: readonly PlatformNet[];
}): string {
  const parts: string[] = [];

  if (rows.length === 1) {
    parts.push(
      `${playLabel} sells through ${best.platform.label} only — there is no marketplace to compare.`,
    );
  } else if (best.isAnchor) {
    parts.push(`${best.platform.label} nets the most of the avenues that ship.`);
  } else {
    parts.push(
      `${best.platform.label} nets ${formatUSD(best.net - anchor.net)} more than ${anchor.platform.label}.`,
    );
  }

  parts.push(`Selling there ${best.platform.effort.note}.`);

  if (topLocal !== null) {
    parts.push(
      `${topLocal.platform.label} would keep ${formatUSD(topLocal.net - best.net)} more, but it ${topLocal.platform.effort.note}. Against ${best.platform.label}'s reach that is a trade, not a better price.`,
    );
  }

  return parts.join(' ');
}
