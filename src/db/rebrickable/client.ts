import { recordRequest } from '../apiLog.ts';
import type { CatalogImage } from '../../lib/catalogImagePort.ts';
import { withVariantSuffix } from '../../lib/setNumber.ts';
import { SEARCH_PAGE_SIZE } from '../../lib/setSearchPort.ts';

/**
 * Rebrickable, read-only. Only /lego/ GETs are ever issued — nothing touches /users/.
 *
 * Rebrickable allows roughly one request per second and bans IPs that ignore 429s, so this
 * module is built around never bursting: a single global queue serialises every call with a
 * minimum gap, and a 429 stops the queue rather than retrying into a ban.
 *
 * Every Rebrickable endpoint the app uses must live in this file. throttle() is module-private,
 * so a fetch added anywhere else would silently bypass the rate limit that keeps this IP alive.
 */

const BASE_URL = 'https://rebrickable.com/api/v3';
const MIN_GAP_MS = 1100; // a little over 1/sec, deliberately conservative
const TIMEOUT_MS = 15_000;
// One page covers the whole theme list (~460 rows), so the id→name map costs a single request.
const THEMES_PAGE_SIZE = 1000;

/** Re-exported so the one caller and the search box keep sharing a single suffix rule. */
export { withVariantSuffix };

export class RebrickableRateLimitError extends Error {
  constructor() {
    super('Rebrickable rate limit hit — stopping rather than retrying, to avoid an IP ban');
    this.name = 'RebrickableRateLimitError';
  }
}

export class RebrickableAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RebrickableAuthError';
  }
}

/**
 * Serialises every request process-wide and enforces the gap. Concurrent callers queue rather
 * than run in parallel, which is the whole point — a "refresh all" must never burst.
 */
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function throttle<T>(task: () => Promise<T>, minGapMs: number = MIN_GAP_MS): Promise<T> {
  const run = queue.then(async () => {
    const wait = minGapMs - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return task();
  });
  // Keep the chain alive even if this task rejects, so one failure doesn't wedge the queue.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface RebrickableSet {
  set_num?: string;
  name?: string;
  year?: number;
  theme_id?: number;
  num_parts?: number;
  set_img_url?: string | null;
}

export interface FetchImageOptions {
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface SearchOptions extends FetchImageOptions {
  /** Tests only. Without it the real 1100ms gap would dominate a suite of stubbed calls. */
  minGapMs?: number;
}

interface Resolved {
  apiKey: string;
  fetchImpl: typeof fetch;
  baseUrl: string;
}

/** Throws before any request is made, so a missing key never costs a queue slot's worth of wait. */
function resolve(options: FetchImageOptions): Resolved {
  const apiKey = options.apiKey ?? process.env['REBRICKABLE_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new RebrickableAuthError('REBRICKABLE_API_KEY is not set in .env');
  }
  return {
    apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: options.baseUrl ?? BASE_URL,
  };
}

/**
 * One throttled GET. Returns imageUrl: null when the set exists but has no artwork, and also
 * when the set is unknown — both are "no image", and neither is worth failing a page over.
 */
export function fetchSetImage(
  setNumber: string,
  options: FetchImageOptions = {},
): Promise<CatalogImage> {
  return throttle(async () => {
    const { apiKey, fetchImpl, baseUrl } = resolve(options);
    const setNum = withVariantSuffix(setNumber);
    const empty: CatalogImage = {
      setNumber,
      imageUrl: null,
      name: null,
      year: null,
      theme: null,
    };

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/lego/sets/${encodeURIComponent(setNum)}/`, {
        headers: {
          Accept: 'application/json',
          // Literal "key " prefix — Rebrickable rejects a bare token.
          Authorization: `key ${apiKey}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      recordRequest({ provider: 'rebrickable', setNumber, status: null });
      return empty;
    }

    recordRequest({ provider: 'rebrickable', setNumber, status: response.status });

    if (response.status === 429) throw new RebrickableRateLimitError();
    if (response.status === 401 || response.status === 403) {
      throw new RebrickableAuthError('Rebrickable rejected REBRICKABLE_API_KEY');
    }
    // 404 and anything else: no image. Never fatal — a missing photo is a placeholder.
    if (!response.ok) return empty;

    let data: RebrickableSet;
    try {
      data = (await response.json()) as RebrickableSet;
    } catch {
      return empty;
    }

    return {
      setNumber,
      imageUrl: data.set_img_url ?? null,
      name: data.name ?? null,
      year: data.year ?? null,
      theme: data.theme_id === undefined ? null : String(data.theme_id),
    };
  });
}

/**
 * One throttled GET whose failures are all fatal.
 *
 * Deliberately unlike fetchSetImage, which answers "no image" for an unknown set: a missing photo
 * is a placeholder, but a failed search is not an empty result set. Returning [] here would tell
 * the user "no matches" when the truth is "we never got to ask".
 */
async function getJson(
  path: string,
  params: Record<string, string>,
  options: SearchOptions,
): Promise<unknown> {
  const { apiKey, fetchImpl, baseUrl } = resolve(options);
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        Accept: 'application/json',
        // Literal "key " prefix — Rebrickable rejects a bare token.
        Authorization: `key ${apiKey}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    // setNumber is null: a list request is not about one set. The quota meter counts rows, so it
    // stays exact either way.
    recordRequest({ provider: 'rebrickable', setNumber: null, status: null });
    throw new Error(`Could not reach Rebrickable: ${String(cause)}`);
  }

  recordRequest({ provider: 'rebrickable', setNumber: null, status: response.status });

  if (response.status === 429) throw new RebrickableRateLimitError();
  if (response.status === 401 || response.status === 403) {
    throw new RebrickableAuthError('Rebrickable rejected REBRICKABLE_API_KEY');
  }
  if (!response.ok) throw new Error(`Rebrickable request failed (HTTP ${response.status})`);

  try {
    return await response.json();
  } catch {
    throw new Error('Rebrickable returned a non-JSON response');
  }
}

/** The results array of a paginated list response, or [] when the shape is not what we expect. */
function listResults(page: unknown): unknown[] {
  const results = (page as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results : [];
}

export interface RebrickableSetRow {
  setNumber: string;
  name: string;
  year: number | null;
  themeId: number | null;
  pieces: number | null;
  imageUrl: string | null;
}

/** Null for a row too malformed to name a set. Absent fields become null, never 0 or "". */
function toSetRow(entry: unknown): RebrickableSetRow | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const row = entry as RebrickableSet;
  if (typeof row.set_num !== 'string' || row.set_num === '') return null;
  if (typeof row.name !== 'string' || row.name === '') return null;

  return {
    setNumber: row.set_num,
    name: row.name,
    year: typeof row.year === 'number' ? row.year : null,
    themeId: typeof row.theme_id === 'number' ? row.theme_id : null,
    pieces: typeof row.num_parts === 'number' ? row.num_parts : null,
    imageUrl: typeof row.set_img_url === 'string' && row.set_img_url !== '' ? row.set_img_url : null,
  };
}

/**
 * Free-text set search. One throttled request, sharing the queue with fetchSetImage so a user
 * typing while artwork loads still cannot burst.
 *
 * Ordering is left to Rebrickable's own relevance ranking; the local tie-break lives in
 * setSearch.ts, where the whole payload is in hand.
 */
export function searchSetsRaw(
  query: string,
  options: SearchOptions = {},
): Promise<RebrickableSetRow[]> {
  return throttle(async () => {
    const page = await getJson(
      '/lego/sets/',
      { search: query, page_size: String(SEARCH_PAGE_SIZE) },
      options,
    );
    return listResults(page)
      .map(toSetRow)
      .filter((row): row is RebrickableSetRow => row !== null);
  }, options.minGapMs);
}

export interface RebrickableTheme {
  id: number;
  name: string;
  parentId: number | null;
}

/**
 * The whole theme list in one request, so search results can show a theme name instead of the
 * numeric theme_id the sets endpoint returns.
 *
 * `next` is deliberately not followed. A decorative label is not worth a second throttled slot,
 * and an id we did not receive resolves to null rather than to a guess.
 */
export function fetchThemes(options: SearchOptions = {}): Promise<RebrickableTheme[]> {
  return throttle(async () => {
    const page = await getJson('/lego/themes/', { page_size: String(THEMES_PAGE_SIZE) }, options);
    const themes: RebrickableTheme[] = [];

    for (const entry of listResults(page)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as { id?: unknown; name?: unknown; parent_id?: unknown };
      if (typeof row.id !== 'number' || typeof row.name !== 'string' || row.name === '') continue;
      themes.push({
        id: row.id,
        name: row.name,
        parentId: typeof row.parent_id === 'number' ? row.parent_id : null,
      });
    }

    return themes;
  }, options.minGapMs);
}
