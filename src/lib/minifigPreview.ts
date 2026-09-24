import type { MinifigIdKind } from './minifigNumber.ts';
import type { MinifigFacts } from './minifigValuePort.ts';

/**
 * A figure's state on THIS machine right now, and what a card may say about it.
 *
 * Pure, like the rest of src/lib: no I/O, no Prisma, no adapter imports. Assembled by
 * src/db/minifigReads.ts out of rows already on disk, so rendering a panel of twenty-four figures
 * spends nothing.
 */

/**
 * Structurally the figure equivalent of PreviewProvenance in setPreview.ts, redeclared here for
 * the same reason it was redeclared there: src/lib never imports an adapter.
 *
 * There is no `derived` list. A figure derives NOTHING — BrickEconomy publishes one value and this
 * app computes no second one from it — so the only thing left to disclose is staleness.
 */
export interface MinifigProvenance {
  /** Set when the numbers came from an earlier day because the quota was spent. */
  staleFrom: string | null;
}

/**
 * SIX states, because six genuinely different things are true, and collapsing any two of them
 * prints a guess.
 *
 * `no_price` vs `absent` vs `unvalued` is the distinction that matters most:
 *   - `unvalued`   — we have never asked. A button, and a cost.
 *   - `no_price`   — BrickEconomy KNOWS this figure and publishes no value for it.
 *   - `absent`     — BrickEconomy has never heard of this id (a confirmed 400/404).
 *
 * Collapsing `absent` into `unvalued` offers to spend a request that is already known to fail.
 * Collapsing `no_price` into `valued` lets it count toward coverage, so "3 of 5 figures valued —
 * $340" prints over a sum of two. Collapsing `no_price` into `unvalued` invites a pointless
 * re-ask. All three have happened in tools that model this as one nullable number.
 */
export type MinifigValue =
  /** Never asked. The only state that carries a "Value this figure" button. */
  | { kind: 'unvalued'; minifigNumber: string; idKind: MinifigIdKind }
  | {
      kind: 'valued';
      minifigNumber: string;
      facts: MinifigFacts;
      /** Non-null BY CONSTRUCTION — a facts row with no figure is `no_price`, not `valued`. */
      value: number;
      fetchedOn: string;
      freshness: 'fresh' | 'stale';
      provenance: MinifigProvenance;
    }
  /** A record exists and carries no value. NOT "not valued yet", never $0.00, no Value button. */
  | {
      kind: 'no_price';
      minifigNumber: string;
      facts: MinifigFacts;
      fetchedOn: string;
      freshness: 'fresh' | 'stale';
      provenance: MinifigProvenance;
    }
  /** Asked; BrickEconomy answered 400/404. Permanent, age-blind, never re-spent without a click. */
  | { kind: 'absent'; minifigNumber: string; status: number; confirmedOn: string; attempts: number }
  /** Structurally unaskable — a Rebrickable id. See MINIFIG_ID_RULES for the words. */
  | { kind: 'unaddressable'; minifigNumber: string; idKind: MinifigIdKind }
  /** A payload on disk that will not map. "Not valued yet" plus a reason. Never a crash. */
  | { kind: 'unreadable'; minifigNumber: string; reason: string };

export interface MinifigPreview {
  minifigNumber: string;
  idKind: MinifigIdKind;
  /**
   * Only known once the figure has been valued — a set payload carries bare id strings and nothing
   * else. Null renders as the id alone, never as an invented `Minifig sw0509`.
   */
  name: string | null;
  /**
   * Typed literal `null`, not `string | null`, and that is the point.
   *
   * BrickEconomy publishes no artwork for figures, and Rebrickable's is keyed by fig-001549 with
   * no mapping to sw0509 — so pairing them would mean GUESSING a correspondence between two
   * ordered lists, which is not an observation. The day a real mapping exists, widening this type
   * is a compile-error-driven tour of every place a picture would have to appear.
   */
  imageUrl: null;
  state: MinifigValue;
}

/**
 * Mirrors classifyValuation() in setPreview.ts, including the rule that matters: a provisional row
 * is filed under today's date but holds an earlier day's numbers, so staleFrom WINS over the date.
 */
export function classifyMinifigValuation(
  fetchedOn: string,
  provenance: MinifigProvenance,
  today: string,
): 'fresh' | 'stale' {
  if (provenance.staleFrom !== null) return 'stale';
  return fetchedOn === today ? 'fresh' : 'stale';
}

/** The figure's value, or null for every state that does not have one. Never 0 as a stand-in. */
export function valueOf(state: MinifigValue): number | null {
  return state.kind === 'valued' ? state.value : null;
}

/** The facts, for the states that carry them. */
export function factsOf(state: MinifigValue): MinifigFacts | null {
  return state.kind === 'valued' || state.kind === 'no_price' ? state.facts : null;
}
