'use client';

import { useEffect, useId, useMemo, useState } from 'react';

// money.ts imports nothing at all, so it cannot drag the server into this bundle.
import { formatPercent } from '../../src/lib/money.ts';
import {
  applyBoardView,
  boardThemes,
  boardViewToQuery,
  countUnpricedHidden,
  isFiltered,
  isSortKey,
  parsePrice,
  POSITIVE_GROWTH,
  SORT_OPTIONS,
  type BoardView,
  type CachedForecast,
  type RetiringRow,
} from '../../src/lib/retiring.ts';
import { RetiringCard } from './RetiringCard.tsx';

/**
 * The board's controls and grid.
 *
 * EVERY control here is a pure operation over rows the server already loaded from the cache. There
 * is no fetch, no Server Action, and no import that could reach one — sorting and filtering are
 * free by construction, not by discipline, so no amount of clicking can spend a request.
 *
 * This file must import nothing from src/ except pure modules. src/composition.ts pulls in Prisma
 * and installs the API log at module load, so any component reaching it would drag the server into
 * the client bundle; anything it owns (MOCK_BACKED_STRATEGIES) crosses as a prop instead. The
 * shared notices live in app/components/valuationParts.tsx, which depends only on src/lib and is
 * therefore safe from either side. RetiringRow and CachedForecast live in src/lib/retiring.ts for
 * exactly this reason.
 *
 * Filtering never hides a set as a side effect of sorting: sorts reorder all rows, filters remove
 * them only when asked, and the count line always says what happened.
 */

const CONTROL =
  'rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm outline-none transition-colors duration-150 focus:border-accent';

export function RetiringBoard({
  rows,
  forecasts,
  today,
  months,
  initialView,
}: {
  rows: RetiringRow[];
  /** Plain object rather than a Map: Maps do not survive the RSC boundary as props. */
  forecasts: Record<string, CachedForecast>;
  today: Date;
  months: string;
  /**
   * Parsed from the URL by the SERVER, so its first render already matches what the client will
   * compute. Seeding from window.location here instead would make the two disagree — a hydration
   * mismatch, and a visible flash of the default order on every shared link.
   */
  initialView: BoardView;
}) {
  const ids = useId();
  const [view, setView] = useState<BoardView>(initialView);

  const forecastMap = useMemo(() => new Map(Object.entries(forecasts)), [forecasts]);
  const themes = useMemo(() => boardThemes(rows), [rows]);

  /**
   * Mirror the controls into the URL so a view can be shared or reloaded.
   *
   * replaceState, not pushState: typing in the search box would otherwise bury the back button
   * under one history entry per keystroke. And replaceState rather than a router navigation,
   * because re-running the server render would be pointless work — every row is already here.
   */
  useEffect(() => {
    const query = boardViewToQuery(view, months);
    window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`);
  }, [view, months]);

  /**
   * Where a card's detail view should send the user back to: this board, exactly as it looks now.
   *
   * Rebuilt from `view` rather than read off window.location, for two reasons. It has to be
   * correct during the server render, where there is no window; and the effect above rewrites the
   * whole query string on every change, so anything read back from the URL is only ever as fresh
   * as the last commit. One string per render, shared by every card — not recomputed per card.
   */
  const from = useMemo(() => {
    const query = boardViewToQuery(view, months);
    return query === '' ? '/retiring' : `/retiring?${query}`;
  }, [view, months]);

  // The same function the server used, so the two renders cannot drift apart.
  const visible = useMemo(
    () => applyBoardView(rows, forecastMap, view, today),
    [rows, forecastMap, view, today],
  );

  const unpricedHidden = countUnpricedHidden(rows, view);
  const filtered = isFiltered(view, view.query);
  const valued = visible.filter((row) => forecastMap.has(row.setNumber)).length;

  const set = <K extends keyof BoardView>(key: K, value: BoardView[K]): void =>
    setView((previous) => ({ ...previous, [key]: value }));

  const clearAll = (): void =>
    setView((previous) => ({
      sort: previous.sort,
      theme: null,
      priceMin: null,
      priceMax: null,
      positiveOnly: false,
      valuedOnly: false,
      query: '',
    }));

  return (
    <>
      <section className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Sort</span>
          <select
            value={view.sort}
            onChange={(event) => set('sort', isSortKey(event.target.value) ? event.target.value : 'retiring')}
            className={CONTROL}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key} title={option.hint}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-muted">Theme</span>
          <select
            value={view.theme ?? ''}
            onChange={(event) => set('theme', event.target.value === '' ? null : event.target.value)}
            className={CONTROL}
          >
            <option value="">All themes</option>
            {themes.map((entry) => (
              <option key={entry.theme} value={entry.theme}>
                {entry.theme} ({entry.count})
              </option>
            ))}
          </select>
        </label>

        <fieldset className="block">
          <legend className="mb-1 block text-xs text-muted">MSRP</legend>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              placeholder="min"
              aria-label="Minimum MSRP"
              defaultValue={view.priceMin === null ? '' : String(view.priceMin)}
              onChange={(event) => set('priceMin', parsePrice(event.target.value))}
              className={`tabular w-20 ${CONTROL}`}
            />
            <span aria-hidden="true" className="text-xs text-muted">
              –
            </span>
            <input
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              placeholder="max"
              aria-label="Maximum MSRP"
              defaultValue={view.priceMax === null ? '' : String(view.priceMax)}
              onChange={(event) => set('priceMax', parsePrice(event.target.value))}
              className={`tabular w-20 ${CONTROL}`}
            />
          </div>
        </fieldset>

        <label className="block min-w-[12rem] flex-1">
          <span className="mb-1 block text-xs text-muted">Search this board</span>
          <input
            type="search"
            autoComplete="off"
            placeholder="name, theme or number"
            value={view.query}
            onChange={(event) => set('query', event.target.value)}
            className={`w-full ${CONTROL}`}
          />
        </label>

        <div className="flex flex-col gap-1.5 pb-1">
          <label
            className="flex items-center gap-2 text-xs text-muted"
            htmlFor={`${ids}-pos`}
            title={`Forecast growth of ${formatPercent(POSITIVE_GROWTH)} or more — Positive and Strong. Flat no longer counts.`}
          >
            <input
              id={`${ids}-pos`}
              type="checkbox"
              checked={view.positiveOnly}
              onChange={(event) => set('positiveOnly', event.target.checked)}
              className="accent-accent"
            />
            Positive or better
          </label>
          <label className="flex items-center gap-2 text-xs text-muted" htmlFor={`${ids}-valued`}>
            <input
              id={`${ids}-valued`}
              type="checkbox"
              checked={view.valuedOnly}
              onChange={(event) => set('valuedOnly', event.target.checked)}
              className="accent-accent"
            />
            Valued only
          </label>
        </div>

        {filtered ? (
          <button
            type="button"
            onClick={clearAll}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted transition-colors duration-150 hover:text-text"
          >
            Clear filters
          </button>
        ) : null}
      </section>

      <p className="text-xs text-muted">
        {filtered ? (
          <>
            Showing {visible.length} of {rows.length} candidate{rows.length === 1 ? '' : 's'}
          </>
        ) : (
          <>
            {rows.length} candidate{rows.length === 1 ? '' : 's'}
          </>
        )}{' '}
        · {valued} with a cached BrickEconomy forecast, {visible.length - valued} not valued yet.
        {/* Named rather than silently dropped: a set with no MSRP cannot be judged against a
            price range, and letting it vanish would look like it failed the filter. */}
        {unpricedHidden > 0 ? (
          <> {unpricedHidden} hidden — no MSRP on file, so no price range can include them.</>
        ) : null}{' '}
        Sorting and filtering are cache-only and spend nothing.
      </p>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          No candidate matches these filters. {rows.length} are on the board — clear the filters to
          see them.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((row) => (
            <RetiringCard
              key={row.setNumber}
              row={row}
              today={today}
              forecast={forecastMap.get(row.setNumber)}
              months={months}
              from={from}
            />
          ))}
        </div>
      )}
    </>
  );
}
