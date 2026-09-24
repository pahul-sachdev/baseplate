import type { MinifigPreview } from './minifigPreview.ts';
import type { MinifigRoster } from './minifigRoster.ts';
import { countedNotNamed } from './minifigValuePort.ts';
import { formatUSD, round2 } from './money.ts';

/**
 * The 50% rule: what share of a set's sealed value its minifigures carry.
 *
 * This module's job is not arithmetic — it is refusing to publish a number that would be read as
 * more certain than it is. A partial sum over a set's figures looks exactly like a complete one,
 * and "58%" printed alone is the single most likely way this feature could mislead a real
 * purchase. So the percentage is made STRUCTURALLY inseparable from the sentence that qualifies
 * it: the unrenderable variants carry no ratio at all, and the only way to get words out is
 * shareLines(), which cannot emit a percentage without also emitting coverage and dates.
 *
 * Pure and DOM-free, like the rest of src/lib.
 */

/** Env-tunable because it is a heuristic, not a measurement — same convention as factorsFromEnv. */
export const DEFAULT_MINIFIG_SHARE_THRESHOLD = 0.5;

/**
 * Reads MINIFIG_SHARE_THRESHOLD, ignoring anything outside (0, 1].
 *
 * Takes a plain record rather than NodeJS.ProcessEnv so callers and tests can pass a literal,
 * exactly like factorsFromEnv and retiringWindowFromEnv.
 */
export function shareThresholdFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env['MINIFIG_SHARE_THRESHOLD'];
  if (raw === undefined || raw === '') return DEFAULT_MINIFIG_SHARE_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_MINIFIG_SHARE_THRESHOLD;
  }
  return parsed;
}

/**
 * Exactly what is and is not known about this set's figures.
 *
 * Every field counts a REAL state, so the coverage sentence is GENERATED from data rather than
 * assembled by hand at a call site where a bucket could be forgotten.
 */
export interface MinifigCoverage {
  /** Ids BrickEconomy named. The denominator of "N of M". */
  listed: number;
  /** minifigs_count. Null when unreported. May exceed `listed` — see notNamed. */
  reported: number | null;
  /**
   * Counted but never named. Duplicates, OR figures BrickEconomy has no id for — and it does not
   * say which, so neither do we. MEASURED on 6 of this database's sets.
   */
  notNamed: number;

  valued: number;
  /** Known to BrickEconomy, no value published. Its own bucket — never counted as valued. */
  noPrice: number;
  absent: number;
  unaddressable: number;
  unvalued: number;
  unreadable: number;

  /** Every named figure has been asked about. */
  asked: boolean;
  /**
   * The sum can only ever be a LOWER BOUND: some named figure is unvalued, absent, priceless or
   * unaddressable, or the source counted figures it did not name.
   *
   * When FALSE — and only then — the ratio is a measurement. Every source of error pushes the
   * number DOWN and there is no bias in the other direction, which is precisely what makes a
   * clearing floor a proof rather than a guess.
   */
  isFloor: boolean;
  /**
   * True when no further click can improve coverage: every named figure is valued, priceless,
   * permanently absent or unaddressable. The UI says so rather than offering a button that cannot
   * help.
   */
  exhausted: boolean;
}

/**
 * WHEN the numbers that fed a ratio were observed.
 *
 * Carried explicitly because a ratio silently mixes vintages: a sealed value served from a
 * quota-exhausted provisional row three weeks ago, divided into figure values fetched this
 * morning, produces a confident percentage out of two numbers that were never true on the same
 * day. `mixed` is rendered on EVERY render, not only when it is extreme.
 */
export interface AsOf {
  oldest: string;
  newest: string;
  mixed: boolean;
  /** Set when ANY input was served from a quota-exhausted provisional row. Separate from `mixed`. */
  quotaStaleFrom: string | null;
}

/**
 * The share, discriminated so that an unrenderable one carries no number to render.
 *
 * There is deliberately no bare `ratio` on the first two variants and no formatting anywhere near
 * this type. A caller that wants a percentage must go through shareLines().
 */
export type MinifigShare =
  | {
      kind: 'no_denominator';
      reason: 'set_not_valued' | 'set_sealed_not_positive';
      figTotal: number;
      coverage: MinifigCoverage;
    }
  | { kind: 'no_numerator'; reason: 'no_named_figs' | 'no_fig_valued'; coverage: MinifigCoverage }
  | {
      kind: 'measured';
      figTotal: number;
      setSealed: number;
      ratio: number;
      coverage: MinifigCoverage;
      asOf: AsOf;
    }
  | {
      kind: 'floor';
      figTotal: number;
      setSealed: number;
      ratio: number;
      coverage: MinifigCoverage;
      asOf: AsOf;
    };

/**
 * The flag, and the reason it is three-way rather than a boolean.
 *
 * A floor that CLEARS the bar is a PROOF: valuing the remaining figures can only raise the total,
 * so "at least 58%, from 3 of 9 figures" already establishes minifig-rich. A floor that MISSES the
 * bar proves NOTHING — the six unvalued figures could carry it over — so it must never render as
 * "not minifig-rich". `not_assessable` is that state, and it is why a boolean would lie.
 */
export type MinifigRichFlag =
  | { kind: 'rich'; ratio: number; proven: 'measured' | 'floor' }
  | { kind: 'not_rich'; ratio: number }
  | { kind: 'not_assessable'; reason: string };

export function coverageOf(
  roster: MinifigRoster,
  figs: readonly MinifigPreview[],
): MinifigCoverage {
  const count = (kind: MinifigPreview['state']['kind']): number =>
    figs.filter((fig) => fig.state.kind === kind).length;

  const listed = figs.length;
  const reported = roster.kind === 'listed' ? roster.figs.reported : null;
  const notNamed = roster.kind === 'listed' ? countedNotNamed(roster.figs) : 0;

  const valued = count('valued');
  const noPrice = count('no_price');
  const absent = count('absent');
  const unaddressable = count('unaddressable');
  const unvalued = count('unvalued');
  const unreadable = count('unreadable');

  const asked = unvalued === 0 && unreadable === 0;
  // Anything not contributing a real number, plus anything counted-but-unnamed, makes the sum a
  // floor. Note noPrice and absent count here too: they are known NOT to contribute, but the
  // set genuinely contains them, so the total still understates the set's figure content.
  const isFloor = !asked || noPrice > 0 || absent > 0 || unaddressable > 0 || notNamed > 0;
  const exhausted = unvalued === 0 && unreadable === 0;

  return {
    listed,
    reported,
    notNamed,
    valued,
    noPrice,
    absent,
    unaddressable,
    unvalued,
    unreadable,
    asked,
    isFloor,
    exhausted,
  };
}

/**
 * Sums ONLY `kind === 'valued'`.
 *
 * An absent, priceless, unaddressable or unvalued figure contributes NOTHING and is never treated
 * as zero. Every one of them sets coverage.isFloor, so the omission is disclosed rather than
 * absorbed.
 *
 * Never quantity-weighted: BrickEconomy's set payload names distinct figures and publishes no
 * per-figure count, and Rebrickable's counts are in the unjoinable fig-XXXXXX id space. There is
 * no quantity to weight by, so none is invented.
 */
export function minifigShare(args: {
  roster: MinifigRoster;
  figs: readonly MinifigPreview[];
  /** The set's sealed band, or null when the set is not valued. */
  setSealed: number | null;
  setFetchedOn: string | null;
  setStaleFrom: string | null;
}): MinifigShare {
  const { roster, figs, setSealed, setFetchedOn, setStaleFrom } = args;
  const coverage = coverageOf(roster, figs);

  if (roster.kind !== 'listed' || figs.length === 0) {
    return { kind: 'no_numerator', reason: 'no_named_figs', coverage };
  }

  const valuedFigs = figs.flatMap((fig) => (fig.state.kind === 'valued' ? [fig.state] : []));
  if (valuedFigs.length === 0) {
    return { kind: 'no_numerator', reason: 'no_fig_valued', coverage };
  }

  const figTotal = round2(valuedFigs.reduce((sum, state) => sum + state.value, 0));

  if (setSealed === null || setFetchedOn === null) {
    return { kind: 'no_denominator', reason: 'set_not_valued', figTotal, coverage };
  }
  // A zero or negative sealed value is not a denominator. Dividing by it yields Infinity or a
  // negative percentage, and both would render as a confident number.
  if (!Number.isFinite(setSealed) || setSealed <= 0) {
    return { kind: 'no_denominator', reason: 'set_sealed_not_positive', figTotal, coverage };
  }

  const days = [setFetchedOn, ...valuedFigs.map((state) => state.fetchedOn)].sort();
  const oldest = days[0] ?? setFetchedOn;
  const newest = days[days.length - 1] ?? setFetchedOn;
  const figStale = valuedFigs.reduce<string | null>(
    (earliest, state) => {
      const from = state.provenance.staleFrom;
      if (from === null) return earliest;
      return earliest === null || from < earliest ? from : earliest;
    },
    null,
  );
  const quotaStaleFrom =
    setStaleFrom === null ? figStale : figStale === null ? setStaleFrom : (setStaleFrom < figStale ? setStaleFrom : figStale);

  const asOf: AsOf = { oldest, newest, mixed: oldest !== newest, quotaStaleFrom };
  const ratio = figTotal / setSealed;

  return coverage.isFloor
    ? { kind: 'floor', figTotal, setSealed, ratio, coverage, asOf }
    : { kind: 'measured', figTotal, setSealed, ratio, coverage, asOf };
}

export function richFlag(share: MinifigShare, threshold: number): MinifigRichFlag {
  if (share.kind === 'no_numerator') {
    return {
      kind: 'not_assessable',
      reason:
        share.reason === 'no_named_figs'
          ? 'BrickEconomy names no minifigures for this set.'
          : 'No minifigure has been valued yet.',
    };
  }
  if (share.kind === 'no_denominator') {
    return {
      kind: 'not_assessable',
      reason:
        share.reason === 'set_not_valued'
          ? 'This set has no sealed value on file, so there is nothing to compare the figures against.'
          : 'This set has no positive sealed value on file, so a share cannot be computed.',
    };
  }

  // Sound for a floor as well as a measurement: every source of error understates the total, so a
  // total that already clears the bar can only rise.
  if (share.ratio >= threshold) {
    return { kind: 'rich', ratio: share.ratio, proven: share.kind };
  }
  if (share.kind === 'measured') return { kind: 'not_rich', ratio: share.ratio };

  // Under the bar with figures still unaccounted for. This proves nothing, and rendering it as
  // "not minifig-rich" would be the lie this three-valued type exists to prevent.
  return {
    kind: 'not_assessable',
    reason: 'Some minifigures are still unvalued, so the total so far is a floor rather than an answer.',
  };
}

/**
 * Percentages round DOWN, never to nearest.
 *
 * At the default 0.50 threshold this makes the printed number and the flag agree exactly —
 * floor(ratio * 100) >= 50 is true for precisely the ratios that flag `rich` — so a card can never
 * read "50%" beside "not minifig-rich". It is also the conservative direction for a floor.
 */
function percent(ratio: number): string {
  return `${Math.floor(ratio * 100)}%`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function coverageSentence(coverage: MinifigCoverage, figTotal: number | null): string {
  const parts: string[] = [];

  if (figTotal === null) {
    parts.push(`0 of ${coverage.listed} named ${plural(coverage.listed, 'figure', 'figures')} valued.`);
  } else {
    parts.push(
      `${coverage.valued} of ${coverage.listed} named ${plural(coverage.listed, 'figure', 'figures')} valued — ` +
        `${formatUSD(figTotal)} so far.`,
    );
  }

  const buckets: string[] = [];
  if (coverage.noPrice > 0) {
    buckets.push(`${coverage.noPrice} ${plural(coverage.noPrice, 'has', 'have')} no published value`);
  }
  if (coverage.absent > 0) {
    buckets.push(
      `${coverage.absent} ${plural(coverage.absent, 'is', 'are')} not in BrickEconomy’s minifigure catalogue`,
    );
  }
  if (coverage.unaddressable > 0) {
    buckets.push(`${coverage.unaddressable} cannot be looked up`);
  }
  if (coverage.unreadable > 0) {
    buckets.push(`${coverage.unreadable} could not be read`);
  }
  if (buckets.length > 0) parts.push(`${buckets.join(', ')}.`);

  if (coverage.notNamed > 0 && coverage.reported !== null) {
    parts.push(
      `BrickEconomy counts ${coverage.reported} figures in this set but names ${coverage.listed}; ` +
        `the other ${coverage.notNamed} are duplicates, or figures it has no id for — it does not ` +
        `say which, so they cannot be valued and are not in the total.`,
    );
  }

  parts.push('Each named figure is counted once; BrickEconomy publishes no per-figure quantities.');
  return parts.join(' ');
}

function datesSentence(asOf: AsOf): string | null {
  const lines: string[] = [];
  if (asOf.mixed) {
    lines.push(
      `These numbers were not all observed on the same day — the oldest is from ${asOf.oldest} and ` +
        `the newest from ${asOf.newest}, so this ratio never held on any one day.`,
    );
  }
  if (asOf.quotaStaleFrom !== null) {
    lines.push(
      `Some of them were served from ${asOf.quotaStaleFrom} because the BrickEconomy daily quota ` +
        `was exhausted.`,
    );
  }
  return lines.length === 0 ? null : lines.join(' ');
}

/**
 * The ONLY renderer of a share. Returns all the lines or none — a percentage cannot leave this
 * module without the sentence that qualifies it and the dates that bound it.
 */
export function shareLines(
  share: MinifigShare,
  flag: MinifigRichFlag,
): { headline: string; coverage: string; dates: string | null; tone: 'neutral' | 'warn' } {
  switch (share.kind) {
    case 'no_numerator':
      return {
        headline:
          share.reason === 'no_named_figs'
            ? 'No minifigure share — BrickEconomy names no figures for this set.'
            : 'No minifigure share yet — no figure has been valued.',
        coverage: coverageSentence(share.coverage, null),
        dates: null,
        tone: 'neutral',
      };

    case 'no_denominator':
      return {
        headline:
          `${formatUSD(share.figTotal)} of minifigures so far — ` +
          (share.reason === 'set_not_valued'
            ? 'value the set to see what share of it that is.'
            : 'this set has no positive sealed value on file to compare against.'),
        coverage: coverageSentence(share.coverage, share.figTotal),
        dates: null,
        tone: 'warn',
      };

    case 'measured':
      return {
        headline:
          `Minifigures are ${percent(share.ratio)} of this set’s sealed value ` +
          `(${formatUSD(share.figTotal)} of ${formatUSD(share.setSealed)}).`,
        coverage: coverageSentence(share.coverage, share.figTotal),
        dates: datesSentence(share.asOf),
        tone: share.asOf.mixed || share.asOf.quotaStaleFrom !== null ? 'warn' : 'neutral',
      };

    case 'floor':
      return {
        headline:
          `At least ${percent(share.ratio)} of this set’s sealed value is minifigures ` +
          `(${formatUSD(share.figTotal)} of ${formatUSD(share.setSealed)} so far)` +
          (flag.kind === 'rich' ? ' — already past the bar, and it can only rise.' : '.'),
        coverage: coverageSentence(share.coverage, share.figTotal),
        dates: datesSentence(share.asOf),
        tone: 'warn',
      };

    default: {
      const exhaustive: never = share;
      throw new Error(`Unhandled share kind: ${String(exhaustive)}`);
    }
  }
}
