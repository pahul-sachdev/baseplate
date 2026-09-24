/**
 * Minifig-number string rules: which id space an identifier belongs to, and therefore what may
 * be asked of it.
 *
 * This is the feature's central risk expressed as a TYPE rather than as an error. BrickEconomy
 * identifies minifigures in BrickLink's space ("sw0509"); Rebrickable identifies them in its own
 * ("fig-001549"); and no public mapping between the two exists — Rebrickable publishes
 * `external_ids` for parts but not for minifigures, its bulk CSV has no BrickLink column, and its
 * staff closed the request to add one. So a figure we cannot address is a KIND — a first-class,
 * rendered, worded state — not a failure.
 *
 * Pure and DOM-free, like the rest of src/lib.
 */

/** Long enough for any real figure number, short enough that a URL cannot be used as a payload. */
export const MAX_MINIFIG_NUMBER_LENGTH = 32;

/**
 * BrickLink's figure numbering: a short theme prefix, a serial, and an optional variant letter.
 *
 * MEASURED against every figure id in this database (178 distinct, from 24 sets): prefixes are
 * cas/gen/hp/idea/sim/sp/sw/tlm/twn — 2 to 4 letters — with 3- or 4-digit serials, and seven ids
 * carry a variant letter (sw0001c, sw0002a, sw0011a, sw0028a, sw0521b, sw0636b, twn177a). The
 * bounds are widened slightly past what is observed, because BrickLink has longer prefixes this
 * collection simply has no set from.
 */
const BRICKECONOMY_ID = /^[a-z]{2,6}\d{2,5}[a-z]?$/;

/** Rebrickable's own space. Present only if someone types one — nothing in this app produces them. */
const REBRICKABLE_ID = /^fig-\d{4,7}$/;

/**
 * Safe as a URL path segment AND as displayed text.
 *
 * Alphanumerics and hyphen only, with at least one alphanumeric required. No dot and no
 * underscore: every real id in either space is covered without them (sw0509, sw0011a,
 * 90398pb015, fig-001549), and excluding '.' is what makes ".." and every other dot-segment
 * unrepresentable rather than merely unlikely.
 */
const ROUTABLE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9-]{1,32}$/;

export type MinifigIdKind =
  /** Addressable on BrickEconomy: sw0509, cas559, idea099, twn177a. */
  | 'brickeconomy'
  /** Rebrickable's space. NEVER addressable — there is no mapping to ask through. */
  | 'rebrickable'
  /**
   * Neither shape. MEASURED, not defensive: 20 of this database's 178 figure ids are
   * "90398pb015".."90398pb035" — BrickLink PART numbers for Hogwarts microfigures, which
   * BrickEconomy's own set payload lists among its minifigures. Confirmed 2026-07-30 that
   * GET /minifig/90398pb015 answers HTTP 400.
   *
   * Askable on an explicit click — refusing outright would be us predicting a 400, which is a
   * guess about someone else's catalogue — but never in a batch, because 20 requests to learn
   * 20 nothings is a fifth of the daily allowance.
   */
  | 'unclassified';

export const MINIFIG_ID_KINDS: readonly MinifigIdKind[] = [
  'brickeconomy',
  'rebrickable',
  'unclassified',
];

export interface MinifigIdRule {
  label: string;
  /** May one explicit click spend a request on an id of this kind? */
  askable: boolean;
  /** May "value the remaining figures" include it? */
  batchable: boolean;
  /** Rendered verbatim wherever an id of this kind cannot be valued. Never a bare dash. */
  note: string;
}

/**
 * A total Record, so a fourth id kind is a compile error here rather than an unlabelled row with
 * no words and an unexplained missing button. Same discipline as CONDITION_LABELS, RESELL_BAND
 * and SORT_META.
 */
export const MINIFIG_ID_RULES: Readonly<Record<MinifigIdKind, MinifigIdRule>> = {
  brickeconomy: { label: 'BrickEconomy id', askable: true, batchable: true, note: '' },
  rebrickable: {
    label: 'Rebrickable id',
    askable: false,
    batchable: false,
    note:
      'This is a Rebrickable minifigure id. BrickEconomy identifies minifigures in BrickLink’s id ' +
      'space (sw0509) and Rebrickable in its own (fig-001549), and no public mapping between them ' +
      'exists — Rebrickable publishes external ids for parts but not for minifigures. This figure ' +
      'cannot be valued, and BasePlate will not guess which BrickLink figure it is.',
  },
  unclassified: {
    label: 'Unrecognised id',
    askable: true,
    batchable: false,
    note:
      'This id does not look like a BrickEconomy minifigure number. BrickEconomy lists some ' +
      'microfigures by their BrickLink part number, and those usually have no minifigure record. ' +
      'You can still ask — the answer is cached permanently either way.',
  },
};

/**
 * Trimmed and lowercased, and NOTHING else.
 *
 * There is deliberately no equivalence rule here, unlike equivalentKeys() for set numbers. A
 * variant letter is part of a figure's identity: "sw0011a" is Chewbacca and "sw0011" is a
 * different figure, so treating them as one would file one figure's price under another's name.
 */
export function normaliseMinifigNumber(raw: string): string {
  return raw.trim().toLowerCase();
}

export function classifyMinifigId(raw: string): MinifigIdKind {
  const id = normaliseMinifigNumber(raw);
  if (REBRICKABLE_ID.test(id)) return 'rebrickable';
  if (BRICKECONOMY_ID.test(id)) return 'brickeconomy';
  return 'unclassified';
}

/**
 * True when the value can be a URL segment and rendered as text without further escaping.
 *
 * Separate from classifyMinifigId on purpose: an id can be perfectly routable and still be
 * unaddressable (fig-001549 is both), and the route must be able to render the honest
 * "cannot be valued" page for it rather than 404.
 */
export function isRoutableMinifigNumber(raw: string): boolean {
  const id = raw.trim();
  return id !== '' && id.length <= MAX_MINIFIG_NUMBER_LENGTH && ROUTABLE.test(id);
}

/**
 * True when the search box should treat what was typed as a figure number rather than a name.
 *
 * Cannot collide with looksLikeSetNumber (`^\d{2,7}(-\d{1,3})?$`): that one starts with a digit
 * and this one cannot, which is asserted over the whole corpus in the tests. Note that
 * "90398pb015" matches NEITHER and falls through to name search — correct, because it is not a
 * figure number and nobody would type it looking for one.
 */
export function looksLikeMinifigNumber(raw: string): boolean {
  return BRICKECONOMY_ID.test(normaliseMinifigNumber(raw));
}
