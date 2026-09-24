/**
 * Name search. A separate file from catalogImagePort.ts on the same principle: the engine has no
 * use for search, so this is a UI-facing capability and the engine's port surface is untouched.
 *
 * The constants live here rather than in app/actions.ts because a 'use server' module may export
 * only async functions — and the client and the server have to agree on one number.
 */

export const MIN_QUERY_LENGTH = 2;
/** Clamped server-side too: the action is publicly invokable and must not forward arbitrary input. */
export const MAX_QUERY_LENGTH = 64;
export const SEARCH_PAGE_SIZE = 20;

export interface SetSearchResult {
  /** Canonical, suffix included: "75192-1". Fed straight into the existing lookup flow. */
  setNumber: string;
  name: string;
  /** Null means the source reported none — never a guess. */
  year: number | null;
  theme: string | null;
  pieces: number | null;
  imageUrl: string | null;
}

export type SetSearchFailure = 'rate_limited' | 'unconfigured' | 'unavailable';

/**
 * Discriminated on purpose. "No matches" and "we could not ask" are different answers, and only
 * one of them is ever true — an empty list must never stand in for a failure.
 */
export type SetSearchResponse =
  | { ok: true; results: SetSearchResult[] }
  | { ok: false; reason: SetSearchFailure };
