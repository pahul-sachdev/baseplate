import { round2 } from './money.ts';
import { ANCHOR_PLATFORM, netForPlatform, platformById } from './platforms.ts';
import {
  STRATEGIES,
  type Condition,
  type PriceBand,
  type Strategy,
  type StrategyResult,
  type Valuation,
  type Verdict,
} from './types.ts';

/**
 * A deal must clear 25% of the buy price to be worth doing.
 *
 * Exported so the preview card's "buy under $X" ceiling is derived from this number rather than
 * from a second copy of it — the two can never disagree about where the bar sits.
 */
export const MARGIN_THRESHOLD = 0.25;

interface ConditionRules {
  /** Strategies physically possible for this condition. Never empty. */
  readonly eligible: readonly Strategy[];
  /** Why each of the others is off the table. */
  readonly reasons: Readonly<Partial<Record<Strategy, string>>>;
}

/**
 * The gating map. A strategy not listed in `eligible` is never scored — it reports N/A
 * with its reason, and the StrategyResult union gives it no `net` field to carry.
 */
export const ELIGIBILITY: Readonly<Record<Condition, ConditionRules>> = {
  sealed: {
    eligible: ['flip_sealed', 'part_out'],
    reasons: { resell_used: 'set is sealed; sell it sealed' },
  },
  /**
   * An opened box whose inner bags are still sealed.
   *
   * part_out at FULL value is the honest read: the bags have never been opened, so the parts are
   * genuinely new and worth the full part-out figure. Both other plays are off the table, and for
   * different reasons — flip_sealed because scoring it would read valuation.sealed and quote a
   * sealed price for a box that is open, and resell_used because BrickEconomy publishes no
   * open-box band. Pricing it off used-with-box was considered and rejected: an open box with
   * sealed bags is not a used set, and deriving the number would be inventing it.
   */
  open_box: {
    eligible: ['part_out'],
    reasons: {
      flip_sealed: 'the box is open; it cannot be sold as sealed',
      resell_used: 'no open-box market data — an open box is not priced as used',
    },
  },
  used_box: {
    eligible: ['resell_used', 'part_out'],
    reasons: { flip_sealed: 'set is not sealed' },
  },
  used_nobox: {
    eligible: ['resell_used', 'part_out'],
    reasons: { flip_sealed: 'set is not sealed' },
  },
  incomplete: {
    eligible: ['part_out'],
    reasons: {
      flip_sealed: 'set is not sealed',
      resell_used: "incomplete set won't sell assembled",
    },
  },
};

export function isEligible(strategy: Strategy, condition: Condition): boolean {
  return ELIGIBILITY[condition].eligible.includes(strategy);
}

/**
 * Which observed band prices an assembled resale, per condition. Null means no band applies.
 *
 * A total Record over Condition rather than the ternary this replaces. The ternary read
 * `condition === 'used_nobox' ? usedNoBox : usedWithBox`, and its switch is exhaustive over
 * Strategy, not Condition — so every condition added after it silently priced off usedWithBox
 * with no compile error and no comment saying so. Now a new condition cannot be added without
 * stating, here, which band it sells at or that it has none.
 */
export const RESELL_BAND: Readonly<Record<Condition, 'usedWithBox' | 'usedNoBox' | null>> = {
  sealed: null,
  // No open-box band exists upstream, and used-with-box is not a stand-in for one.
  open_box: null,
  used_box: 'usedWithBox',
  // A no-box set is worth its no-box value; the other resellable condition has its box.
  used_nobox: 'usedNoBox',
  incomplete: null,
};

/**
 * Which band on a Valuation prices a play under a condition, or null when none does.
 *
 * Exported because ./waysToAct.ts has to ask exactly this question to build the
 * condition-independent opportunity map, and a second copy of the mapping is how a play ends up
 * quoted off the wrong band. flip_sealed and part_out ignore the condition entirely — the gating
 * in ELIGIBILITY has already decided whether they may be scored at all.
 */
export function bandFor(strategy: Strategy, condition: Condition): PriceBand | null {
  switch (strategy) {
    case 'flip_sealed':
      return 'sealed';
    case 'part_out':
      return 'partOut';
    case 'resell_used':
      return RESELL_BAND[condition];
    default: {
      const exhaustive: never = strategy;
      throw new Error(`Unhandled strategy: ${String(exhaustive)}`);
    }
  }
}

/**
 * The gross a strategy realises before fees, or null when the data needed to price it does
 * not exist. Null is not zero: it makes the strategy unavailable rather than worthless.
 */
function grossFor(strategy: Strategy, valuation: Valuation, condition: Condition): number | null {
  const band = bandFor(strategy, condition);
  return band === null ? null : valuation[band];
}

/**
 * The net a strategy realises after the fees of the venue it sells through.
 *
 * Both the venue and its rate come from ./platforms.ts. This used to hardcode eBay for the two
 * marketplace plays and a bare 0.92 multiplier for part-out; those two numbers are now config
 * rows, so correcting a rate corrects the verdict, the matrix and the platform strip at once.
 *
 * Exported so ./waysToAct.ts nets its rows through this exact function rather than a second copy
 * of the same lookup — the matrix and the verdict must never disagree about what a play nets.
 */
export function netForStrategy(strategy: Strategy, gross: number): number {
  return netForPlatform(gross, platformById(ANCHOR_PLATFORM[strategy]));
}

type ScoredStrategy = Extract<StrategyResult, { eligible: true }>;

function isScored(result: StrategyResult): result is ScoredStrategy {
  return result.eligible;
}

/** Shown when the condition allows a strategy but the market data to price it is missing. */
export const NO_DATA_REASON = 'no used-market data for this set';

/**
 * Scores every strategy for a condition, in a stable order, eligible or not.
 *
 * Two independent gates: the condition must physically allow the strategy, and the data
 * needed to price it must exist. Failing either yields N/A with a reason — the union gives
 * an unscored strategy no `net` field to carry.
 */
export function scoreStrategies(valuation: Valuation, condition: Condition): StrategyResult[] {
  return STRATEGIES.map((strategy): StrategyResult => {
    if (!isEligible(strategy, condition)) {
      return {
        strategy,
        eligible: false,
        reason: ELIGIBILITY[condition].reasons[strategy] ?? 'not available for this condition',
      };
    }

    const rawGross = grossFor(strategy, valuation, condition);
    if (rawGross === null) {
      return { strategy, eligible: false, reason: NO_DATA_REASON };
    }

    const gross = round2(rawGross);
    return { strategy, eligible: true, gross, net: netForStrategy(strategy, gross) };
  });
}

/**
 * Picks the best-netting eligible strategy and decides whether the deal clears the bar.
 * Pure: no clock, no I/O.
 */
export function verdict(buyPrice: number, valuation: Valuation, condition: Condition): Verdict {
  const strategies = scoreStrategies(valuation, condition);
  const scored = strategies.filter(isScored);

  // Every condition lists part_out, and partOut is never null, so this cannot be empty.
  const best = scored.reduce<ScoredStrategy | null>(
    (a, b) => (a === null || b.net > a.net ? b : a),
    null,
  );
  if (best === null) {
    throw new Error(`No eligible strategy for condition "${condition}"`);
  }

  const margin = round2(best.net - buyPrice);
  return {
    play: best.strategy,
    net: best.net,
    margin,
    buy: margin > buyPrice * MARGIN_THRESHOLD,
    strategies,
  };
}
