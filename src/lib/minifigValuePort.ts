import type { MinifigIdKind } from './minifigNumber.ts';

/**
 * Minifig values — a UI-facing capability, in its own file.
 *
 * A separate file from ports.ts on exactly the principle catalogImagePort.ts and setSearchPort.ts
 * already established: the valuation engine has no concept of a minifigure, so EngineDeps must not
 * grow a port getValuation() never calls. Nothing here is injected into the engine.
 */

/** One observed price on one day. Same shape BrickEconomy uses for sets. */
export interface MinifigPriceEvent {
  /** ISO day, e.g. "2026-07-27". */
  date: string;
  value: number;
}

/**
 * A source that reports both a COUNT and a LIST, where the two can disagree.
 *
 * MEASURED on 6 of the sets cached here: minifigs_count (17) exceeds minifigs.length (15), never
 * the reverse — the array names DISTINCT figures while the count includes duplicates. This type
 * exists so that gap can never be silently dropped, and it is also exactly the shape of the figure
 * payload's set_count vs sets[], so one tested primitive covers both.
 */
export interface CountedList {
  /** Ids the source actually named. May be empty while `reported` is positive. */
  listed: readonly string[];
  /** The count the source reported. Null when it reported none — which is NOT zero. */
  reported: number | null;
}

/** How many the source counted but did not name. Never negative. */
export function countedNotNamed(list: CountedList): number {
  if (list.reported === null) return 0;
  return Math.max(0, list.reported - list.listed.length);
}

/** True when any total over `listed` is a FLOOR rather than a measurement. */
export function isUndercounted(list: CountedList): boolean {
  return countedNotNamed(list) > 0;
}

/**
 * What BrickEconomy publishes about one figure.
 *
 * MEASURED against the live API on 2026-07-30 (6 successful payloads, sw0509 / sw0011a / cas559 /
 * twn417 / idea099 / hp159). The response is exactly twelve fields:
 *   minifig_number, name, description, set_count, sets[], theme, subtheme, year, released_date,
 *   current_value_new, price_events_new[], currency
 *
 * Four things are deliberately ABSENT here, and their absence is load-bearing:
 *
 *  - NO trend / growth / forecast. BrickEconomy publishes none for a figure — confirmed, not
 *    assumed. Because this type HAS no such field, handing a figure to anything that grades a
 *    trend is a COMPILE ERROR rather than a badge rendered off a defaulted 0, which would read
 *    "Flat" and mean "we never asked". Computing one from `priceEvents` would put a derived number
 *    in a row of observed ones; the events are shown as the observations they are instead.
 *  - NO used band. BrickEconomy publishes no used value for a figure.
 *  - NO quantity. The set payload names DISTINCT figures and carries no per-figure count, and
 *    Rebrickable's counts are in the unjoinable fig-XXXXXX space. Quantity is unknown, so there is
 *    no field here to accidentally default to 1.
 *  - NO imageUrl. BrickEconomy publishes none, and Rebrickable's artwork is behind the same
 *    missing id mapping.
 */
export interface MinifigFacts {
  minifigNumber: string;
  /** Null when the payload named none — never `Minifig ${id}` filled in as if it were observed. */
  name: string | null;
  description: string | null;
  theme: string | null;
  subtheme: string | null;
  year: number | null;
  /** ISO day. */
  releasedOn: string | null;
  /** The only money figure BrickEconomy publishes for a figure. Null = no value, never 0. */
  currentValueNew: number | null;
  /**
   * `sets` + `set_count` — the exclusivity signal, and it is REAL: confirmed present on every
   * observed payload. sw0509 returns set_count 1 and sets ["10236-1"]; sw0011a returns 16.
   *
   * Null when the payload carried neither, which is a different answer from "appears in no sets".
   */
  appearsIn: CountedList | null;
  /** BrickEconomy's last 12 recorded price changes. Observed points; no delta is computed. */
  priceEvents: readonly MinifigPriceEvent[];
  currency: string | null;
}

/**
 * What a lookup concluded.
 *
 * Discriminated, because "BrickEconomy has no such figure" and "we could not ask" are different
 * answers and only one of them is ever true. An empty quote must never stand in for a failure —
 * that distinction is what keeps a quota error from being cached as a permanent absence.
 */
export type MinifigLookup =
  | { ok: true; facts: MinifigFacts; fetchedOn: string; staleFrom: string | null }
  | { ok: false; reason: 'no_record'; status: number; confirmedOn: string }
  | { ok: false; reason: 'unaddressable'; kind: MinifigIdKind }
  | { ok: false; reason: 'quota' | 'auth' | 'unavailable'; message: string };

export interface MinifigValueProvider {
  readonly name: string;
  /**
   * At most one BrickEconomy request, and none at all when a non-provisional snapshot for today
   * exists or the figure is already recorded absent.
   */
  get(minifigNumber: string): Promise<MinifigLookup>;
}
