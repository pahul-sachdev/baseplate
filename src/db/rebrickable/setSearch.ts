import { searchKey } from '../../lib/setNumber.ts';
import { MIN_QUERY_LENGTH, type SetSearchResult } from '../../lib/setSearchPort.ts';
import { systemClock } from '../clock.ts';
import {
  fetchThemes,
  searchSetsRaw,
  type RebrickableSetRow,
  type RebrickableTheme,
  type SearchOptions,
} from './client.ts';

/**
 * The single door to Rebrickable set search.
 *
 * Search costs Rebrickable requests and nothing else — this module imports no BrickEconomy code
 * and no Prisma client, so no amount of typing can reach the metered valuation API. That request
 * is still spent only by submitting the lookup form.
 *
 * Two layers of protection, cheapest first:
 *   1. a day-keyed promise memo — identical queries never refetch, including concurrent ones
 *   2. a process-wide theme index — the id→name map is fetched once, not once per search
 */

const MAX_CACHE_ENTRIES = 200;

/**
 * Keyed by `day|normalisedQuery`, holding the in-flight promise so concurrent callers share one
 * call — the same idiom as the BrickEconomy memo in ./source.ts, for the same reason.
 *
 * Day-keyed because a long-lived server must not serve yesterday's catalogue forever, and
 * size-capped because the key space here is whatever anyone types.
 */
const cache = new Map<string, Promise<SetSearchResult[]>>();

type ThemeIndex = Map<number, string>;

let themeIndex: Promise<ThemeIndex> | null = null;

/**
 * Tests only. Both memos are module-level, and node:test shares a module across the cases in a
 * file, so without this one case's cached query would decide the next case's result.
 */
export function resetSearchCaches(): void {
  cache.clear();
  themeIndex = null;
}

/**
 * The theme list, fetched at most once per process.
 *
 * On failure this resolves to an EMPTY index rather than rejecting, and is never retried: every
 * later search then shows theme: null, which is the honest answer. Retrying would burn throttle
 * slots the actual search needs, and a decorative label is not worth risking the documented ban.
 */
function loadThemeIndex(options: SearchOptions): Promise<ThemeIndex> {
  const existing = themeIndex;
  if (existing !== null) return existing;

  const pending = fetchThemes(options).then(buildThemeIndex, () => new Map<number, string>());
  themeIndex = pending;
  return pending;
}

function buildThemeIndex(themes: RebrickableTheme[]): ThemeIndex {
  const names = new Map<number, string>();
  const parents = new Map<number, number | null>();
  for (const theme of themes) {
    names.set(theme.id, theme.name);
    parents.set(theme.id, theme.parentId);
  }

  const labels: ThemeIndex = new Map();
  for (const theme of themes) labels.set(theme.id, themeLabel(theme, names, parents));
  return labels;
}

/**
 * Leaf name, prefixed with its root only when the root adds information: "Star Wars Episode
 * 4/5/6" already says Star Wars, while "Ultimate Collector Series" alone does not.
 */
function themeLabel(
  theme: RebrickableTheme,
  names: Map<number, string>,
  parents: Map<number, number | null>,
): string {
  let rootId = theme.id;
  // A cycle in the data must not hang a request.
  const seen = new Set<number>([rootId]);
  for (;;) {
    const parentId = parents.get(rootId) ?? null;
    if (parentId === null || seen.has(parentId)) break;
    seen.add(parentId);
    rootId = parentId;
  }

  const root = names.get(rootId);
  if (root === undefined || rootId === theme.id) return theme.name;
  return theme.name.toLowerCase().includes(root.toLowerCase())
    ? theme.name
    : `${root} · ${theme.name}`;
}

function toResult(row: RebrickableSetRow, themes: ThemeIndex): SetSearchResult {
  return {
    setNumber: row.setNumber,
    name: row.name,
    year: row.year,
    // An id we never received resolves to null. Guessing a theme name would be inventing data.
    theme: row.themeId === null ? null : (themes.get(row.themeId) ?? null),
    pieces: row.pieces,
    imageUrl: row.imageUrl,
  };
}

/**
 * Breaks ties in Rebrickable's relevance order; never overrides it and never filters. Rows that
 * score equally keep the order the source returned them in, enforced by the index tie-break
 * rather than by trusting the sort to be stable.
 *
 * The piece-count tie-break is an observed field, not a popularity guess: between two sets both
 * literally named "Millennium Falcon", the 7541-piece one is what someone typing that means.
 */
export function rankSearchResults(query: string, results: SetSearchResult[]): SetSearchResult[] {
  const key = searchKey(query);

  const score = (result: SetSearchResult): number => {
    const name = searchKey(result.name);
    if (name === key) return 3;
    if (name.startsWith(key)) return 2;
    if (name.includes(key)) return 1;
    return 0;
  };

  return results
    .map((result, index) => ({ result, index, score: score(result) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.result.pieces ?? 0) - (a.result.pieces ?? 0) ||
        (b.result.year ?? 0) - (a.result.year ?? 0) ||
        a.index - b.index,
    )
    .map((entry) => entry.result);
}

async function load(query: string, options: SearchOptions): Promise<SetSearchResult[]> {
  const rows = await searchSetsRaw(query, options);
  // A query with no matches must not cost a second throttled request.
  if (rows.length === 0) return [];

  const themes = await loadThemeIndex(options);
  return rankSearchResults(
    query,
    rows.map((row) => toResult(row, themes)),
  );
}

/** Matching sets for a free-text query, fetching at most once per distinct query per day. */
export function searchSets(
  query: string,
  options: SearchOptions = {},
): Promise<SetSearchResult[]> {
  const key = searchKey(query);
  if (key.length < MIN_QUERY_LENGTH) return Promise.resolve([]);

  const cacheKey = `${systemClock.today()}|${key}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  // Rejections are evicted so a failure stays retryable: a 429 at 10:00 must not silence search
  // for the rest of the day.
  const pending = load(key, options).catch((error: unknown) => {
    cache.delete(cacheKey);
    throw error;
  });
  cache.set(cacheKey, pending);
  evictOldest();
  return pending;
}

function evictOldest(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next(); // Map iterates in insertion order.
    if (oldest.done === true) return;
    cache.delete(oldest.value);
  }
}
