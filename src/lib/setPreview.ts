import { CONDITIONS, type Condition, type Valuation, type Verdict } from './types.ts';
import { MARGIN_THRESHOLD, verdict } from './verdict.ts';

/**
 * Preview cards: what Lookup can show about a set for free, and how a cached valuation is graded.
 *
 * The point of this module is the split it encodes. A preview is assembled entirely from data the
 * app already has — the search payload it just paid for, the Brickset catalogue cache, and any
 * valuation already on disk — so a grid of twenty cards costs nothing. Spending a BrickEconomy
 * request stays a separate, explicit, per-card act.
 *
 * Pure, like the rest of src/lib: no I/O, no Prisma, no adapter imports. That is also what lets a
 * client component use it — anything that value-imports src/composition.ts cannot cross that
 * boundary, because it pulls Prisma in at module load.
 */

/**
 * Structurally identical to Provenance in src/db/brickeconomy/source.ts, redeclared here so
 * src/lib keeps its rule of never importing an adapter — and so nothing gives the client bundle an
 * edge to a module that value-imports Prisma.
 */
export interface PreviewProvenance {
  derived: string[];
  staleFrom: string | null;
}

export interface SetPreviewMeta {
  setNumber: string;
  name: string;
  /** Null throughout means "not known", never zero and never an empty string. */
  theme: string | null;
  year: number | null;
  pieces: number | null;
  msrp: number | null;
  /** ISO day, e.g. "2026-12-31". */
  retireDate: string | null;
  imageUrl: string | null;
  /** Watchlist membership. Deliberately NOT ownership — no ownership data exists to read. */
  onWatchlist: boolean;
}

/**
 * A card's valuation state, and the reason this feature exists.
 *
 * 'none' and 'stale' both wait for an explicit button. Only 'fresh' fills itself in, and only
 * because those numbers are already paid for.
 */
export type PreviewValuation =
  | { kind: 'none' }
  | { kind: 'fresh'; valuation: Valuation; fetchedOn: string; provenance: PreviewProvenance }
  | { kind: 'stale'; valuation: Valuation; fetchedOn: string; provenance: PreviewProvenance };

export interface SetPreview {
  meta: SetPreviewMeta;
  valuation: PreviewValuation;
}

/** What the Rebrickable search already told us. Free: the search request is already paid for. */
export interface CatalogHint {
  name: string;
  year: number | null;
  theme: string | null;
  pieces: number | null;
  imageUrl: string | null;
}

/**
 * The catalogue facts a preview is already showing, in the shape the server takes back.
 *
 * Handed back when valuing so the re-read keeps the name, piece count and photo the user is
 * looking at. Without it a valued set with no Brickset row loses its artwork mid-click.
 *
 * Lives here rather than beside one caller because the Lookup grid and the detail route both
 * value sets, and a second copy of this mapping is a second thing to forget a field in.
 */
export function catalogHintFrom(preview: SetPreview): CatalogHint {
  return {
    name: preview.meta.name,
    year: preview.meta.year,
    theme: preview.meta.theme,
    pieces: preview.meta.pieces,
    imageUrl: preview.meta.imageUrl,
  };
}

/** A BricksetSet row. The only free source of MSRP and a retirement date. */
export interface BricksetHint {
  name: string | null;
  theme: string | null;
  year: number | null;
  usRetailPrice: number | null;
  exitDate: Date | null;
  imageUrl: string | null;
}

/** A Set row — the engine's own catalogue, populated only for sets that have been valued. */
export interface EngineSetHint {
  name: string;
  theme: string;
  pieces: number;
  msrp: number;
  releaseYear: number;
  retireDate: Date | null;
}

export interface PreviewSources {
  setNumber: string;
  catalog: CatalogHint | null;
  brickset: BricksetHint | null;
  engine: EngineSetHint | null;
  /** SetImage.imageUrl. Note SetImage.theme is a numeric theme_id and is never a theme name. */
  cachedImageUrl: string | null;
  onWatchlist: boolean;
}

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * First usable figure. Non-positive counts as absent for every field this is used on: a $0.00 MSRP
 * or a 0-piece set is a gap in the source, and printing it would read as a real measurement.
 */
function firstFigure(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function firstDay(...values: Array<Date | null | undefined>): string | null {
  for (const value of values) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
  }
  return null;
}

/**
 * Merges the free sources into one card's worth of facts, best source first.
 *
 * Rebrickable's search payload wins on catalogue fields because it is the freshest and the only
 * one carrying a piece count. Brickset owns MSRP and the retirement date — it is the only source
 * with either for an arbitrary set. Anything no source has stays null and the card omits it.
 */
export function mergePreviewMeta(sources: PreviewSources): SetPreviewMeta {
  const { setNumber, catalog, brickset, engine } = sources;

  return {
    setNumber,
    name: firstText(catalog?.name, brickset?.name, engine?.name) ?? `Set ${setNumber}`,
    theme: firstText(catalog?.theme, brickset?.theme, engine?.theme),
    year: firstFigure(catalog?.year, brickset?.year, engine?.releaseYear),
    // Brickset stores no piece count, so this is Rebrickable's number or the engine's or nothing.
    pieces: firstFigure(catalog?.pieces, engine?.pieces),
    msrp: firstFigure(brickset?.usRetailPrice, engine?.msrp),
    retireDate: firstDay(brickset?.exitDate, engine?.retireDate),
    imageUrl: firstText(catalog?.imageUrl, sources.cachedImageUrl, brickset?.imageUrl),
    onWatchlist: sources.onWatchlist,
  };
}

/**
 * Whether a cached valuation may fill a card in automatically.
 *
 * A provisional snapshot is filed under today's date but holds an earlier day's numbers — the
 * adapter writes one when the quota runs out. Today's date on the row is exactly what makes it
 * dangerous, so staleFrom wins over the date and the card keeps its refresh button.
 */
export function classifyValuation(
  fetchedOn: string,
  provenance: PreviewProvenance,
  today: string,
): 'fresh' | 'stale' {
  if (provenance.staleFrom !== null) return 'stale';
  return fetchedOn === today ? 'fresh' : 'stale';
}

/**
 * The highest buy price that still clears the margin bar, or null when nothing does.
 *
 * verdict() buys when `net - buy > buy * MARGIN_THRESHOLD`, i.e. when `buy < net / (1 +
 * MARGIN_THRESHOLD)`. That bound is strict, so this floors to the cent and steps back one more
 * when the floor lands exactly on it. Erring low costs the user a cent of headroom; erring high
 * would print a ceiling that fails its own test the moment they typed it in.
 *
 * Null when the net is zero or negative: no buy price works, and "$0.00" would read as one that
 * does. The card says so in words instead.
 */
export function maxBuyPrice(net: number): number | null {
  if (!Number.isFinite(net) || net <= 0) return null;

  const bound = net / (1 + MARGIN_THRESHOLD);
  let cents = Math.floor(bound * 100);
  if (cents / 100 >= bound) cents -= 1;

  return cents > 0 ? cents / 100 : null;
}

/**
 * What one condition would mean for this set: the play, the net, and the ceiling.
 *
 * `call` is verdict() run at a zero buy price, so `net`, `play` and `strategies` are real while
 * `margin` and `buy` are meaningless — verdict() calls anything profitable a BUY when nothing was
 * paid. Read `ceiling` instead, and only render BUY/PASS once a price has actually been typed.
 */
export interface ConditionCall {
  condition: Condition;
  call: Verdict;
  /** Null when no buy price clears the bar — see maxBuyPrice. */
  ceiling: number | null;
}

/**
 * Every condition's answer for one set, in CONDITIONS order.
 *
 * This is the shape the feature is named after. A set is not valued "in" a condition; it has a
 * value for all of them at once, and the row on disk already carries every band needed to say so.
 * The detail view renders every one and lets the user pick one for the verdict.
 *
 * Built with .map rather than by indexing CONDITIONS, so noUncheckedIndexedAccess has nothing to
 * complain about and another condition needs no change here.
 */
export function callsByCondition(valuation: Valuation): ConditionCall[] {
  return CONDITIONS.map((condition) => {
    const call = verdict(0, valuation, condition);
    return { condition, call, ceiling: maxBuyPrice(call.net) };
  });
}

/**
 * The condition whose best play nets the most.
 *
 * NEVER render this without naming the condition it assumes. part_out is eligible under every
 * condition and netAfterFees is monotone, so sealed wins for essentially all real data — but when
 * a used band does come top, an unlabelled "BUY UNDER $X" quotes a ceiling for a play the user
 * cannot execute on the sealed box in front of them. Ties break toward CONDITIONS order, which
 * puts sealed first.
 */
export function bestCall(calls: readonly ConditionCall[]): ConditionCall | null {
  return calls.reduce<ConditionCall | null>(
    (best, entry) => (best === null || entry.call.net > best.call.net ? entry : best),
    null,
  );
}

/**
 * next.config.ts allowlists exactly these two hosts, and next/image throws at render for any
 * other. An unexpected host falls back to the placeholder rather than taking the grid down.
 */
const IMAGE_HOSTS = ['https://cdn.rebrickable.com/', 'https://images.brickset.com/'];

export function isRenderableImage(url: string | null): url is string {
  return url !== null && IMAGE_HOSTS.some((host) => url.startsWith(host));
}

/**
 * The image frame, shared by every card and the detail view so they cannot drift apart.
 *
 * A fixed 4/3 box with object-cover: the artwork fills it edge to edge at every size instead of
 * floating in a letterboxed strip. 4/3 is close enough to the sources' natural shape that covering
 * crops a margin rather than the set itself.
 */
export const IMAGE_FRAME = 'relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-bg';
export const IMAGE_FIT = 'object-cover';
/** Same box, nothing to put in it. */
export const IMAGE_FRAME_EMPTY =
  'grid aspect-[4/3] w-full place-items-center rounded-lg border border-dashed border-border bg-bg';
