'use client';

import Image from 'next/image';
import Link from 'next/link';

import { CONDITION_LABELS, STRATEGY_LABELS } from '../../src/lib/labels.ts';
import { formatPercent, formatUSD } from '../../src/lib/money.ts';
import { detailHref } from '../../src/lib/origin.ts';
import {
  bestCall,
  callsByCondition,
  IMAGE_FIT,
  IMAGE_FRAME,
  IMAGE_FRAME_EMPTY,
  isRenderableImage,
  type SetPreview,
  type SetPreviewMeta,
} from '../../src/lib/setPreview.ts';
import { trendDirection } from '../../src/lib/trend.ts';
import type { Valuation } from '../../src/lib/types.ts';
import { MockChip } from './valuationParts.tsx';

/**
 * One set, browsable for free and valuable on request.
 *
 * The card renders from cache and never triggers a fetch on its own. Three states, and only the
 * first is automatic:
 *   - fresh  — today's numbers are already paid for, so fill them in
 *   - stale  — show them inside the staleness banner, and keep a refresh button
 *   - none   — "not valued yet", and a button that says what it costs
 *
 * A wide search renders a grid of these. If any of them valued itself on render, one search would
 * drain a 100-request daily quota — which is the whole reason browsing and valuing are separate.
 *
 * Every condition's figure shows at once, because a set HAS a value for all of them: the stored row
 * carries sealed, used-with-box and used-no-box together and always did. Nothing on this card is
 * chosen by a condition — that choice belongs to the verdict, in the detail view.
 *
 * Controlled: `preview` and `busy` live on the board, so a freshly valued card feeds the sort.
 * The buy price and the chosen condition now live on the detail route, where they belong — they
 * describe a decision about one set, not the state of a grid.
 */

const BUTTON =
  'cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

function MetaLine({ meta }: { meta: SetPreviewMeta }) {
  // Every field is omitted rather than zeroed when the sources don't have it.
  const parts = [
    meta.setNumber,
    meta.theme,
    meta.year === null ? null : String(meta.year),
    meta.pieces === null ? null : `${meta.pieces.toLocaleString('en-US')} pcs`,
    meta.msrp === null ? null : `MSRP ${formatUSD(meta.msrp)}`,
  ].filter((part): part is string => part !== null);

  return <p className="tabular truncate text-xs text-muted">{parts.join(' · ')}</p>;
}

export function Thumb({ meta }: { meta: SetPreviewMeta }) {
  if (!isRenderableImage(meta.imageUrl)) {
    return (
      <div className={IMAGE_FRAME_EMPTY}>
        <span className="text-xs text-muted">No image</span>
      </div>
    );
  }
  return (
    <div className={IMAGE_FRAME}>
      <Image
        src={meta.imageUrl}
        alt={meta.name}
        fill
        sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw"
        className={IMAGE_FIT}
      />
    </div>
  );
}

/**
 * One price band. A missing used figure says why rather than showing a dash on its own — "—" reads
 * as zero to someone scanning a grid, and $0.00 would be a fabricated price.
 */
function Band({
  label,
  value,
  absentNote,
}: {
  label: string;
  value: number | null;
  absentNote: string;
}) {
  return (
    <div>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="tabular text-sm font-medium">
        {value === null ? (
          <span className="text-[11px] font-normal italic text-muted">{absentNote}</span>
        ) : (
          formatUSD(value)
        )}
      </dd>
    </div>
  );
}

/** Every condition's figure, side by side. The point of the feature, in four boxes. */
export function ConditionBands({ figures }: { figures: Valuation }) {
  const direction = trendDirection(figures.trend);
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
      <Band label="Sealed" value={figures.sealed} absentNote="no data" />
      <Band label="Used, box" value={figures.usedWithBox} absentNote="no used-market data" />
      <Band label="Used, no box" value={figures.usedNoBox} absentNote="no used-market data" />
      <div>
        <dt className="text-[11px] text-muted">12m</dt>
        <dd
          className={`tabular text-sm font-medium ${
            direction === 'up' ? 'text-buy' : direction === 'down' ? 'text-pass' : ''
          }`}
        >
          {formatPercent(figures.trend)}
        </dd>
      </div>
    </dl>
  );
}

export function SetPreviewCard({
  preview,
  mockStrategies,
  busy,
  from,
  onValue,
  onRefresh,
}: {
  preview: SetPreview;
  mockStrategies: readonly string[];
  busy: boolean;
  /** The board's current URL, so Back from the detail view restores this search. */
  from: string;
  onValue: () => void;
  onRefresh: () => void;
}) {
  const { meta } = preview;
  const state = preview.valuation;

  // Pure, so the collapsed card can name the best play and its ceiling without a buy price. The
  // condition it assumes is rendered alongside it and never dropped — an unlabelled ceiling would
  // quote a price for a play the user may not be able to make.
  const best = state.kind === 'none' ? null : bestCall(callsByCondition(state.valuation));

  return (
    // `isolate` contains the z-20 controls below; see SetCard for the full reasoning.
    <article className="group relative isolate flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 transition-colors duration-150 hover:border-accent/60 focus-within:border-accent">
      <Thumb meta={meta} />
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-semibold" title={meta.name}>
            {/* The stretched link: real link text in the heading, an ::after cover over the card.
                Replaces a button wrapping thumb+title, so the click target is now the whole card
                and the set name is navigable as a link rather than announced as a button. */}
            <Link
              href={detailHref(meta.setNumber, from)}
              prefetch={false}
              className="cursor-pointer transition-colors duration-150 after:absolute after:inset-0 after:z-10 after:rounded-xl group-hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {meta.name}
            </Link>
          </h3>
          {meta.onWatchlist ? (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              watchlist
            </span>
          ) : null}
        </div>
        <MetaLine meta={meta} />
        {meta.retireDate !== null ? (
          <p className="tabular text-xs text-muted">Retires {meta.retireDate}</p>
        ) : null}
      </div>

      {state.kind === 'none' ? (
        <p className="text-xs text-muted">Not valued yet.</p>
      ) : (
        <>
          {state.kind === 'stale' ? (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
              {state.provenance.staleFrom !== null
                ? `Stale — quota was exhausted, numbers from ${state.provenance.staleFrom}`
                : `Cached ${state.fetchedOn} — not today's numbers`}
            </p>
          ) : null}

          <ConditionBands figures={state.valuation} />

          {best !== null ? (
            <div className="rounded-lg border border-border bg-bg px-3 py-2">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span>
                  {/* The condition is never omitted: this ceiling is only true for this one. */}
                  If {CONDITION_LABELS[best.condition].toLowerCase()} ·{' '}
                  {STRATEGY_LABELS[best.call.play].toLowerCase()} · net{' '}
                  <span className="tabular font-medium text-text">{formatUSD(best.call.net)}</span>
                </span>
                <MockChip play={best.call.play} mockStrategies={mockStrategies} />
              </p>
              {/* The actionable number. A BUY/PASS chip here would be meaningless: with no buy
                  price, verdict() calls anything profitable a BUY. */}
              {best.ceiling === null ? (
                <p className="mt-0.5 text-sm text-pass">No buy price clears the 25% bar.</p>
              ) : (
                <p className="tabular mt-0.5 text-sm font-semibold">
                  BUY UNDER <span className="text-buy">{formatUSD(best.ceiling)}</span>
                </p>
              )}
            </div>
          ) : null}
        </>
      )}

      {/* Always visible, never behind a disclosure.
          This line used to live inside the Expand panel, which the detail view replaced. A derived
          figure that only shows when the user opens something is a figure most users read as
          observed — and the rule is that an estimate is flagged wherever it is shown. */}
      {state.kind !== 'none' && state.provenance.derived.length > 0 ? (
        <p className="text-xs text-warn">
          Estimated, not observed: {state.provenance.derived.join(', ')}.
        </p>
      ) : null}

      {/* z-20 lifts the real controls above the link cover. */}
      <div className="relative z-20 mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        {state.kind === 'none' ? (
          <span className="text-xs text-muted">—</span>
        ) : (
          <span className="tabular text-xs text-muted">{state.fetchedOn}</span>
        )}

        <div className="flex items-center gap-2">
          {state.kind === 'none' ? (
            <button
              type="button"
              disabled={busy}
              onClick={onValue}
              className={`${BUTTON} bg-accent text-bg hover:opacity-90`}
            >
              {busy ? 'Valuing…' : 'Value this set (spends 1 request)'}
            </button>
          ) : (
            // The cached date moved to the left of this row when Expand was removed, so it is
            // deliberately not repeated here.
            <>
              {state.kind === 'stale' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRefresh}
                  className={`${BUTTON} border border-border bg-surface text-muted hover:text-text`}
                >
                  {busy ? '…' : 'Refresh (spends up to 1 request)'}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
