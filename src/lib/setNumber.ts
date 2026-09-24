/**
 * Set-number string rules, shared by the search box and the Rebrickable fetcher.
 *
 * The same /-\d+$/ test exists in three places: here, src/db/brickeconomy/client.ts, and
 * src/db/brickeconomy/source.ts. This unifies two of them — the BrickEconomy adapter is frozen,
 * so its copies stay put. Do not assume the rule is defined once.
 */

const VARIANT_SUFFIX = /-\d+$/;

/** Long enough for any real set number, short enough that a URL cannot be used as a payload. */
export const MAX_SET_NUMBER_LENGTH = 32;

/**
 * Alphanumerics and hyphen, with at least one alphanumeric.
 *
 * Covers every set number this app has seen — "10236-1", "75192", "k8672-1", "CELEBV-1" — while
 * excluding '.' so that ".." and every other dot-segment is unrepresentable rather than merely
 * unlikely.
 */
const ADDRESSABLE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9-]+$/;

/**
 * True when a string could be a set number this app addresses — safe as a URL segment, and safe to
 * render as text.
 *
 * Deliberately WEAKER than looksLikeSetNumber, which is about whether the user typed a number
 * rather than a name. "k8672-1" is a real Rebrickable set number that fails that stricter test,
 * and an unknown-but-plausible number should reach an honest "not valued yet" page rather than a
 * 404. This is the guard for "may this string become a route segment", nothing more.
 *
 * Hoisted out of app/set/[setNumber]/page.tsx so the figure route's `?inSet=` parameter is
 * validated by exactly the same rule the set route validates its own segment with — two copies
 * would be two chances to disagree about what is addressable.
 */
export function isAddressableSetNumber(raw: string): boolean {
  const value = raw.trim();
  return value !== '' && value.length <= MAX_SET_NUMBER_LENGTH && ADDRESSABLE.test(value);
}

/** True when the number already names a specific variant, e.g. "75192-1". */
export function hasVariantSuffix(setNumber: string): boolean {
  return VARIANT_SUFFIX.test(setNumber);
}

/** Rebrickable set numbers carry a variant suffix; a bare number resolves to nothing. */
export function withVariantSuffix(setNumber: string): string {
  return hasVariantSuffix(setNumber) ? setNumber : `${setNumber}-1`;
}

/**
 * True when the user typed a number rather than a name, so the search box can skip the network
 * entirely and go straight to the existing lookup flow.
 *
 * Deliberately strict. "k8672-1" is a real Rebrickable set number but reads as text here and
 * falls through to search — which finds it anyway, because Rebrickable's text search matches
 * set_num too. The expensive mistake is the other direction: treating a name as a number and
 * searching nothing.
 */
export function looksLikeSetNumber(raw: string): boolean {
  return /^\d{2,7}(-\d{1,3})?$/.test(raw.trim());
}

/**
 * Cache key for a free-text query: trimmed, whitespace-collapsed, lowercased, so "  Millennium
 * FALCON " and "millennium falcon" are one request rather than two.
 *
 * Never applied to a set number. Valuation and SetSnapshot rows are keyed by the number exactly
 * as typed, and equivalentKeys() in the BrickEconomy source is what reconciles "10236" with
 * "10236-1" — normalising upstream would split those caches instead of sharing them.
 */
export function searchKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}
