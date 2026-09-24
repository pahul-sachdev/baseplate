// Domain vocabulary. No I/O, no dependencies.

/**
 * `open_box` is a box that has been opened with its inner bags still sealed. It is deliberately
 * NOT a price band — BrickEconomy publishes none for it, and none is invented. See ELIGIBILITY
 * and RESELL_BAND in ./verdict.ts for what it can and cannot be scored as.
 */
export type Condition = 'sealed' | 'open_box' | 'used_box' | 'used_nobox' | 'incomplete';
export type Strategy = 'flip_sealed' | 'part_out' | 'resell_used';

/**
 * The named price bands on a Valuation — the keys a play can be priced off.
 *
 * Lives here rather than being spelled out at each use so that bandFor() in ./verdict.ts and the
 * condition-independent matrix in ./waysToAct.ts agree on what a band IS. The platform vocabulary
 * deliberately does not live here: see PlatformId in ./platforms.ts, which derives it from the
 * hand-edited config so adding a venue needs no change to this file.
 */
export type PriceBand = 'sealed' | 'usedWithBox' | 'usedNoBox' | 'partOut';

/**
 * Order is load-bearing in three places: conditionRank's tiebreak (./valuationRows.ts),
 * callsByCondition's output order, and bestCall's tie-break toward whatever sits at index 0.
 * Keep `sealed` first.
 */
export const CONDITIONS: readonly Condition[] = [
  'sealed',
  'open_box',
  'used_box',
  'used_nobox',
  'incomplete',
];
export const STRATEGIES: readonly Strategy[] = ['flip_sealed', 'part_out', 'resell_used'];

/** Narrows the strings crossing the DB and CLI boundaries, where the type system can't reach. */
export function isCondition(value: string): value is Condition {
  return (CONDITIONS as readonly string[]).includes(value);
}

export interface SetMeta {
  setNumber: string;
  name: string;
  theme: string;
  pieces: number;
  msrp: number;
  releaseYear: number;
  retireDate: Date | null;
  retired: boolean;
}

/**
 * What a ValueProvider returns: the three resale bands plus momentum.
 *
 * The used bands are nullable because "we have no used-market data" is a real answer — an
 * in-production set commonly has none. Null means unknown, never zero: downstream, a null band
 * makes resell_used unavailable rather than scoring it off a guess.
 */
export interface ValueQuote {
  sealed: number;
  usedWithBox: number | null;
  usedNoBox: number | null;
  /** Fractional 12m change: 0.042 = +4.2%. */
  trend: number;
}

/** What a PartOutProvider returns. */
export interface PartOutQuote {
  partOut: number;
  /** Distinct BrickLink lots the set breaks into — a proxy for how much work parting out is. */
  lotCount: number;
}

/** A set's four price bands on a given day. The engine's output, the verdict's input. */
export interface Valuation {
  setNumber: string;
  condition: Condition;
  sealed: number;
  /** Null when no used-market data exists — see ValueQuote. */
  usedWithBox: number | null;
  usedNoBox: number | null;
  partOut: number;
  trend: number;
  fetchedAt: Date;
  /** Day key in the app's fixed timezone: "YYYY-MM-DD". */
  fetchedOn: string;
}

export interface ValuationResult {
  set: SetMeta;
  valuation: Valuation;
  /** 'cache' means the providers were never called. */
  source: 'cache' | 'fresh';
  providers: { values: string; partOut: string };
}

/**
 * Discriminated on `eligible`, so an ineligible strategy carrying a score is unrepresentable —
 * there is no `net` field to set.
 */
export type StrategyResult =
  | { strategy: Strategy; eligible: true; gross: number; net: number }
  | { strategy: Strategy; eligible: false; reason: string };

export interface Verdict {
  play: Strategy;
  net: number;
  /** Dollar profit over the buy price. */
  margin: number;
  buy: boolean;
  /** Every strategy, eligible or not — this is what the CLI renders. */
  strategies: StrategyResult[];
}

export class SetNotFoundError extends Error {
  readonly setNumber: string;

  constructor(setNumber: string) {
    super(`Set ${setNumber} not found in the catalog`);
    this.name = 'SetNotFoundError';
    this.setNumber = setNumber;
  }
}
