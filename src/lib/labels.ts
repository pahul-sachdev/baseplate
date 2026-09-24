import type { Condition, Strategy } from './types.ts';

/**
 * The human words for the domain vocabulary, in one place.
 *
 * Lives in src/lib rather than beside the components that render it because ./explain.ts writes
 * prose using the same words, and src/lib cannot import from app/ — tsconfig.node.json sets no
 * `jsx` and excludes *.tsx. app/components/valuationParts.tsx re-exports STRATEGY_LABELS, so the
 * strategy table and the written explanation can never disagree about what a play is called.
 *
 * Both maps are total Records over their union rather than Record<string, string>: a new condition
 * or strategy becomes a compile error here instead of an unlabelled row in the UI.
 */

export const STRATEGY_LABELS: Readonly<Record<Strategy, string>> = {
  flip_sealed: 'Flip sealed',
  part_out: 'Part out',
  resell_used: 'Resell used',
};

/**
 * Where each play sells, for prose that has to explain what was deducted.
 *
 * Descriptive only — the actual arithmetic is netFor() in ./verdict.ts, which is the single source
 * of truth. If a play's venue changes there, change the words here in the same edit.
 */
export const STRATEGY_VENUES: Readonly<Record<Strategy, string>> = {
  flip_sealed: 'eBay fees',
  part_out: "BrickLink's cut",
  resell_used: 'eBay fees',
};

export const CONDITION_LABELS: Readonly<Record<Condition, string>> = {
  sealed: 'Sealed',
  open_box: 'Open box — bags sealed',
  used_box: 'Used, with box',
  used_nobox: 'Used, no box',
  incomplete: 'Incomplete',
};

/** Lower-case form, for mid-sentence use where "Sealed" would read as a proper noun. */
export const CONDITION_PHRASES: Readonly<Record<Condition, string>> = {
  sealed: 'sealed',
  open_box: 'open box, bags sealed',
  used_box: 'used, with box',
  used_nobox: 'used, no box',
  incomplete: 'incomplete',
};

/**
 * The indefinite article each phrase takes, for prose that says "a ___ copy".
 *
 * Data rather than a rule, because the rule is about sound and not spelling: "used" opens with a
 * vowel letter but a consonant sound, so the obvious /^[aeiou]/ test writes "an used, with box
 * copy". There are five phrases and they are fixed strings — reading the answer off a total
 * Record is both shorter than the heuristic and incapable of being wrong.
 */
export const CONDITION_ARTICLES: Readonly<Record<Condition, 'a' | 'an'>> = {
  sealed: 'a',
  open_box: 'an',
  used_box: 'a',
  used_nobox: 'a',
  incomplete: 'an',
};
