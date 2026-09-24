'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  isLookupSortKey,
  LOOKUP_SORT_OPTIONS,
  sortPreviews,
  type LookupSortKey,
} from '../../src/lib/lookupView.ts';
import { figHref } from '../../src/lib/figOrigin.ts';
import { looksLikeMinifigNumber } from '../../src/lib/minifigNumber.ts';
import type { MinifigPreview } from '../../src/lib/minifigPreview.ts';
import { looksLikeSetNumber, searchKey } from '../../src/lib/setNumber.ts';
import { catalogHintFrom, type SetPreview } from '../../src/lib/setPreview.ts';
import { MIN_QUERY_LENGTH, type SetSearchFailure } from '../../src/lib/setSearchPort.ts';
import { refreshPreviewAction, searchPreviewsAction, valueSetAction } from '../actions.ts';
import { searchMinifigsAction } from '../minifig/actions.ts';
import { MinifigRow } from './MinifigRow.tsx';
import { SetPreviewCard } from './SetPreviewCard.tsx';

/**
 * Lookup: find a set, look at it, then decide whether to pay for a verdict.
 *
 * Searching returns a grid of preview cards built entirely from data the app already has, so
 * browsing five Falcons costs nothing. Each card values itself only when its own button is
 * clicked. Nothing renders until the user types — this is a lookup tool, not a discovery feed.
 *
 * The control beside the search box sorts; it does not filter. It used to select a condition, and
 * because the read model filtered on condition, changing it blanked cards that had perfectly good
 * numbers on disk. Sorting runs over previews already in this component's state: no server round
 * trip, no request, and a card can never lose its data by being reordered.
 *
 * State that belongs to a SET rather than to a card lives here: the preview itself, and whether a
 * request is in flight for it. The buy price and the chosen condition used to live here too, for a
 * detail dialog this component owned. That dialog is now the /set/[setNumber] route, which owns
 * them itself — they describe a decision about one set, not the state of a grid.
 *
 * `?q=` and `?sort=` are mirrored into the URL so that opening a card and coming back restores the
 * search. The results themselves come back from `sessionCache`, which is module scope and survives
 * the round trip; the URL alone never triggers a search.
 *
 * Imports nothing from src/ but pure modules: src/composition.ts value-imports Prisma, so
 * MOCK_BACKED_STRATEGIES arrives as a prop from the page.
 */

const DEBOUNCE_MS = 400;
const COOLDOWN_MS = 60_000;

/**
 * Module scope on purpose: the per-session search cache. It outlives remounts and route changes
 * within the tab, so retyping a query someone already ran spends nothing.
 */
const sessionCache = new Map<string, SetPreview[]>();

/**
 * Sets valued during this session, keyed by set number.
 *
 * The search cache above holds each query's results as they were when the search ran, so retyping
 * an earlier query would resurrect a card as "not valued yet" seconds after it was valued. Quota is
 * safe — the engine is cache-first — but the screen would be lying, and the button would offer to
 * spend a request for numbers already on disk.
 */
const valuedThisSession = new Map<string, SetPreview>();

/** Rebrickable bans IPs that ignore 429s, so a rate limit pauses search instead of retrying. */
let cooldownUntil = 0;

/** A missing or rejected API key cannot be fixed by typing more: stop asking after the first no. */
let searchDisabled = false;

type Board =
  | { kind: 'idle' }
  | { kind: 'results'; previews: SetPreview[] }
  | { kind: 'empty'; query: string }
  | { kind: 'notice'; message: string };

/** Sets the module-level brakes as a side effect — a failure has to change future behaviour. */
function handleFailure(reason: SetSearchFailure): string {
  if (reason === 'rate_limited') {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    return 'Search paused — Rebrickable rate limit. Type the set number directly.';
  }
  if (reason === 'unconfigured') {
    searchDisabled = true;
    return 'Name search unavailable — REBRICKABLE_API_KEY is not set. Enter a set number.';
  }
  return 'Search unavailable — enter a set number.';
}

/** Applies anything valued this session over a cached search result. */
function withSessionValues(previews: SetPreview[]): SetPreview[] {
  return previews.map((preview) => valuedThisSession.get(preview.meta.setNumber) ?? preview);
}


export function LookupBoard({
  initialQuery,
  initialSort,
  initialPreviews,
  mockStrategies,
  today,
}: {
  initialQuery: string;
  initialSort: LookupSortKey;
  initialPreviews: SetPreview[];
  mockStrategies: readonly string[];
  today: string;
}) {
  /**
   * False until the user types. This is what stops a page load from searching: arriving on
   * /?q=falcon fills the box and waits, and asks Rebrickable nothing.
   */
  const touched = useRef(false);
  const seq = useRef(0);

  const [query, setQuery] = useState(initialQuery);
  const [sortKey, setSortKey] = useState<LookupSortKey>(initialSort);
  const [board, setBoard] = useState<Board>(
    initialPreviews.length === 0 ? { kind: 'idle' } : { kind: 'results', previews: initialPreviews },
  );
  const [pending, setPending] = useState(false);

  /**
   * Bumped by "Run this search", and nothing else.
   *
   * A cold `?q=` URL fills the box without searching, so there has to be a way to ask for the
   * search that does not involve editing the text. Re-setting `query` to its own value cannot do
   * it — React bails out of an identical state write and the effect would not re-run.
   */
  const [runToken, setRunToken] = useState(0);

  /** Per-set: an in-flight request and an error. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  /**
   * Minifigure hits, in their own labelled section.
   *
   * Deliberately NOT merged into the sorted grid. The sort keys are all set-shaped — sealed price,
   * used price, pieces, year — and a figure has none of them, so merging would mean either
   * inventing values to sort by or teaching every comparator a second null case. A separate
   * section also tells the truth about what this list is: an exact-number lookup, or a search over
   * figures already on disk. There is no figure name search to offer, in either id space.
   */
  const [minifigs, setMinifigs] = useState<MinifigPreview[]>([]);

  /**
   * Restore a previous search when returning from the detail route.
   *
   * A mount effect, NOT a useState initializer and not a read during render. The server renders an
   * empty grid for a `?q=` it will not search, so filling the board during the first client render
   * would make the two disagree and hydration would tear. Running after mount is the only correct
   * placement, and it costs nothing: sessionCache is a plain Map in module scope that outlives the
   * route change, so the results are already in memory.
   *
   * A cache miss stays idle on purpose. `touched` is still false, so this cannot search — a cold
   * URL waits for the explicit button rather than spending a Rebrickable request on a page load.
   */
  useEffect(() => {
    const key = searchKey(initialQuery);
    if (key === '') return;

    const cached = sessionCache.get(key);
    if (cached === undefined) return;

    setBoard((prev) =>
      prev.kind === 'idle'
        ? cached.length === 0
          ? { kind: 'empty', query: key }
          : { kind: 'results', previews: withSessionValues(cached) }
        : prev,
    );
    // Mount only: a later `initialQuery` change is a fresh server render, which seeds state anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Mirror the query and sort into the URL, so leaving for a set's detail view and coming back
   * lands on the same search. Same technique and the same reasons as RetiringBoard: replaceState
   * so keystrokes do not bury the back button, and no router navigation because the results are
   * already here.
   *
   * Writing the URL never triggers a search — `touched` gates that, and this does not touch it.
   */
  useEffect(() => {
    const params = new URLSearchParams();
    const key = searchKey(query);
    if (key !== '') params.set('q', key);
    if (sortKey !== 'relevance') params.set('sort', sortKey);
    const qs = params.toString();
    window.history.replaceState(null, '', qs === '' ? window.location.pathname : `?${qs}`);
  }, [query, sortKey]);

  useEffect(() => {
    if (!touched.current) return; // a page load, not a keystroke

    const key = searchKey(query);
    if (key.length < MIN_QUERY_LENGTH) {
      setBoard({ kind: 'idle' });
      setMinifigs([]);
      setPending(false);
      return;
    }

    // Free by construction — searchMinifigsAction cannot reach a provider — so it runs regardless
    // of the cooldown and disabled brakes below, which exist only to protect Rebrickable.
    void searchMinifigsAction(key).then(setMinifigs, () => setMinifigs([]));

    /**
     * A figure number is never a set. Letting it fall through would spend a Rebrickable request
     * searching for "sw0509" among sets, to be told what we already know.
     */
    if (looksLikeMinifigNumber(key)) {
      setBoard({ kind: 'results', previews: [] });
      setPending(false);
      return;
    }

    const cached = sessionCache.get(key);
    if (cached !== undefined) {
      setBoard(
        cached.length === 0
          ? { kind: 'empty', query: key }
          : { kind: 'results', previews: withSessionValues(cached) },
      );
      setPending(false);
      return;
    }

    // A set number never reaches Rebrickable, so the disabled and cooldown brakes do not apply.
    const isNumber = looksLikeSetNumber(key);
    if (!isNumber && searchDisabled) return;

    setPending(true);
    const timer = setTimeout(() => {
      if (!isNumber && Date.now() < cooldownUntil) {
        setPending(false);
        setBoard({
          kind: 'notice',
          message: 'Search paused — Rebrickable rate limit. Type the set number directly.',
        });
        return;
      }

      const ticket = seq.current + 1;
      seq.current = ticket;

      void searchPreviewsAction(key).then(
        (response) => {
          // A Server Action POST cannot be aborted, so a slower earlier response would otherwise
          // overwrite a newer one. The ticket is the only defence.
          if (ticket !== seq.current) return;
          setPending(false);

          if (!response.ok) {
            setBoard({ kind: 'notice', message: handleFailure(response.reason) });
            return;
          }
          sessionCache.set(key, response.previews);
          setBoard(
            response.previews.length === 0
              ? { kind: 'empty', query: key }
              : { kind: 'results', previews: withSessionValues(response.previews) },
          );
        },
        () => {
          if (ticket !== seq.current) return;
          setPending(false);
          setBoard({ kind: 'notice', message: 'Search unavailable — enter a set number.' });
        },
      );
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // sortKey is deliberately absent: sorting must never re-enter the search path, or changing it
    // on a URL-seeded query (which never populates sessionCache) would spend a Rebrickable request.
  }, [query, runToken]);

  const previews = board.kind === 'results' ? board.previews : [];
  const sorted = useMemo(() => sortPreviews(previews, sortKey), [previews, sortKey]);

  /**
   * This board's own URL, handed to every card so the detail view can come back to this search.
   *
   * Built from the same two values the effect above mirrors, so the back link and the address bar
   * can never disagree — and built here rather than read from window.location, which does not
   * exist during the server render.
   */
  const from = useMemo(() => {
    const params = new URLSearchParams();
    const key = searchKey(query);
    if (key !== '') params.set('q', key);
    if (sortKey !== 'relevance') params.set('sort', sortKey);
    const qs = params.toString();
    return qs === '' ? '/' : `/?${qs}`;
  }, [query, sortKey]);

  /** Swaps one card in place, wherever it currently sits. Functional, so two clicks cannot race. */
  function applyPreview(next: SetPreview): void {
    valuedThisSession.set(next.meta.setNumber, next);
    setBoard((prev) =>
      prev.kind === 'results'
        ? {
            kind: 'results',
            previews: prev.previews.map((preview) =>
              preview.meta.setNumber === next.meta.setNumber ? next : preview,
            ),
          }
        : prev,
    );
  }

  function setFlag<T>(
    update: (next: (prev: ReadonlyMap<string, T>) => ReadonlyMap<string, T>) => void,
    setNumber: string,
    value: T | null,
  ): void {
    update((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(setNumber);
      else next.set(setNumber, value);
      return next;
    });
  }

  /** The only two paths in this component that may spend a BrickEconomy request. */
  async function run(preview: SetPreview, action: 'value' | 'refresh'): Promise<void> {
    const setNumber = preview.meta.setNumber;
    if (busy.has(setNumber)) return; // the card and the dialog both offer these buttons
    if (
      action === 'refresh' &&
      !window.confirm(`Refresh ${setNumber}? This spends up to 1 BrickEconomy request.`)
    ) {
      return;
    }

    setBusy((prev) => new Set(prev).add(setNumber));
    setFlag(setErrors, setNumber, null);

    const hint = catalogHintFrom(preview);
    const result =
      action === 'value'
        ? await valueSetAction(setNumber, hint)
        : await refreshPreviewAction(setNumber, hint);

    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(setNumber);
      return next;
    });

    if (result.ok) applyPreview(result.preview);
    else setFlag(setErrors, setNumber, result.message);
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Lookup</h1>
        <p className="mt-1 text-sm text-muted">
          Search by name or set number. Previews are free — a BrickEconomy request is spent only
          when you value a specific set.
        </p>
      </section>

      <div className="grid gap-3 rounded-xl border border-border bg-surface p-4 sm:grid-cols-[1fr_auto]">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Set number or name</span>
          <input
            value={query}
            onChange={(event) => {
              touched.current = true;
              setQuery(event.target.value);
            }}
            placeholder="10236-1 or ewok village"
            autoComplete="off"
            className="tabular w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors duration-150 focus:border-accent"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-muted">Sort</span>
          <select
            value={sortKey}
            onChange={(event) => {
              const next = event.target.value;
              // Pure client-side reordering of cards already on screen. No request, ever.
              if (isLookupSortKey(next)) setSortKey(next);
            }}
            className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors duration-150 focus:border-accent sm:w-52"
          >
            {LOOKUP_SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key} title={option.hint}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {board.kind === 'notice' ? (
        <p className="flex gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          <span aria-hidden="true">!</span>
          <span>{board.message}</span>
        </p>
      ) : null}

      {pending ? <p className="text-xs text-muted">Searching…</p> : null}

      {board.kind === 'idle' && !pending ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          {searchKey(query).length >= MIN_QUERY_LENGTH ? (
            // A shared or bookmarked ?q= URL opened in a fresh tab: the box is filled but nothing
            // has been searched, because a page load must never spend a request. Clicking is the
            // explicit act that may.
            <div className="space-y-3">
              <p>
                “{searchKey(query)}” is ready to search. Nothing has been fetched yet — running it{' '}
                {/* A number of either kind resolves out of the local cache. Saying "1 request"
                    for those overstated the cost, which is its own small dishonesty. */}
                {looksLikeSetNumber(searchKey(query)) || looksLikeMinifigNumber(searchKey(query))
                  ? 'costs nothing: that is a number, so it resolves from what is already on disk.'
                  : 'spends 1 Rebrickable request.'}
              </p>
              <button
                type="button"
                onClick={() => {
                  touched.current = true;
                  // A counter, not a re-set of `query`: writing the same string back is a bail-out
                  // in React, so the search effect would never re-run and the button would appear
                  // to do nothing.
                  setRunToken((token) => token + 1);
                }}
                className="cursor-pointer rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-colors duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Run this search
              </button>
            </div>
          ) : (
            <p>Search for a set to see it. Looking costs nothing.</p>
          )}
        </div>
      ) : null}

      {board.kind === 'empty' ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          No sets match “{board.query}”.
        </p>
      ) : null}

      {minifigs.length === 0 ? null : (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Minifigures</h2>
            <p className="text-xs text-muted">
              {looksLikeMinifigNumber(searchKey(query))
                ? 'Looked up by number — free, and it spends nothing until you value it.'
                : 'Minifigures you have already valued, matched by name. There is no minifigure name search to offer: BrickEconomy publishes none, and Rebrickable’s catalogue uses a different numbering system with no published mapping to BrickEconomy’s.'}
            </p>
          </div>
          <div className="space-y-2">
            {minifigs.map((preview) => (
              <MinifigRow
                key={preview.minifigNumber}
                preview={preview}
                href={figHref(preview.minifigNumber, { from })}
              />
            ))}
          </div>
        </section>
      )}

      {board.kind === 'results' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((preview) => {
            const setNumber = preview.meta.setNumber;
            const message = errors.get(setNumber);
            return (
              <div key={setNumber} className="flex flex-col gap-2">
                <SetPreviewCard
                  preview={preview}
                  mockStrategies={mockStrategies}
                  busy={busy.has(setNumber)}
                  from={from}
                  onValue={() => void run(preview, 'value')}
                  onRefresh={() => void run(preview, 'refresh')}
                />
                {message === undefined ? null : (
                  <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
                    {message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

    </div>
  );
}
