import { recordRequest } from '../apiLog.ts';
import {
  BricksetAuthError,
  BricksetError,
  BricksetLimitError,
  type BricksetKeyUsageResponse,
  type BricksetSetPayload,
  type BricksetSetsResponse,
} from './types.ts';

/**
 * Brickset, read-only. Only getSets and getKeyUsageStats are ever issued — nothing touches
 * login/userHash, the collection endpoints, or any set* write method.
 *
 * Two measured facts drive this module, neither of which is in the public docs:
 *
 *  1. `userHash` is a REQUIRED query parameter even when empty. The endpoint is a .NET ASMX
 *     service, whose HTTP-GET binding demands every declared parameter; omit it and the server
 *     answers 200 with an empty body rather than an error. Verified: the same request with and
 *     without it returns JSON / nothing respectively.
 *  2. A spent allowance is reported as HTTP 200 with {"status":"error","message":"API limit
 *     exceeded"}, so the JSON status must be checked — HTTP status alone will not see it.
 *
 * Only getSets counts against Brickset usage, so getKeyUsageStats can be called freely to
 * report real numbers instead of guessing.
 */

const BASE_URL = 'https://brickset.com/api/v3.asmx';
const TIMEOUT_MS = 20_000;

export interface FetchOptions {
  apiKey?: string | undefined;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** The JSON object sent as the `params` string. All keys optional, per the API. */
export interface GetSetsParams {
  year?: string;
  theme?: string;
  /** "YYYY-MM-DD" — verified accepted; matches the app's day-key shape exactly. */
  updatedSince?: string;
  pageSize?: number;
  pageNumber?: number;
  /** Only for stable pagination. Brickset has no exit-date sort; ranking happens locally. */
  orderBy?: string;
}

export interface GetSetsResult {
  /** Total matches for the QUERY, not this page. Pagination is driven off it. */
  matches: number;
  sets: BricksetSetPayload[];
}

export interface KeyUsage {
  /** UTC day stamp as Brickset reports it, e.g. "2026-07-29". */
  day: string;
  count: number;
}

function resolveKey(options: FetchOptions): string {
  const apiKey = options.apiKey ?? process.env['BRICKSET_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new BricksetAuthError('BRICKSET_API_KEY is not set in .env');
  }
  return apiKey;
}

/**
 * One GET. `userHash` is always sent — see the note at the top of this file; an omitted one
 * produces an empty body that is indistinguishable from an outage.
 *
 * `meter` decides whether the attempt reaches the ApiRequest log. Only getSets sets it, because
 * only getSets counts against Brickset's allowance — verified by calling getKeyUsageStats either
 * side of a run and watching only the getSets calls appear in Brickset's own tally. Logging the
 * free call would make our meter claim more spend than Brickset itself records, and mirroring
 * that number is the entire point of the meter.
 */
async function request(
  method: 'getSets' | 'getKeyUsageStats',
  query: Record<string, string>,
  options: FetchOptions,
  meter: boolean,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  const search = new URLSearchParams({ ...query, userHash: '' });
  const url = `${baseUrl}/${method}?${search.toString()}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'lego-flip-tool/0.1' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    if (meter) recordRequest({ provider: 'brickset', setNumber: null, status: null });
    throw new BricksetError(
      `Could not reach Brickset: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // Logged per attempt, so the meter counts rejected requests too.
  if (meter) recordRequest({ provider: 'brickset', setNumber: null, status: response.status });

  const body = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new BricksetAuthError('Brickset rejected BRICKSET_API_KEY', response.status);
  }
  if (!response.ok) {
    throw new BricksetError(
      `Brickset request failed (HTTP ${response.status}): ${body.slice(0, 120).replace(/\s+/g, ' ').trim()}`,
      response.status,
    );
  }
  if (body.trim() === '') {
    // The signature of a malformed request — a missing parameter, most likely userHash.
    throw new BricksetError(`Brickset returned an empty body for ${method}`, response.status);
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new BricksetError(
      `Brickset returned a non-JSON body for ${method}: ${body.slice(0, 120)}`,
      response.status,
    );
  }
}

/**
 * Turns a non-"success" JSON status into a typed error. The allowance case is singled out
 * because callers recover from it by serving cache, while everything else is a real fault.
 */
function assertSuccess(status: string | undefined, message: string | undefined): void {
  if (status === 'success') return;

  const detail = message ?? 'no message';
  if (/limit exceeded/i.test(detail)) {
    throw new BricksetLimitError(`Brickset API limit exceeded — ${detail}`);
  }
  if (/invalid (api )?key|api ?key/i.test(detail)) {
    throw new BricksetAuthError(`Brickset rejected BRICKSET_API_KEY — ${detail}`);
  }
  throw new BricksetError(`Brickset returned status "${status ?? 'missing'}": ${detail}`);
}

/** One page of the catalogue. THE ONLY CALL THAT COUNTS AGAINST BRICKSET USAGE. */
export async function getSets(
  params: GetSetsParams,
  options: FetchOptions = {},
): Promise<GetSetsResult> {
  const parsed = (await request(
    'getSets',
    { apiKey: resolveKey(options), params: JSON.stringify(params) },
    options,
    true,
  )) as BricksetSetsResponse;

  assertSuccess(parsed.status, parsed.message);

  return {
    matches: typeof parsed.matches === 'number' ? parsed.matches : 0,
    sets: Array.isArray(parsed.sets) ? parsed.sets : [],
  };
}

/**
 * Brickset's own view of what this key has spent, per day, for the last 30 days.
 *
 * Free — it does not count against usage, verified by calling it either side of a getSets run
 * and watching only the getSets calls appear in Brickset's own tally. Deliberately NOT metered
 * locally either, so our count stays equal to Brickset's rather than drifting one higher per sync.
 *
 * Note it reports USAGE ONLY: there is no limit anywhere in the response, which is why nothing in
 * this app displays a Brickset denominator.
 */
export async function getKeyUsageStats(options: FetchOptions = {}): Promise<KeyUsage[]> {
  const parsed = (await request(
    'getKeyUsageStats',
    { apiKey: resolveKey(options) },
    options,
    false,
  )) as BricksetKeyUsageResponse;

  assertSuccess(parsed.status, parsed.message);

  const rows = Array.isArray(parsed.apiKeyUsage) ? parsed.apiKeyUsage : [];
  return rows.flatMap((row) => {
    // dateStamp arrives as a UTC instant; only the day part is meaningful.
    const day = typeof row.dateStamp === 'string' ? row.dateStamp.slice(0, 10) : null;
    if (day === null || day === '') return [];
    return [{ day, count: typeof row.count === 'number' ? row.count : 0 }];
  });
}
