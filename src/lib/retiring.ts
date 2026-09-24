// Which cached sets count as "retiring soon", in what order, and what their forecast says.
// Pure: no I/O, no Prisma, no adapter. The board reads the cache, then asks this module.
//
// The row and forecast shapes live HERE rather than beside the Prisma queries that produce them,
// because app/components/RetiringBoard.tsx is a client component and must not reach a module that
// value-imports Prisma. Type-only imports are erased under verbatimModuleSyntax, but defining them
// in the pure module removes the hazard instead of relying on that.

import { looksLikeSetNumber, searchKey } from './setNumber.ts';

/** The subset of a BricksetSet row this module reasons about. */
export interface RetiringInput {
  setNumber: string;
  exitDate: Date | null;
  availability: string | null;
}

/** A BricksetSet row as the board consumes it. */
export interface RetiringRow {
  setNumber: string;
  name: string | null;
  theme: string | null;
  year: number | null;
  exitDate: Date | null;
  launchDate: Date | null;
  availability: string | null;
  usRetailPrice: number | null;
  usDateLastAvailable: Date | null;
  imageUrl: string | null;
  lastSynced: Date;
}

/**
 * Brickset `availability` strings that mean "retiring, but still available".
 *
 * DELIBERATELY EMPTY. `availability` is a DISTRIBUTION label — the value observed live is
 * "LEGO exclusive", which says how a set is sold and nothing about when it leaves. Seeding this
 * list by guessing would pull every exclusive in the catalogue onto the board and drown the real
 * signal.
 *
 * CHECKED AGAINST A FULL SYNC of 4,814 sets: every one of the fourteen distinct availability
 * values is a distribution label — see the list on EXITED_AVAILABILITY below. None of them means
 * "retiring". So this stays empty and exitDate is the sole inclusion signal, which is the honest
 * state and produces a correct board rather than a polluted one.
 *
 * To re-check after a future sync:
 *   sqlite3 prisma/dev.db "select availability, count(*) from BricksetSet group by 1 order by 2 desc;"
 */
export const RETIRING_AVAILABILITY: readonly string[] = [];

/**
 * Availability strings meaning the set has already gone — an exclusion, checked before the date.
 *
 * ALSO EMPTY, and for the same evidence: a full sync produced exactly fourteen distinct values,
 * and not one of them is a retirement state.
 *
 *   Retail 2189 · {Not specified} 741 · LEGO exclusive 908 · Magazine gift 449 · Promotional 239
 *   Retail - limited 206 · Not sold 47 · Educational 12 · LEGOLAND exclusive 10 · Insiders
 *   Reward 7 · LEGO Gift with Purchase 3 · Gift with Purchase at LEGO.com 1 · LEGO House
 *   exclusive 1 · Unknown 1
 *
 * Both lists are kept as the mechanism, empty because the data says so rather than because nobody
 * looked. exitDate carries inclusion and exclusion on its own.
 */
export const EXITED_AVAILABILITY: readonly string[] = [];

const DEFAULT_WINDOW_MONTHS = 6;
/**
 * Five years — past this the filter stops filtering, since the synced window only spans the
 * current year and the prior four. A wider request is a typo, not an intent, so it falls back.
 */
const MAX_WINDOW_MONTHS = 60;

function readWindow(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < 1 || parsed > MAX_WINDOW_MONTHS) return fallback;
  return parsed;
}

/** Takes a plain record rather than NodeJS.ProcessEnv so callers and tests can pass a literal. */
export function retiringWindowFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return readWindow(env['RETIRING_WINDOW_MONTHS'], DEFAULT_WINDOW_MONTHS);
}

/**
 * The ?months= override, falling back to the env default. Guarded on both sides: a junk or
 * out-of-range value falls back rather than silently emptying the board, which would read as
 * "nothing is retiring" — a claim the data never made.
 */
export function resolveWindowMonths(
  searchParam: string | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  return readWindow(searchParam, retiringWindowFromEnv(env));
}

/** The far edge of the window. Exclusive of nothing — a set exiting exactly on it still counts. */
export function windowEnd(today: Date, months: number): Date {
  const end = new Date(today.getTime());
  end.setUTCMonth(end.getUTCMonth() + months);
  return end;
}

/** Whole months from today to the exit date, floored at 0. "Retires in 0 months" means weeks. */
export function monthsUntil(exitDate: Date, today: Date): number {
  const months =
    (exitDate.getUTCFullYear() - today.getUTCFullYear()) * 12 +
    (exitDate.getUTCMonth() - today.getUTCMonth());
  // Not yet past the day-of-month, so the final month has not completed.
  const partial = exitDate.getUTCDate() < today.getUTCDate() ? 1 : 0;
  return Math.max(0, months - partial);
}

/** True when adding a day rolls the month over. */
function isMonthEnd(date: Date): boolean {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getUTCMonth() !== date.getUTCMonth();
}

/** How much of a Brickset exitDate is real: the year, the month, or the actual day. */
export type ExitPrecision = 'year' | 'month' | 'day';

/**
 * Brickset's exitDate is almost never a day-level fact, and the UI must not render it as one.
 *
 * MEASURED over a full 4,814-set sync: 2,489 of the 2,503 exit dates fall on the last day of a
 * month, and 2,055 of those are December 31 — buckets, not dates. In the current six-month
 * window, 475 of 476 candidates land on the 31st. Corroborating: 10312 Jazz Club lists exitDate
 * 2025-12-31 while LEGO.com actually stopped selling it on 2025-11-22.
 *
 * So December 31 means "sometime in that year", any other month end means "sometime in that
 * month", and only the remaining handful (promos and gifts-with-purchase) are real dates.
 * Printing "31 July 2026" for a month bucket would invent a precision Brickset never claimed.
 */
export function exitDatePrecision(exitDate: Date): ExitPrecision {
  if (exitDate.getUTCMonth() === 11 && exitDate.getUTCDate() === 31) return 'year';
  return isMonthEnd(exitDate) ? 'month' : 'day';
}

/** Which source a resolved retirement date came from, so a bucket is never mistaken for a day. */
export type RetirementSource = 'lego.com' | 'brickeconomy' | 'brickset';

/**
 * Which real-world event a date marks. The board keeps these apart on purpose: LEGO.com direct
 * sales ending and the set leaving the market are different moments, and the first happens first.
 */
export type RetirementEvent = 'retirement' | 'lego_com_exit';

export interface ResolvedRetirement {
  date: Date;
  precision: ExitPrecision;
  source: RetirementSource;
  event: RetirementEvent;
  /** True when the resolved date has already passed. */
  isPast: boolean;
}

/**
 * The most accurate retirement date available for a set, or null when nothing is known.
 *
 * PRECEDENCE IS BY WHICH SOURCE DATES THE SAME EVENT MOST PRECISELY — not simply by which source
 * is "better", which is what makes step 1 conditional:
 *
 *   1. LEGO.com dateLastAvailable, ONLY when it is in the future. This field dates a DIFFERENT
 *      event — LEGO.com direct sales ending — which happens before the set leaves the market. A
 *      future value is a forward-looking projection and is the best retirement estimate there is;
 *      a past value merely says the direct channel has already closed, so it must not become the
 *      headline. MEASURED: across all 4,814 synced rows there are ZERO future values — Brickset
 *      records this field retrospectively — so this step currently never fires. The past ones are
 *      surfaced by the card as their own labelled fact, and break ties in the retiring sort.
 *
 *   2. BrickEconomy retired_date from an ALREADY-CACHED snapshot. This dates the same event as
 *      Brickset's exitDate, just observed rather than estimated, so it wins even when past — a
 *      past value means "already retired, Brickset has not caught up", which the card says
 *      outright. Never fetched to obtain: a set with no snapshot simply skips this step, because
 *      valuing 476 candidates to date them would spend the entire daily quota on one render.
 *      MEASURED: BrickEconomy publishes retired_date only for sets it already considers retired,
 *      so this step fires only in the "Brickset stale, BrickEconomy ahead" case — currently none.
 *
 *   3. Brickset exitDate, at whatever precision it actually claims (see exitDatePrecision). This
 *      carries every card today.
 *
 * PLANNED NEXT PRECISION SOURCE — NOT BUILT: live LEGO.com scraping for real-time "leaving soon"
 * dates. That is the only source that would supply a genuine forward-looking retirement day, and
 * it would slot in ahead of step 1. Deliberately out of scope here; this function uses only data
 * that has already been synced, and must never issue a request.
 */
export function resolveRetirementDate(
  row: Pick<RetiringRow, 'exitDate' | 'usDateLastAvailable'>,
  forecast: ForecastInput | undefined,
  today: Date,
): ResolvedRetirement | null {
  const legoDate = row.usDateLastAvailable;
  if (legoDate !== null && legoDate.getTime() > today.getTime()) {
    return {
      date: legoDate,
      precision: 'day',
      source: 'lego.com',
      event: 'retirement',
      isPast: false,
    };
  }

  const retiredDate = forecast?.retiredDate ?? null;
  if (retiredDate !== null) {
    return {
      date: retiredDate,
      precision: 'day',
      source: 'brickeconomy',
      event: 'retirement',
      isPast: retiredDate.getTime() < today.getTime(),
    };
  }

  if (row.exitDate !== null) {
    return {
      date: row.exitDate,
      precision: exitDatePrecision(row.exitDate),
      source: 'brickset',
      event: 'retirement',
      isPast: row.exitDate.getTime() < today.getTime(),
    };
  }

  return null;
}

/**
 * A past LEGO.com date, which is a real day about the direct-sales channel closing — shown beside
 * the retirement date rather than instead of it. Null when the date is absent, or when it is in
 * the future and has already become the headline via step 1.
 */
export function legoComExit(
  row: Pick<RetiringRow, 'usDateLastAvailable'>,
  today: Date,
): Date | null {
  const date = row.usDateLastAvailable;
  if (date === null || date.getTime() > today.getTime()) return null;
  return date;
}

/** Already gone by Brickset's own account. */
function hasExited(row: RetiringInput, today: Date): boolean {
  if (row.availability !== null && EXITED_AVAILABILITY.includes(row.availability)) return true;
  return row.exitDate !== null && row.exitDate.getTime() < today.getTime();
}

/**
 * Retiring soon: an exit date inside the window, or an availability string that says so.
 *
 * A row with no exitDate and no availability signal is NOT a candidate — "we don't know when this
 * retires" is not evidence that it retires soon, and the board would fill with the whole catalogue.
 * A row with no exitDate but a genuine availability signal IS one, and renders as "retirement date
 * unknown".
 */
export function isCandidate(row: RetiringInput, today: Date, months: number): boolean {
  if (hasExited(row, today)) return false;

  if (row.availability !== null && RETIRING_AVAILABILITY.includes(row.availability)) return true;

  if (row.exitDate === null) return false;
  return row.exitDate.getTime() <= windowEnd(today, months).getTime();
}

/**
 * Soonest exit first. Rows with no exit date sort last rather than first — an unknown date is the
 * weakest signal on the board, and floating it to the top would rank ignorance as urgency. Ties
 * break on set number so the order is stable across renders.
 */
export function rankCandidates<T extends RetiringInput>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const left = a.exitDate?.getTime() ?? Infinity;
    const right = b.exitDate?.getTime() ?? Infinity;
    if (left !== right) return left - right;
    return a.setNumber.localeCompare(b.setNumber);
  });
}

/** The BrickEconomy figures the board displays, if a snapshot has already been cached. */
export interface ForecastInput {
  sealed: number | null;
  forecast2y: number | null;
  growth12m: number | null;
  /**
   * BrickEconomy's `retired_date`, when the cached snapshot carries one. Present only for sets
   * BrickEconomy already considers retired, so it is normally absent for a retiring-soon
   * candidate — see resolveRetirementDate.
   */
  retiredDate?: Date | null;
}

/** A cached BrickEconomy snapshot as the board consumes it. */
export interface CachedForecast extends ForecastInput {
  /** The day the snapshot was taken, shown so an old forecast is visibly old. */
  fetchedOn: string;
}

export interface ForecastVerdict {
  sealed: number | null;
  forecast2y: number | null;
  /** Fractional 12m change: 0.042 = +4.2%, matching Valuation.trend. */
  growth12m: number | null;
  /**
   * Null when either figure is missing — "we cannot tell" is a third answer, and collapsing it
   * to false would render an unjudged set identically to one judged and rejected.
   */
  positive: boolean | null;
}

/**
 * The "positive forecast" test: BrickEconomy expects the set to be worth more in two years than
 * it is now. Strictly greater — a flat forecast is not a positive one.
 */
export function forecastVerdict(input: ForecastInput): ForecastVerdict {
  const { sealed, forecast2y, growth12m } = input;
  return {
    sealed,
    forecast2y,
    growth12m,
    positive: sealed === null || forecast2y === null ? null : forecast2y > sealed,
  };
}

// ─── Board controls ──────────────────────────────────────────────────────────
// Everything below runs over rows the page has ALREADY loaded from the cache. None of it can
// reach a provider, which is what makes sorting and filtering free no matter how often it runs.

export type SortKey = 'retiring' | 'opportunity' | 'value' | 'discount';

export const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string; hint: string }> = [
  { key: 'retiring', label: 'Retiring first', hint: 'Soonest retirement date' },
  { key: 'opportunity', label: 'Opportunity', hint: 'Largest forecast gain in dollars' },
  { key: 'value', label: 'Value', hint: 'Highest current sealed value' },
  { key: 'discount', label: 'Discount to forecast', hint: 'Largest forecast gain as a percentage' },
];

export function isSortKey(value: string): value is SortKey {
  return SORT_OPTIONS.some((option) => option.key === value);
}

/** Absolute forecast upside in dollars. Null unless BOTH figures were observed. */
export function absoluteUpside(forecast: ForecastInput | undefined): number | null {
  if (forecast === undefined) return null;
  const { sealed, forecast2y } = forecast;
  if (sealed === null || forecast2y === null) return null;
  return forecast2y - sealed;
}

/**
 * Forecast upside as a fraction of the current value: 0.47 = +47%.
 *
 * Guards a zero sealed value rather than dividing by it — a set BrickEconomy prices at nothing has
 * no meaningful percentage, and Infinity would sort it above every real opportunity.
 */
export function relativeUpside(forecast: ForecastInput | undefined): number | null {
  const absolute = absoluteUpside(forecast);
  const sealed = forecast?.sealed ?? null;
  if (absolute === null || sealed === null || sealed <= 0) return null;
  return absolute / sealed;
}

// ─── Forecast grade ──────────────────────────────────────────────────────────
// A DISPLAY layer over the numbers above, and only that. The sorts keep ranking on raw
// absoluteUpside and relativeUpside, so grading changes what a badge says, never what order the
// board is in. forecastVerdict's plain positive/negative test is untouched and still available to
// anything that wants the raw ">0" question rather than a band.

/**
 * How the two-year forecast compares to today's sealed value, in bands.
 *
 * Four bands rather than a positive/negative flip, because +2% and +80% are not the same claim and
 * one badge said they were. Worst to best; the order is load-bearing — see isPositiveOrBetter.
 */
export type ForecastTier = 'negative' | 'flat' | 'positive' | 'strong';

/** Compared by position, never indexed, so noUncheckedIndexedAccess has nothing to say about it. */
const TIER_ORDER: readonly ForecastTier[] = ['negative', 'flat', 'positive', 'strong'];

/**
 * The band edges, as fractions: 0.15 = +15%.
 *
 * POSITIVE_GROWTH is used on BOTH sides — it is the bar for "worth acting on" and, mirrored, the
 * half-width of the flat band. There is deliberately no separate negative threshold to drift out
 * of step with it.
 *
 * TUNED BY FEEL, MEANT TO BE ADJUSTED. Nothing in the data picks these; they are a first cut at
 * "worth a second look" and "worth acting on" over a two-year hold, aimed at a flipper who wants a
 * $30 -> $50 trade rather than mild drift. Change them here and the boundary fixtures in
 * retiring.test.ts must move with them — deliberately, so a retune is a visible decision rather
 * than a silent drift.
 */
export const POSITIVE_GROWTH = 0.15;
export const STRONG_GROWTH = 0.4;

export interface ForecastGrade {
  tier: ForecastTier;
  /** FRACTION, not a percentage: 0.52 = +52%. Same unit as growth12m, so formatPercent renders both. */
  growthPct: number;
  /** The same growth in dollars: forecast2y - sealed. */
  growthAbs: number;
}

/**
 * The bands, best to worst, around a SYMMETRIC flat middle: a forecast has to move more than
 * POSITIVE_GROWTH in either direction before it is called anything at all.
 *
 * A -0.5% forecast is not a prediction of loss, it is a prediction of nothing — the same noise
 * +0.5% is. Banding one Flat while the other read Negative would hang a warning colour on the
 * arithmetic sign rather than on a finding, which is the same overstatement this whole change
 * exists to stop, pointed the other way. Negative is reserved for a real drop.
 *
 * Lower bounds inclusive throughout: exactly -15% is Flat, exactly +15% is Positive, exactly +40%
 * is Strong. Negative needs to be strictly worse than -15%.
 */
function tierFor(growthPct: number): ForecastTier {
  if (growthPct >= STRONG_GROWTH) return 'strong';
  if (growthPct >= POSITIVE_GROWTH) return 'positive';
  if (growthPct >= -POSITIVE_GROWTH) return 'flat';
  return 'negative';
}

/**
 * The graded forecast, or null when there is nothing to grade.
 *
 * NULL IS A THIRD ANSWER, not a bad band. "We cannot tell" must never render as Flat: an unvalued
 * set is unjudged, and banding it would show it identically to one that was judged and found to be
 * going nowhere.
 *
 * Built on absoluteUpside and relativeUpside so the badge and the two upside sorts can never
 * disagree about what a set's upside is. That inherits their sealed<=0 guard: a set BrickEconomy
 * prices at nothing has no percentage to band, so it gets no tier — while its dollar upside stays
 * real and keeps sorting. Growth from zero is undefined, not +400%, and Infinity clears every
 * threshold below it.
 *
 * The finite check is that same refusal one step further out. Non-finite figures cannot reach here
 * from the cache — readModels.finite() nulls them first — but NaN loses every comparison in
 * tierFor and would fall out the far end labelled Strong, which is the worst thing a badge whose
 * whole job is not overstating could do.
 */
export function forecastTier(forecast: ForecastInput | undefined): ForecastGrade | null {
  const growthAbs = absoluteUpside(forecast);
  const growthPct = relativeUpside(forecast);
  // growthAbs cannot be null once growthPct is not — relativeUpside is built on it — but this is
  // what tells the type system so, and it costs nothing.
  if (growthAbs === null || growthPct === null) return null;
  if (!Number.isFinite(growthPct)) return null;
  return { tier: tierFor(growthPct), growthPct, growthAbs };
}

/**
 * Positive or better: Positive and Strong pass; Flat and Negative do not.
 *
 * Null does not pass. An unvalued set is unjudged, not judged good, and must never slip through a
 * filter claiming to show only forecasts worth acting on.
 */
export function isPositiveOrBetter(grade: ForecastGrade | null): boolean {
  if (grade === null) return false;
  return TIER_ORDER.indexOf(grade.tier) >= TIER_ORDER.indexOf('positive');
}

/**
 * Badge text. Lives here beside the thresholds so the checkbox and the badge cannot disagree about
 * what "Positive" names. A Record over the union, so a fifth tier becomes a compile error here
 * rather than an `undefined` in the JSX.
 */
export const TIER_LABELS: Readonly<Record<ForecastTier, string>> = {
  negative: 'Negative',
  flat: 'Flat',
  positive: 'Positive',
  strong: 'Strong',
};

/**
 * Sorts that rank on a measured number park unmeasured sets at the BOTTOM, in a stable block.
 *
 * They are never coerced to 0. A set nobody has valued is unranked, not worthless, and zero would
 * file it below a genuinely loss-making forecast — turning "we didn't look" into a verdict.
 */
function byMetricDescending<T>(
  rows: readonly T[],
  metric: (row: T) => number | null,
  tiebreak: (a: T, b: T) => number,
): T[] {
  return [...rows].sort((a, b) => {
    const left = metric(a);
    const right = metric(b);
    if (left === null && right === null) return tiebreak(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return right - left;
    return tiebreak(a, b);
  });
}

/**
 * Soonest retirement first, using the RESOLVED date so a BrickEconomy day outranks a Brickset
 * bucket rather than being ignored.
 *
 * The tiebreak is the interesting part. 475 of the 476 candidates share a bucketed date, so ties
 * are the norm and an alphabetical tiebreak is arbitrary ordering dressed as a ranking. A set
 * whose LEGO.com channel has already closed is demonstrably further along than a peer in the same
 * bucket with no such evidence, so it goes first — the one place those 63 real days can honestly
 * affect the order. Set number breaks what remains, so renders stay stable.
 */
function sortByRetiring(
  rows: readonly RetiringRow[],
  forecasts: ReadonlyMap<string, ForecastInput>,
  today: Date,
): RetiringRow[] {
  return [...rows].sort((a, b) => {
    const left = resolveRetirementDate(a, forecasts.get(a.setNumber), today);
    const right = resolveRetirementDate(b, forecasts.get(b.setNumber), today);

    // An unknown date is the weakest signal on the board, so it sinks rather than leads.
    const leftTime = left?.date.getTime() ?? Infinity;
    const rightTime = right?.date.getTime() ?? Infinity;
    if (leftTime !== rightTime) return leftTime - rightTime;

    const leftClosed = legoComExit(a, today) !== null ? 0 : 1;
    const rightClosed = legoComExit(b, today) !== null ? 0 : 1;
    if (leftClosed !== rightClosed) return leftClosed - rightClosed;

    return a.setNumber.localeCompare(b.setNumber);
  });
}

/** Reorders the board. Never filters — a sort that hid rows would be a filter wearing a disguise. */
export function sortCandidates(
  rows: readonly RetiringRow[],
  forecasts: ReadonlyMap<string, ForecastInput>,
  sort: SortKey,
  today: Date,
): RetiringRow[] {
  const tiebreak = (a: RetiringRow, b: RetiringRow): number =>
    a.setNumber.localeCompare(b.setNumber);

  switch (sort) {
    case 'retiring':
      return sortByRetiring(rows, forecasts, today);
    case 'opportunity':
      return byMetricDescending(rows, (row) => absoluteUpside(forecasts.get(row.setNumber)), tiebreak);
    case 'value':
      return byMetricDescending(rows, (row) => forecasts.get(row.setNumber)?.sealed ?? null, tiebreak);
    case 'discount':
      return byMetricDescending(rows, (row) => relativeUpside(forecasts.get(row.setNumber)), tiebreak);
  }
}

export interface BoardFilters {
  theme: string | null;
  /** Null means unbounded on that side. */
  priceMin: number | null;
  priceMax: number | null;
  /**
   * "Positive or better" — tier Positive or Strong. The field name and its `pos=1` URL key survive
   * from the binary filter this replaced, so existing bookmarks still load, even though the bar
   * moved from "any growth at all" to POSITIVE_GROWTH. A bookmarked pos=1 board now shows fewer
   * sets, which is the whole point of the change.
   */
  positiveOnly: boolean;
  valuedOnly: boolean;
}

export const NO_FILTERS: BoardFilters = {
  theme: null,
  priceMin: null,
  priceMax: null,
  positiveOnly: false,
  valuedOnly: false,
};

export function hasPriceFilter(filters: BoardFilters): boolean {
  return filters.priceMin !== null || filters.priceMax !== null;
}

export function isFiltered(filters: BoardFilters, query: string): boolean {
  return (
    filters.theme !== null ||
    hasPriceFilter(filters) ||
    filters.positiveOnly ||
    filters.valuedOnly ||
    searchKey(query) !== ''
  );
}

/**
 * True when a set survives the filters.
 *
 * A price filter drops sets with no MSRP: absence is not a price, and keeping them would quietly
 * claim they fall inside the range. The board reports how many were dropped for that reason rather
 * than letting them disappear — and with no price filter active, they are never touched.
 */
export function matchesFilters(
  row: RetiringRow,
  forecast: ForecastInput | undefined,
  filters: BoardFilters,
): boolean {
  if (filters.theme !== null && row.theme !== filters.theme) return false;

  if (hasPriceFilter(filters)) {
    if (row.usRetailPrice === null) return false;
    if (filters.priceMin !== null && row.usRetailPrice < filters.priceMin) return false;
    if (filters.priceMax !== null && row.usRetailPrice > filters.priceMax) return false;
  }

  if (filters.valuedOnly && forecast === undefined) return false;

  // The grade must be observed AND at least Positive. Flat is a judged non-event rather than a buy
  // signal, and an unvalued set is unjudged — neither is a reason to survive this filter.
  if (filters.positiveOnly && !isPositiveOrBetter(forecastTier(forecast))) return false;

  return true;
}

/** Sets dropped solely for having no MSRP, so the count line can name them. */
export function countUnpricedHidden(
  rows: readonly RetiringRow[],
  filters: BoardFilters,
): number {
  if (!hasPriceFilter(filters)) return 0;
  return rows.filter((row) => row.usRetailPrice === null).length;
}

/**
 * In-board search: narrows what is already on screen, by name or number.
 *
 * Purely local. The app's other search (src/db/rebrickable/setSearch.ts) is a live HTTP call, and
 * wiring that to a keystroke here would spend a request per character typed. This walks rows that
 * are already in memory, so it is free by construction rather than by discipline.
 *
 * Reuses searchKey() and looksLikeSetNumber() from ./setNumber.ts so "  Millennium FALCON " and
 * "millennium falcon" behave identically, exactly as they do in the other search box.
 */
export function matchesBoardQuery(row: RetiringRow, query: string): boolean {
  const key = searchKey(query);
  if (key === '') return true;

  // "10312" must find "10312-1": the board stores the canonical suffixed form.
  if (looksLikeSetNumber(key)) return searchKey(row.setNumber).startsWith(key);

  if (searchKey(row.setNumber).includes(key)) return true;
  if (row.name !== null && searchKey(row.name).includes(key)) return true;
  return row.theme !== null && searchKey(row.theme).includes(key);
}

/** The complete control state: what to show, in what order. */
export interface BoardView extends BoardFilters {
  sort: SortKey;
  query: string;
}

export const DEFAULT_VIEW: BoardView = { ...NO_FILTERS, sort: 'retiring', query: '' };

/** A price box accepts only a non-negative number; anything else means unbounded, never zero. */
export function parsePrice(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Control state from query parameters.
 *
 * Lives here, pure, so the SERVER can parse the same URL the client will. Seeding the client from
 * window.location instead would make the first server render disagree with the first client
 * render — a hydration mismatch, and a visible flash of the wrong order on any shared link.
 */
export function parseBoardView(get: (key: string) => string | undefined): BoardView {
  const sort = get('sort') ?? '';
  return {
    sort: isSortKey(sort) ? sort : 'retiring',
    theme: get('theme') ?? null,
    priceMin: parsePrice(get('min')),
    priceMax: parsePrice(get('max')),
    positiveOnly: get('pos') === '1',
    valuedOnly: get('valued') === '1',
    query: get('q') ?? '',
  };
}

/**
 * The inverse: control state back into a query string, omitting defaults so a clean board has a
 * clean URL. `months` is threaded through because it belongs to the server render — dropping it
 * would silently resize the window on the next load.
 */
export function boardViewToQuery(view: BoardView, months: string): string {
  const params = new URLSearchParams();
  if (months !== '') params.set('months', months);
  if (view.sort !== 'retiring') params.set('sort', view.sort);
  if (view.theme !== null) params.set('theme', view.theme);
  if (view.priceMin !== null) params.set('min', String(view.priceMin));
  if (view.priceMax !== null) params.set('max', String(view.priceMax));
  if (view.positiveOnly) params.set('pos', '1');
  if (view.valuedOnly) params.set('valued', '1');
  if (view.query.trim() !== '') params.set('q', view.query.trim());
  return params.toString();
}

/**
 * The board's rows for a given view: filtered, then sorted. One function so the server's first
 * render and every later client render cannot drift apart.
 */
export function applyBoardView(
  rows: readonly RetiringRow[],
  forecasts: ReadonlyMap<string, ForecastInput>,
  view: BoardView,
  today: Date,
): RetiringRow[] {
  const kept = rows.filter(
    (row) => matchesFilters(row, forecasts.get(row.setNumber), view) && matchesBoardQuery(row, view.query),
  );
  return sortCandidates(kept, forecasts, view.sort, today);
}

/** Distinct themes with counts, for the filter dropdown. Alphabetical, so the list is scannable. */
export function boardThemes(rows: readonly RetiringRow[]): Array<{ theme: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.theme === null) continue;
    counts.set(row.theme, (counts.get(row.theme) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => a.theme.localeCompare(b.theme));
}
