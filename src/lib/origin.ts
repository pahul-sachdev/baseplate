/**
 * Where the detail view was opened from, and how to get back there.
 *
 * The detail view is a route (`/set/[setNumber]`), not a dialog, so "close" is a navigation and
 * the destination has to travel with the link. It travels in `?from=`, as a relative path plus
 * query — which means it is user-editable text arriving from the URL bar, and is never trusted.
 *
 * Two jobs, in this order:
 *   1. Reject anything that could navigate off-origin. `?from=//evil.com` in an href is a real
 *      open redirect, and a label rendered from an unvalidated URL is a real spoofing surface.
 *   2. Map the surviving path to a KNOWN page, so the button's words come from ORIGIN_LABELS and
 *      never from the URL. An unrecognised page is not "labelled unknown" — it falls back
 *      wholly to Lookup, href included, so the button can never be dead and can never lie.
 *
 * Pure and DOM-free, like the rest of src/lib. Note that tsconfig.node.json compiles this with
 * `lib: ["ES2023"]` and no DOM, so `URL` and `URLSearchParams` do not exist here — the parsing is
 * plain string work, which is also what makes the guard short enough to read and to test.
 */

export type OriginKey = 'lookup' | 'watchlist' | 'trending' | 'retiring';

export interface Origin {
  key: OriginKey;
  /** Relative path plus query to return to. Always starts with exactly one '/'. */
  href: string;
  /** The destination's name, for "← Back to {label}". Always from ORIGIN_LABELS. */
  label: string;
}

export const ORIGIN_LABELS: Readonly<Record<OriginKey, string>> = {
  lookup: 'Lookup',
  watchlist: 'Watchlist',
  trending: 'Trending',
  retiring: 'Retiring',
};

/** The pathname each origin lives at. Total over OriginKey, so a new page is a compile error. */
const ORIGIN_PATHS: Readonly<Record<OriginKey, string>> = {
  lookup: '/',
  watchlist: '/watchlist',
  trending: '/trending',
  retiring: '/retiring',
};

/**
 * The fallback, and the reason the guard can fail closed: '/' is always a real, valid page, so
 * rejecting a `from` costs the user a correct destination rather than a broken button.
 */
export const DEFAULT_ORIGIN: Origin = { key: 'lookup', href: '/', label: ORIGIN_LABELS.lookup };

/** Long enough for the retiring board's full filter set, short enough to not be a weapon. */
export const MAX_FROM_LENGTH = 512;

/**
 * True when `value` can only ever address this app.
 *
 * Every rejection here is a specific attack, not a style rule:
 *   - not starting with '/' admits `https://evil.com` and `javascript:alert(1)`.
 *   - starting with '//' is protocol-relative: `//evil.com` resolves off-origin.
 *   - a backslash ANYWHERE is the subtle one. Browsers normalise '\' to '/' in URLs, so
 *     `/\evil.com` is `//evil.com` by the time it is followed. Rejecting the character outright
 *     is the only version of this check that is obviously correct.
 *   - control characters and spaces are request-smuggling and header-injection material.
 */
export function isSafeInternalPath(value: string | undefined): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (value.length > MAX_FROM_LENGTH) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.includes('\\')) return false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** The path with any query or fragment removed. */
function pathnameOf(value: string): string {
  let end = value.length;
  const query = value.indexOf('?');
  if (query !== -1 && query < end) end = query;
  const hash = value.indexOf('#');
  if (hash !== -1 && hash < end) end = hash;
  return value.slice(0, end);
}

function keyForPathname(pathname: string): OriginKey | null {
  for (const key of Object.keys(ORIGIN_PATHS) as OriginKey[]) {
    if (ORIGIN_PATHS[key] === pathname) return key;
  }
  return null;
}

/**
 * The origin a detail view should return to. Never throws; anything it does not fully recognise
 * becomes DEFAULT_ORIGIN.
 *
 * An unknown pathname is rejected outright rather than kept-with-a-generic-label, which is what
 * closes two holes at once: a spoofed `?from=/looks-official` cannot render, and `/set/...` is
 * not an origin, so `?from=/set/x?from=/set/y` cannot nest.
 *
 * `from` is typed loosely because that is the shape searchParams hands over — a repeated
 * `?from=a&from=b` arrives as an array, and there is no way to know which one was meant.
 */
export function parseOrigin(from: string | string[] | undefined): Origin {
  if (Array.isArray(from)) return DEFAULT_ORIGIN;
  if (!isSafeInternalPath(from)) return DEFAULT_ORIGIN;

  const key = keyForPathname(pathnameOf(from));
  if (key === null) return DEFAULT_ORIGIN;

  // The query survives verbatim — it is what carries the retiring board's whole view home.
  return { key, href: from, label: ORIGIN_LABELS[key] };
}

/**
 * The link a card points at.
 *
 * `from` is omitted for Lookup because parseOrigin already lands there with nothing set, so the
 * commonest link stays clean. An unsafe `from` is dropped rather than encoded: the detail page
 * would refuse it anyway, and a URL that carries a rejected value only invites someone to trust it.
 */
export function detailHref(setNumber: string, from: string): string {
  const path = `/set/${encodeURIComponent(setNumber)}`;
  if (from === DEFAULT_ORIGIN.href || !isSafeInternalPath(from)) return path;
  return `${path}?from=${encodeURIComponent(from)}`;
}
