import type { SetPreview } from './setPreview.ts';
import type { Valuation } from './types.ts';

/**
 * The Lookup grid's ordering controls.
 *
 * Everything here runs over previews the board has ALREADY loaded. It cannot reach a provider, it
 * cannot reach the database, and it makes no server round trip — which is what lets the control
 * that replaced the condition dropdown reorder twenty cards for free, however often it is used.
 *
 * The control it replaced did the opposite: changing condition re-queried, and a set valued under
 * one condition came back empty under another. Sorting is the honest version of that affordance —
 * it changes the order of what you can see, never whether you can see it.
 *
 * Pure and DOM-free, like the rest of src/lib.
 */

export type LookupSortKey =
  | 'relevance'
  | 'sealed_desc'
  | 'sealed_asc'
  | 'used_desc'
  | 'name_asc'
  | 'year_desc';

/**
 * A total Record, not a hand-written array, so a new key cannot be added to LookupSortKey without
 * being given words here.
 *
 * The array form alone was a silent hole: forgetting an entry is not a type error, and the key
 * would simply never appear in the dropdown while isLookupSortKey() rejected it — a sort that
 * exists in the type system and nowhere a user can reach.
 */
const SORT_META: Readonly<Record<LookupSortKey, { label: string; hint: string }>> = {
  relevance: { label: 'Best match', hint: 'The order the search returned' },
  sealed_desc: { label: 'Sealed price — high to low', hint: 'Highest sealed value first' },
  sealed_asc: {
    label: 'Sealed price — low to high',
    hint: 'Lowest sealed value first; unvalued sets stay last',
  },
  used_desc: {
    label: 'Used price — high to low',
    hint: 'Highest used value first — with box, else no box',
  },
  name_asc: { label: 'Name', hint: 'A to Z' },
  year_desc: { label: 'Year', hint: 'Newest first' },
};

/** Menu order, which is a presentation choice and deliberately not the union's declaration order. */
const SORT_ORDER = [
  'relevance',
  'sealed_desc',
  'sealed_asc',
  'used_desc',
  'name_asc',
  'year_desc',
] as const satisfies readonly LookupSortKey[];

export const LOOKUP_SORT_OPTIONS: ReadonlyArray<{
  key: LookupSortKey;
  label: string;
  hint: string;
}> = SORT_ORDER.map((key) => ({ key, ...SORT_META[key] }));

export function isLookupSortKey(value: string): value is LookupSortKey {
  return LOOKUP_SORT_OPTIONS.some((option) => option.key === value);
}

/** The stored figures, or null for a card that has not been valued yet. */
function figuresOf(preview: SetPreview): Valuation | null {
  return preview.valuation.kind === 'none' ? null : preview.valuation.valuation;
}

function sealedOf(preview: SetPreview): number | null {
  return figuresOf(preview)?.sealed ?? null;
}

/**
 * With box if we have it, else no box.
 *
 * A set BrickEconomy only gives a no-box figure for would otherwise sink to the bottom of a "used
 * price" sort as though it had no used data at all, which is a filter wearing a sort's clothes.
 */
function usedOf(preview: SetPreview): number | null {
  const figures = figuresOf(preview);
  if (figures === null) return null;
  return figures.usedWithBox ?? figures.usedNoBox;
}

/**
 * Orders known figures the requested way, with "we don't know" sinking to the bottom rather than
 * sorting as zero.
 *
 * The direction is a parameter and the null branches are NOT, which is the whole point. Negating a
 * descending comparator to get an ascending one also flips the nulls, floating every unvalued card
 * to the top of a "lowest price first" sort as though it were the cheapest thing on the page — a
 * filter wearing a sort's clothes, and a lie about sets whose price is simply unknown.
 */
function byFigure(a: number | null, b: number | null, direction: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'desc' ? b - a : a - b;
}

function compareBy(a: SetPreview, b: SetPreview, key: LookupSortKey): number {
  switch (key) {
    case 'relevance':
      return 0;
    case 'sealed_desc':
      return byFigure(sealedOf(a), sealedOf(b), 'desc');
    case 'sealed_asc':
      return byFigure(sealedOf(a), sealedOf(b), 'asc');
    case 'used_desc':
      return byFigure(usedOf(a), usedOf(b), 'desc');
    case 'name_asc':
      // meta.name always exists — mergePreviewMeta falls back to `Set ${setNumber}` — so nothing
      // sinks here, and a set with no catalogue entry still sorts somewhere sensible.
      return a.meta.name.localeCompare(b.meta.name);
    case 'year_desc':
      return byFigure(a.meta.year, b.meta.year, 'desc');
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled sort key: ${String(exhaustive)}`);
    }
  }
}

/**
 * Reorders the grid. Never adds, never drops, never re-fetches.
 *
 * Ties fall back to the incoming order, which is Rebrickable's relevance ranking — the thing a user
 * expects to see underneath any other sort. That is pinned with an explicit index rather than left
 * to Array.prototype.sort's stability, for the same reason rankSearchResults does it.
 *
 * Stale cards sort alongside fresh ones on purpose: their prices are real, just older, and the card
 * already says so in a banner. Sinking them would hide data the user has already paid for.
 */
export function sortPreviews(
  previews: readonly SetPreview[],
  key: LookupSortKey,
): SetPreview[] {
  if (key === 'relevance') return [...previews];

  return previews
    .map((preview, index) => ({ preview, index }))
    .sort((a, b) => {
      const primary = compareBy(a.preview, b.preview, key);
      return primary !== 0 ? primary : a.index - b.index;
    })
    .map((entry) => entry.preview);
}
