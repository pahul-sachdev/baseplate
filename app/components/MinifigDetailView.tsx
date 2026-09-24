'use client';

import { useState } from 'react';

import { MINIFIG_ID_RULES } from '../../src/lib/minifigNumber.ts';
import type { MinifigPreview } from '../../src/lib/minifigPreview.ts';
import { formatUSD } from '../../src/lib/money.ts';
import { netForPlatform, platformById } from '../../src/lib/platforms.ts';
import { maxBuyPrice } from '../../src/lib/setPreview.ts';
import {
  askAgainMinifigAction,
  refreshMinifigAction,
  valueMinifigAction,
} from '../minifig/actions.ts';
import { ExclusivitySlot, FigValue } from './minifigParts.tsx';
import { Notice } from './valuationParts.tsx';

/**
 * One minifigure's decision view.
 *
 * Rendered by /minifig/[minifigNumber] from a preview the page read out of the local cache, so
 * arriving here spends nothing. Only the buttons may spend, and each says so.
 *
 * There is deliberately NO trend and NO forecast tier. BrickEconomy publishes no growth field for
 * a figure — measured, not assumed — and MinifigFacts has no such property, so rendering one would
 * be a compile error rather than a badge computed off a defaulted 0 that would read "Flat" and
 * mean "we never asked". The observed price events are shown instead, as the observations they
 * are, with no delta computed between them.
 */

const BUTTON =
  'cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** A loose figure sells on BrickLink; that is the venue its net is quoted against. */
const VENUE = platformById('bricklink');

export function MinifigDetailView({
  initialPreview,
  inSet,
  today,
}: {
  /** Seed only. The live copy is state, so valuing updates it without a navigation. */
  initialPreview: MinifigPreview;
  /** The set this figure was opened from, for the exclusivity claim. Null when opened directly. */
  inSet: string | null;
  today: string;
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The only paths here that may spend, and all three need a click.
   *
   * The `busy` guard is not decoration: without it a second click while the first is in flight
   * spends a second request for the same figure.
   */
  async function run(action: 'value' | 'refresh' | 'askAgain'): Promise<void> {
    if (busy) return;
    if (
      action !== 'value' &&
      !window.confirm(
        `${action === 'refresh' ? 'Refresh' : 'Ask again about'} ${preview.minifigNumber}? ` +
          'This spends up to 1 BrickEconomy request.',
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    const result =
      action === 'value'
        ? await valueMinifigAction(preview.minifigNumber)
        : action === 'refresh'
          ? await refreshMinifigAction(preview.minifigNumber)
          : await askAgainMinifigAction(preview.minifigNumber);

    setBusy(false);
    if (result.ok) setPreview(result.preview);
    else setError(result.message);
  }

  const { state } = preview;
  const facts = state.kind === 'valued' || state.kind === 'no_price' ? state.facts : null;
  const value = state.kind === 'valued' ? state.value : null;

  // Pure functions already written and tested for sets. A figure's ceiling is the same question:
  // what can I pay and still clear the margin bar after the venue takes its cut.
  const ceiling = value === null ? null : maxBuyPrice(netForPlatform(value, VENUE));

  return (
    <div className="space-y-8">
      {/* ── 1. Identity and worth ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {preview.name ?? preview.minifigNumber}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            <span className="tabular">{preview.minifigNumber}</span>
            {facts?.theme === null || facts?.theme === undefined ? null : ` · ${facts.theme}`}
            {facts?.subtheme === null || facts?.subtheme === undefined ? null : ` · ${facts.subtheme}`}
            {facts?.year === null || facts?.year === undefined ? null : ` · ${facts.year}`}
          </p>
        </div>

        {facts?.description === null || facts?.description === undefined ? null : (
          <p className="max-w-prose text-sm text-muted">{facts.description}</p>
        )}

        <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-xs text-muted">Value (new)</p>
              <p className="mt-0.5 text-lg">
                <FigValue preview={preview} />
              </p>
            </div>

            {ceiling === null ? null : (
              <div className="text-right">
                <p className="text-xs text-muted">
                  Buy under, to clear the 25% bar after {VENUE.label}&rsquo;s fee
                </p>
                <p className="tabular mt-0.5 text-lg font-semibold text-buy">{formatUSD(ceiling)}</p>
              </div>
            )}
          </div>

          {/* No 12-month trend row. BrickEconomy publishes no growth figure for a minifigure, and
              deriving one from the price events below would manufacture the exact number the API
              declined to publish. */}
          <p className="border-t border-border pt-2 text-xs text-muted">
            BrickEconomy publishes no 12-month growth, no forecast and no used-market price for
            minifigures, so none is shown — and none is derived from the price history below.
          </p>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span className="tabular">
              {state.kind === 'valued' || state.kind === 'no_price'
                ? `Cached ${state.fetchedOn}`
                : state.kind === 'absent'
                  ? `Asked ${state.confirmedOn}`
                  : 'Never looked up'}
            </span>
            <Controls busy={busy} preview={preview} onRun={(action) => void run(action)} />
          </div>
        </div>

        {state.kind === 'unaddressable' ? (
          <Notice>{MINIFIG_ID_RULES[state.idKind].note}</Notice>
        ) : null}

        {state.kind === 'absent' ? (
          <Notice>
            <strong className="font-semibold">
              BrickEconomy has no minifigure record for {state.minifigNumber}
            </strong>{' '}
            — it answered HTTP {state.status} on {state.confirmedOn}
            {state.attempts > 1 ? ` (asked ${state.attempts} times)` : ''}. This id is shaped like a
            BrickLink part number, and BrickEconomy lists some microfigures that way. It cannot be
            valued, and it is excluded from any set total, which is therefore a floor.
          </Notice>
        ) : null}

        {error === null ? null : <Notice>{error}</Notice>}
      </section>

      {/* ── 2. Exclusivity — real data, not a labelled-empty box ───────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Where this figure appears
        </h2>
        <ExclusivitySlot preview={preview} inSet={inSet} />
        <p className="text-xs text-muted">
          From BrickEconomy&rsquo;s own set list for this minifigure. BrickLink supersets would be a
          second, cross-checkable source; they are not wired yet.
        </p>
      </section>

      {/* ── 3. Observed price history ─────────────────────────────────────── */}
      {facts === null || facts.priceEvents.length === 0 ? null : (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Recorded price changes
          </h2>
          <p className="text-xs text-muted">
            The last {facts.priceEvents.length} price changes BrickEconomy recorded, exactly as
            reported. These are observations — no growth rate is computed from them, because
            BrickEconomy does not publish one for minifigures and a derived one would look like a
            measurement.
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {facts.priceEvents.map((event) => (
              <li
                key={`${event.date}-${event.value}`}
                className="flex items-center justify-between px-3 py-1.5 text-sm"
              >
                <span className="tabular text-muted">{event.date}</span>
                <span className="tabular font-medium">{formatUSD(event.value)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted">
        Last read {today}. Minifigure artwork is not shown: BrickEconomy publishes none, and
        Rebrickable&rsquo;s catalogue uses a different numbering system (fig-001549) with no
        published mapping to {preview.minifigNumber}.
      </p>
    </div>
  );
}

/** The buttons, and each names its cost. Which one appears is decided by the figure's state. */
function Controls({
  busy,
  preview,
  onRun,
}: {
  busy: boolean;
  preview: MinifigPreview;
  onRun: (action: 'value' | 'refresh' | 'askAgain') => void;
}) {
  const { state } = preview;

  // No mapping exists to ask through, so there is no button at all — offering one would promise
  // an answer that cannot be obtained.
  if (state.kind === 'unaddressable') return null;

  if (state.kind === 'absent') {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onRun('askAgain')}
        className={`${BUTTON} border border-border bg-surface text-muted hover:text-text`}
      >
        {busy ? '…' : 'Ask again (spends up to 1 request)'}
      </button>
    );
  }

  if (state.kind === 'unvalued') {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onRun('value')}
        className={`${BUTTON} bg-accent text-bg hover:opacity-90`}
      >
        {/* "up to", never "1": a snapshot for today, or a recorded absence, costs nothing. */}
        {busy ? 'Valuing…' : 'Value this minifigure (spends up to 1 request)'}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onRun('refresh')}
      className="cursor-pointer font-medium text-accent underline underline-offset-2 disabled:cursor-default disabled:opacity-60"
    >
      {busy ? 'Refreshing…' : 'Refresh (spends up to 1 request)'}
    </button>
  );
}
