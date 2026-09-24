import {
  CONDITION_ARTICLES,
  CONDITION_PHRASES,
  STRATEGY_LABELS,
  STRATEGY_VENUES,
} from './labels.ts';
import { formatUSD } from './money.ts';
import { maxBuyPrice } from './setPreview.ts';
import type { Condition, Strategy, Valuation, Verdict } from './types.ts';
import { MARGIN_THRESHOLD, verdict } from './verdict.ts';

/**
 * Why the verdict says what it says, in words.
 *
 * A BUY/PASS chip on its own asks to be trusted. This turns the same numbers into the sentence a
 * careful person would say out loud: which play won, what it nets after the venue takes its cut,
 * how that compares to the bar, and what was ruled out. The reasoning IS the product here — the
 * chip is just its headline.
 *
 * Three rules shape the type:
 *   - The result is a discriminated union on `mode`. Without a buy price there is no BUY/PASS to
 *     give — verdict() calls anything profitable a BUY when nothing was paid — so 'ceiling' mode
 *     has no `buy` field to read. Same technique as StrategyResult in ./types.ts, which gives an
 *     ineligible strategy no `net` to carry.
 *   - Reasons are never rewritten. `ruledOut` carries the exact string scoreStrategies() produced,
 *     relabelled and nothing more, so this module and the strategy table cannot drift apart.
 *   - It takes a VALUATION and scores it here, rather than accepting a pre-scored Verdict. Taking
 *     both a call and a buy price let them disagree, and they did: a card scored at a zero buy
 *     price (which is how a ceiling is computed without one) reported that price's margin and its
 *     always-true `buy` flag, so an overpriced buy rendered BUY with the full net as its margin.
 *     One scoring call, one buy price, no way to mismatch them. `call` comes back out for the
 *     strategy table, so nobody needs to score it a second time either.
 *
 * Pure and DOM-free, like the rest of src/lib.
 */

/** A play the condition or the data took off the table, with the reason already computed upstream. */
export interface RuledOutPlay {
  strategy: Strategy;
  label: string;
  /** Verbatim from scoreStrategies(). Never re-worded here. */
  reason: string;
}

interface ExplanationBase {
  /** The scored verdict this reasoning describes — hand it straight to the strategy table. */
  call: Verdict;
  /** The highest buy price that still clears the bar, or null when none does. */
  ceiling: number | null;
  /** The winning play. */
  play: Strategy;
  playLabel: string;
  net: number;
  /**
   * The condition this reasoning assumes. Every figure above is conditional on it, so the UI must
   * never render the explanation without naming it.
   */
  condition: Condition;
  /** One sentence: what to do and what it nets. */
  lead: string;
  ruledOut: RuledOutPlay[];
  /** True when the recommended play rests on mock data — drives the loud notice, not a sentence. */
  mockPlay: boolean;
}

export type VerdictExplanation =
  | (ExplanationBase & {
      mode: 'ceiling';
      ceilingLine: string;
    })
  | (ExplanationBase & {
      mode: 'verdict';
      buy: boolean;
      buyPrice: number;
      margin: number;
      /** The dollars of margin this buy price has to beat: 25% of what you pay. */
      threshold: number;
      marginLine: string;
    });

/**
 * Scores a set under one condition and explains the result.
 *
 * `buyPrice` null means "no price typed yet" and yields ceiling mode.
 */
export function explainVerdict({
  valuation,
  buyPrice,
  condition,
  mockStrategies,
}: {
  valuation: Valuation;
  buyPrice: number | null;
  condition: Condition;
  mockStrategies: readonly string[];
}): VerdictExplanation {
  // The one scoring call. `net` does not depend on the buy price, so the ceiling is the same in
  // either mode — but `margin` and `buy` very much do, which is why this cannot be hoisted out.
  const call = verdict(buyPrice ?? 0, valuation, condition);
  const ceiling = maxBuyPrice(call.net);
  const playLabel = STRATEGY_LABELS[call.play];
  const venue = STRATEGY_VENUES[call.play];
  const conditionPhrase = CONDITION_PHRASES[condition];

  const base: ExplanationBase = {
    call,
    ceiling,
    play: call.play,
    playLabel,
    net: call.net,
    condition,
    lead: `${playLabel} is the best play for ${CONDITION_ARTICLES[condition]} ${conditionPhrase} copy: ${formatUSD(
      call.net,
    )} in hand after ${venue}.`,
    ruledOut: call.strategies
      .filter((result) => !result.eligible)
      .map((result) => ({
        strategy: result.strategy,
        label: STRATEGY_LABELS[result.strategy],
        // eligible: false is the only branch with a reason; the filter above narrows it.
        reason: result.eligible ? '' : result.reason,
      })),
    mockPlay: mockStrategies.includes(call.play),
  };

  const percent = `${Math.round(MARGIN_THRESHOLD * 100)}%`;

  if (buyPrice === null) {
    return {
      ...base,
      mode: 'ceiling',
      ceilingLine:
        ceiling === null
          ? `No buy price clears the ${percent} bar — there is not enough net to leave a margin on top.`
          : `Pay under ${formatUSD(ceiling)} and the deal clears the ${percent} bar.`,
    };
  }

  const threshold = buyPrice * MARGIN_THRESHOLD;
  return {
    ...base,
    mode: 'verdict',
    buy: call.buy,
    buyPrice,
    margin: call.margin,
    threshold,
    marginLine: `A ${formatUSD(buyPrice)} buy leaves ${formatUSD(call.margin)} of margin, ${
      call.buy ? 'past' : 'short of'
    } the ${formatUSD(threshold)} it needs to clear (${percent} of what you pay).`,
  };
}
