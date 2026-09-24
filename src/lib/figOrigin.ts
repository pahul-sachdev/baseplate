import {
  DEFAULT_ORIGIN,
  detailHref,
  isSafeInternalPath,
  parseOrigin,
  type Origin,
} from './origin.ts';
import { isAddressableSetNumber } from './setNumber.ts';
import { isCondition, type Condition } from './types.ts';

/**
 * Where a minifigure detail view was opened from, and how to get back there.
 *
 * The requirement is that a figure opened from a set returns to THAT set, in the state it was in.
 * The obvious implementation — `?from=/set/10236-1?from=/` — is exactly what src/lib/origin.ts
 * refuses, on purpose, with a test named after the attack. That guard is NOT relaxed and origin.ts
 * is NOT modified: it is the one file whose entire job is refusing hostile input, and rewriting it
 * to carry a breadcrumb is the wrong risk. (It is also load-bearing that every Origin has a
 * `label` — origin.test.ts reads `parseOrigin(value).label` on every rejected value.)
 *
 * Instead the chain travels in FOUR ORTHOGONAL SCALARS, each validated by the rule that fits it:
 *
 *   /minifig/sw0509?inSet=10236-1&cond=used_box&buy=300&from=%2Fretiring%3Fmonths%3D12
 *
 *   - `inSet` is a SET NUMBER, not a path. Validated by isAddressableSetNumber, and never used as
 *     an href — it is handed to detailHref(), which BUILDS and encodes the path. A value that is
 *     not a set number cannot become a redirect, because it never becomes a URL.
 *   - `cond` is narrowed by isCondition() to the Condition union, or dropped.
 *   - `buy` is Number()-parsed, bounded, and RE-SERIALISED from the parsed number — so no exponent
 *     form, no '+' and no stray text can ever reach a URL.
 *   - `from` keeps its existing meaning — the BOARD — and is parsed by the UNTOUCHED parseOrigin,
 *     so /set/… and /minifig/… are both still refused there.
 *
 * Nesting is bounded BY CONSTRUCTION rather than by a depth counter: a figure's origin is a set
 * NUMBER, a set's origin is a BOARD, and a board has no origin. The "came from" relation is a
 * strict order — board → set → figure — with no cycle and a maximum depth of two. There is nowhere
 * to put a third level.
 *
 * The set's NAME is deliberately NOT in the URL. `fallbackLabel` is "Set 10236-1"; the page
 * substitutes the cached name via src/db/originLabel.ts. The name comes from the database or it
 * does not render at all — exactly as ORIGIN_LABELS never lets the URL supply words.
 *
 * Pure and DOM-free, like origin.ts: no URL, no URLSearchParams.
 */

/** A buy price above this is not a price; it is someone testing what the parser does. */
const MAX_BUY = 10_000_000;

export type FigOrigin =
  | {
      kind: 'set';
      setNumber: string;
      /** The set's detail route with its decision state intact. Built, never echoed. */
      href: string;
      /** "Set 10236-1", until the page substitutes the cached name. NEVER from the URL. */
      fallbackLabel: string;
      /** The board the SET was opened from, so its own back link still works. */
      board: Origin;
    }
  | { kind: 'board'; href: string; label: string; board: Origin };

function first(value: string | string[] | undefined): string | undefined {
  // A repeated ?inSet=a&inSet=b arrives as an array and the intent is unknowable, so it is
  // dropped rather than guessed at — the same call parseOrigin makes.
  return Array.isArray(value) ? undefined : value;
}

/** The condition, or null. Narrowed to the union, never passed through as free text. */
export function parseCondition(raw: string | string[] | undefined): Condition | null {
  const value = first(raw);
  if (value === undefined) return null;
  return isCondition(value) ? value : null;
}

/**
 * The buy price as a canonical decimal string, or '' when there isn't a usable one.
 *
 * Re-serialised from the parsed number rather than passed through: "1e3", "+300" and " 300 " all
 * parse, and none of them should ever be what lands in the next URL.
 */
export function parseBuyRaw(raw: string | string[] | undefined): string {
  const value = first(raw);
  if (value === undefined || value.trim() === '') return '';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_BUY) return '';
  return String(parsed);
}

function withParams(path: string, params: ReadonlyArray<readonly [string, string]>): string {
  const query = params
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return query === '' ? path : `${path}?${query}`;
}

/**
 * The set href a figure should return to, built from validated parts.
 *
 * The SAME writer parseFigOrigin reads back, so the round trip is true by construction rather than
 * by two implementations happening to agree — there is an idempotence test for exactly this.
 */
export function setReturnHref(parts: {
  setNumber: string;
  from: string;
  cond: Condition | null;
  buyRaw: string;
}): string {
  // detailHref builds and encodes the path and drops an unsafe `from` itself.
  const base = detailHref(parts.setNumber, parts.from);
  const extra: Array<readonly [string, string]> = [];
  // 'sealed' is the default the set page assumes, so carrying it would only lengthen the URL.
  if (parts.cond !== null && parts.cond !== 'sealed') extra.push(['condition', parts.cond]);
  if (parts.buyRaw !== '') extra.push(['buy', parts.buyRaw]);
  if (extra.length === 0) return base;

  const joiner = base.includes('?') ? '&' : '?';
  const query = extra.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${base}${joiner}${query}`;
}

/**
 * Where a figure page should send the user back to.
 *
 * Falls back to the board whenever `inSet` is not a set number this app could have produced — so a
 * crafted value costs the user a more specific destination and never a broken or hostile link.
 */
export function parseFigOrigin(params: {
  inSet: string | string[] | undefined;
  cond: string | string[] | undefined;
  buy: string | string[] | undefined;
  from: string | string[] | undefined;
}): FigOrigin {
  const board = parseOrigin(params.from);
  const inSet = first(params.inSet)?.trim() ?? '';

  if (inSet === '' || !isAddressableSetNumber(inSet)) {
    return { kind: 'board', href: board.href, label: board.label, board };
  }

  const cond = parseCondition(params.cond);
  const buyRaw = parseBuyRaw(params.buy);

  return {
    kind: 'set',
    setNumber: inSet,
    href: setReturnHref({ setNumber: inSet, from: board.href, cond, buyRaw }),
    // A number that already passed isAddressableSetNumber, rendered as text by React. The URL can
    // supply a number; it can never supply a word.
    fallbackLabel: `Set ${inSet}`,
    board,
  };
}

/**
 * The link a figure row or card points at.
 *
 * Mirrors detailHref, including dropping values it cannot use rather than encoding them: a URL
 * carrying a rejected value only invites someone to trust it.
 */
export function figHref(
  minifigNumber: string,
  opts: { inSet?: string | null; cond?: Condition | null; buyRaw?: string; from?: string },
): string {
  const path = `/minifig/${encodeURIComponent(minifigNumber)}`;

  const inSet = opts.inSet ?? '';
  const from = opts.from ?? DEFAULT_ORIGIN.href;
  const cond = opts.cond ?? null;
  const buyRaw = opts.buyRaw ?? '';

  // Carried only if parseOrigin would actually ACCEPT it, not merely if it is a safe path.
  // "/set/10236-1" is a perfectly safe internal path and still not a valid origin, so encoding it
  // would put a value in the URL that the destination is guaranteed to throw away — and a URL
  // carrying a rejected value only invites someone to trust it. Same principle as detailHref,
  // applied one notch tighter because this route has two path-shaped parameters, not one.
  const board = parseOrigin(from);
  const carriesBoard = from !== DEFAULT_ORIGIN.href && isSafeInternalPath(from) && board.href === from;

  return withParams(path, [
    ['inSet', isAddressableSetNumber(inSet) ? inSet : ''],
    ['cond', cond !== null && cond !== 'sealed' ? cond : ''],
    ['buy', parseBuyRaw(buyRaw)],
    // Lookup is where parseOrigin lands with nothing set, so the commonest link stays clean.
    ['from', carriesBoard ? from : ''],
  ]);
}
