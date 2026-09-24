'use client';

import Image from 'next/image';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { explainVerdict } from '../../src/lib/explain.ts';
import { figHref } from '../../src/lib/figOrigin.ts';
import { CONDITION_LABELS } from '../../src/lib/labels.ts';
import { formatUSD } from '../../src/lib/money.ts';
import { comparePlatforms } from '../../src/lib/platformNets.ts';
import { actMatrix } from '../../src/lib/waysToAct.ts';
import {
  catalogHintFrom,
  IMAGE_FIT,
  IMAGE_FRAME,
  IMAGE_FRAME_EMPTY,
  isRenderableImage,
  type SetPreview,
} from '../../src/lib/setPreview.ts';
import type { SetMinifigPanel } from '../../src/lib/minifigPanel.ts';
import type { MinifigPreview } from '../../src/lib/minifigPreview.ts';
import { CONDITIONS, isCondition, type Condition } from '../../src/lib/types.ts';
import { refreshPreviewAction, valueSetAction } from '../actions.ts';
import {
  askAgainMinifigAction,
  readSetMinifigPanelAction,
  refreshMinifigAction,
  valueMinifigAction,
} from '../minifig/actions.ts';
import { MinifigPanel } from './MinifigPanel.tsx';
import { ConditionBands } from './SetPreviewCard.tsx';
import {
  AbsentNote,
  EstimatedNotice,
  MockNotice,
  PlatformStrip,
  StaleNotice,
  WaysToActTable,
} from './valuationParts.tsx';

/**
 * The decision view: everything known about one set, and the reasoning behind a call.
 *
 * Rendered by /set/[setNumber] from a preview the page read out of the local cache, so arriving
 * here spends nothing. Typing a buy price, switching condition and comparing plays are all pure
 * functions over numbers that were paid for once; only the two explicit buttons can spend.
 *
 * This was a full-screen native <dialog> living on Lookup. The dialog bought Escape, a focus trap
 * and an inert background for free — but it sat in the browser's top layer, which meant it covered
 * the app header, and it read Lookup's client state, which meant no other page could open it and
 * closing always landed on Lookup. As a route it needs none of that machinery: the header renders
 * above it because it is a page, and "close" is the back link the server put above this component.
 *
 * Owns its own state deliberately. `initialPreview` is a SEED — after valuing, the fresh preview
 * lives here and no navigation occurs, so the origin in ?from= survives a refresh of the numbers.
 */

const CONTROL =
  'rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors duration-150 focus:border-accent';

const BUTTON =
  'cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function SetDetailView({
  initialPreview,
  initialCondition,
  initialBuyRaw,
  initialMinifigPanel,
  originFrom,
  mockStrategies,
  today,
}: {
  /** Seed only. The live copy is state, so a value/refresh updates it without a navigation. */
  initialPreview: SetPreview;
  initialCondition: Condition;
  initialBuyRaw: string;
  /**
   * The figure panel, read from cache by the page. Null only when the read failed outright — an
   * unvalued set still gets a panel, which says so in words rather than rendering an empty grid.
   */
  initialMinifigPanel: SetMinifigPanel | null;
  /** The board this set was opened from, so a figure link can carry it two hops home. */
  originFrom: string;
  mockStrategies: readonly string[];
  today: string;
}) {
  const titleId = useId();

  const [preview, setPreview] = useState(initialPreview);
  const [condition, setCondition] = useState(initialCondition);
  const [buyRaw, setBuyRaw] = useState(initialBuyRaw);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * State, not a bare prop: valuing the set fills in its figure list, and valuing a figure changes
   * the share — both without a navigation, so the panel has to be able to move on its own.
   */
  const [minifigPanel, setMinifigPanel] = useState(initialMinifigPanel);

  /** Per-figure: an in-flight request and an error, keyed by minifig number — as LookupBoard does. */
  const [figBusy, setFigBusy] = useState<ReadonlySet<string>>(new Set());
  const [figError, setFigError] = useState<string | null>(null);
  /** Batch progress. */
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  /**
   * A ref, not state: the batch loop closes over its render's values, so a `stopRequested` state
   * flipped mid-run would be invisible to the loop already running and Stop would do nothing.
   */
  const stopRequestedRef = useRef(false);

  /**
   * The only two paths here that may spend a BrickEconomy request, and both need a click.
   *
   * The `busy` guard is not decoration: without it a second click while the first is in flight
   * spends a second request for the same set.
   */
  async function run(action: 'value' | 'refresh'): Promise<void> {
    if (busy) return;
    if (
      action === 'refresh' &&
      !window.confirm(
        `Refresh ${preview.meta.setNumber}? This spends up to 1 BrickEconomy request.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    // The hint carries the catalogue facts already on screen, so the re-read cannot lose the
    // artwork or the piece count for a set with no Brickset row.
    const hint = catalogHintFrom(preview);
    const result =
      action === 'value'
        ? await valueSetAction(preview.meta.setNumber, hint)
        : await refreshPreviewAction(preview.meta.setNumber, hint);

    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }

    setPreview(result.preview);

    // The figure list arrives inside the SET response, so valuing a set fills its panel in for
    // free. This re-read is cache-only and spends nothing — without it a set valued a moment ago
    // would still claim to have no minifigure list until the page was reloaded.
    try {
      setMinifigPanel(await readSetMinifigPanelAction(preview.meta.setNumber));
    } catch {
      // A panel that fails to refresh is not worth failing the valuation over; the numbers the
      // user just paid for are already on screen.
    }
  }

  /**
   * Mirror the chosen condition and buy price into the URL.
   *
   * Same technique and the same reasons as LookupBoard's q/sort mirror: replaceState so typing a
   * price does not bury the back button, and no router navigation because everything is already
   * here. It is what makes a reload — or a Back from a figure page — land on the same decision.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (condition === 'sealed') params.delete('condition');
    else params.set('condition', condition);
    if (buyRaw.trim() === '') params.delete('buy');
    else params.set('buy', buyRaw.trim());
    const qs = params.toString();
    window.history.replaceState(null, '', qs === '' ? window.location.pathname : `?${qs}`);
  }, [condition, buyRaw]);

  /**
   * A figure's link, carrying the set AND the board — so Back goes to this set with this
   * decision intact, and Back again reaches the board the set was opened from.
   *
   * Built here rather than read from window.location, which does not exist during the server
   * render and lags a replaceState by a tick.
   */
  const figHrefFor = useCallback(
    (minifigNumber: string) =>
      figHref(minifigNumber, {
        inSet: preview.meta.setNumber,
        cond: condition,
        buyRaw,
        from: originFrom,
      }),
    [preview.meta.setNumber, condition, buyRaw, originFrom],
  );

  /** One figure. Up to one request — zero when it is cached today or already recorded absent. */
  const runFig = useCallback(
    async (minifigNumber: string, action: 'value' | 'refresh' | 'askAgain'): Promise<boolean> => {
      setFigBusy((prev) => new Set(prev).add(minifigNumber));
      setFigError(null);

      const result =
        action === 'value'
          ? await valueMinifigAction(minifigNumber)
          : action === 'refresh'
            ? await refreshMinifigAction(minifigNumber)
            : await askAgainMinifigAction(minifigNumber);

      setFigBusy((prev) => {
        const next = new Set(prev);
        next.delete(minifigNumber);
        return next;
      });

      // Re-read the WHOLE panel from disk rather than patching one row: the share, the coverage
      // and the next batch's cost all move when one figure resolves, and recomputing them from
      // what the client believes happened is how a total drifts from the database.
      try {
        setMinifigPanel(await readSetMinifigPanelAction(preview.meta.setNumber));
      } catch {
        // Keep whatever is on screen; the figure's own row is already correct.
      }

      if (!result.ok) setFigError(result.message);
      return result.ok;
    },
    [preview.meta.setNumber],
  );

  /**
   * The batch: this component calling the single-figure action once per figure, sequentially.
   *
   * There is deliberately no multi-request Server Action. Each figure is written the moment it
   * resolves, so a Stop or a quota error keeps everything already fetched; the loop halts on the
   * first real failure rather than retrying into it; and a second click resumes, because every
   * success drops out of the next plan.
   */
  const runBatch = useCallback(async (): Promise<void> => {
    const plan = minifigPanel?.plan;
    if (plan === undefined || plan.requestCost === 0) return;

    const usage =
      `Value ${plan.requestCost} minifigure${plan.requestCost === 1 ? '' : 's'}? ` +
      `That is up to ${plan.requestCost} of your 100 daily BrickEconomy requests, about ` +
      `${plan.estimatedSeconds} second${plan.estimatedSeconds === 1 ? '' : 's'}.` +
      (plan.remaining > 0 ? ` ${plan.remaining} more would need another click.` : '') +
      ' You can stop at any time; everything already fetched is kept.';
    if (!window.confirm(usage)) return;

    stopRequestedRef.current = false;
    setBatch({ done: 0, total: plan.askable.length });

    let index = 0;
    for (const minifigNumber of plan.askable) {
      if (stopRequestedRef.current) break;
      const ok = await runFig(minifigNumber, 'value');
      index += 1;
      setBatch({ done: index, total: plan.askable.length });
      // A quota or auth failure will not fix itself on the next figure. Stop rather than spend
      // the rest of the batch confirming it.
      if (!ok) break;
    }

    setBatch(null);
  }, [minifigPanel, runFig]);

  const figures = preview.valuation.kind === 'none' ? null : preview.valuation;

  const buyPrice = Number(buyRaw);
  const hasBuyPrice = buyRaw.trim() !== '' && Number.isFinite(buyPrice) && buyPrice > 0;

  // Scores and explains in one call, so the BUY/PASS chip, the margin, the ceiling and the
  // strategy table all come from a single verdict computed at exactly this buy price.
  const explanation =
    figures === null
      ? null
      : explainVerdict({
          valuation: figures.valuation,
          buyPrice: hasBuyPrice ? buyPrice : null,
          condition,
          mockStrategies,
        });

  /**
   * The opportunity map, and it is condition-INDEPENDENT on purpose: it reads the valuation and
   * nothing else. `condition` must never appear in this expression. It used to — the section was
   * rendered from the verdict scored for the selected condition — so picking a condition silently
   * hid avenues from the map that is supposed to be complete.
   */
  const matrix = figures === null ? null : actMatrix(figures.valuation);

  // This one IS condition-specific, and stays so: it prices the play the verdict picked for the
  // condition chosen above, on every venue that can actually host it.
  const comparison =
    explanation === null
      ? null
      : comparePlatforms({
          call: explanation.call,
          condition,
          buyPrice: hasBuyPrice ? buyPrice : null,
        });

  return (
    <div className="space-y-8">
      {/* ── 1. Identity and worth ─────────────────────────────────────────── */}
      <section className="grid gap-6 sm:grid-cols-[minmax(0,320px)_1fr]">
        <div>
          {isRenderableImage(preview.meta.imageUrl) ? (
            <div className={IMAGE_FRAME}>
              <Image
                src={preview.meta.imageUrl}
                alt={preview.meta.name}
                fill
                sizes="(min-width: 640px) 320px, 90vw"
                className={IMAGE_FIT}
                priority
              />
            </div>
          ) : (
            <div className={IMAGE_FRAME_EMPTY}>
              <span className="text-xs text-muted">No image</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <h1 id={titleId} className="text-xl font-semibold tracking-tight">
              {preview.meta.name}
            </h1>
            <p className="mt-0.5 truncate text-sm text-muted">
              <span className="tabular">{preview.meta.setNumber}</span>
              {preview.meta.theme === null ? null : ` · ${preview.meta.theme}`}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Fact label="Pieces" value={preview.meta.pieces?.toLocaleString('en-US')} />
            <Fact
              label="MSRP"
              value={preview.meta.msrp === null ? null : formatUSD(preview.meta.msrp)}
            />
            <Fact label="Year" value={preview.meta.year?.toString()} />
            <Fact label="Retires" value={preview.meta.retireDate} />
          </dl>

          {figures === null ? (
            <div className="space-y-3 rounded-lg border border-dashed border-border p-4">
              <p className="text-sm text-muted">
                Not valued yet — no prices are on file for this set.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('value')}
                className={`${BUTTON} bg-accent text-bg hover:opacity-90`}
              >
                {busy ? 'Valuing…' : 'Value this set (spends 1 request)'}
              </button>
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <ConditionBands figures={figures.valuation} />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted">
                <span className="tabular">Cached {figures.fetchedOn}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run('refresh')}
                  className="cursor-pointer font-medium text-accent underline underline-offset-2 disabled:cursor-default disabled:opacity-60"
                >
                  {busy ? 'Refreshing…' : 'Refresh (spends up to 1 request)'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {error === null ? null : (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {error}
        </p>
      )}

      {/* ── Minifigures ───────────────────────────────────────────────────
          Deliberately OUTSIDE the valued-only block below. An unvalued set still has something
          honest to say here — "value the set and the figure list arrives with it, free" — and an
          empty space would read as "this set has no minifigures", which is a different claim.

          Placed before the buy decision because it informs it: when the figures are half the
          set's value, part-out is a different proposition than the box price suggests. */}
      {minifigPanel === null ? null : (
        <>
          <MinifigPanel
            panel={minifigPanel}
            hrefFor={figHrefFor}
            rowActions={(fig) => (
              <FigButtons
                preview={fig}
                busy={figBusy.has(fig.minifigNumber) || batch !== null}
                onRun={(action) => void runFig(fig.minifigNumber, action)}
              />
            )}
            batchControl={
              <BatchControl
                plan={minifigPanel.plan}
                batch={batch}
                exhausted={minifigPanel.share.coverage.exhausted}
                onRun={() => void runBatch()}
                onStop={() => {
                  stopRequestedRef.current = true;
                }}
              />
            }
          />
          {figError === null ? null : (
            <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              {figError}
            </p>
          )}
        </>
      )}

      {figures === null || explanation === null ? null : (
        <>
          <div className="space-y-2">
            <StaleNotice provenance={figures.provenance} today={today} />
            <EstimatedNotice provenance={figures.provenance} />
            {explanation.mockPlay ? (
              <MockNotice play={explanation.play} mockStrategies={mockStrategies} />
            ) : null}
          </div>

          {/* ── 2. Decision ───────────────────────────────────────────────── */}
          <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Should I buy it?
              </h2>
              <p className="mt-1 text-xs text-muted">
                Condition is chosen here, and only here — it decides which play this buy is judged
                on. It changes neither the prices above nor the map below.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">What would you pay for it?</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={buyRaw}
                  onChange={(event) => setBuyRaw(event.target.value)}
                  placeholder="300"
                  className={`tabular w-full ${CONTROL}`}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-muted">What condition is it in?</span>
                <select
                  value={condition}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (isCondition(next)) setCondition(next);
                  }}
                  className={`w-full cursor-pointer ${CONTROL}`}
                >
                  {CONDITIONS.map((value) => (
                    <option key={value} value={value}>
                      {CONDITION_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              {explanation.mode === 'verdict' ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span
                    className={`rounded-md px-3 py-1.5 text-base font-semibold ${
                      explanation.buy ? 'bg-buy/15 text-buy' : 'bg-pass/15 text-pass'
                    }`}
                  >
                    {explanation.buy ? 'BUY' : 'PASS'}
                  </span>
                  <span className="tabular text-sm text-muted">
                    margin{' '}
                    <span className="font-semibold text-text">{formatUSD(explanation.margin)}</span>
                  </span>
                </div>
              ) : (
                <p className="text-sm font-medium">
                  {explanation.ceiling === null ? (
                    <span className="text-pass">{explanation.ceilingLine}</span>
                  ) : (
                    <>
                      BUY UNDER{' '}
                      <span className="tabular text-buy">{formatUSD(explanation.ceiling)}</span>
                    </>
                  )}
                </p>
              )}

              {/* The reasoning, not just the chip. */}
              <div className="space-y-1.5 text-sm">
                <p>{explanation.lead}</p>
                <p className="text-muted">
                  {explanation.mode === 'verdict'
                    ? explanation.marginLine
                    : explanation.ceilingLine}
                </p>
              </div>
            </div>

            {/* Where you sell it changes what you keep, so the verdict cannot be the whole answer.
                The chip is anchored to one venue; this is every venue that can host the play. */}
            {comparison === null ? null : (
              <div className="space-y-3 border-t border-border pt-4">
                <p className="text-xs text-muted">
                  {comparison.playLabel} · {comparison.marketValueLabel}{' '}
                  <span className="tabular font-semibold text-text">
                    {formatUSD(comparison.marketValue)}
                  </span>
                </p>
                <PlatformStrip comparison={comparison} mockStrategies={mockStrategies} />
                <p className="text-sm text-muted">{comparison.avenueLine}</p>
              </div>
            )}
          </section>

          {/* ── 3. Ways to act ────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Ways to act
              </h2>
              <p className="mt-1 text-xs text-muted">
                Every priced play for this set, whatever condition you have — the condition picked
                above does not change this table. Net is after each play&rsquo;s own venue; compare
                venues in the strip above.
              </p>
            </div>

            {matrix === null ? null : (
              <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
                <WaysToActTable matrix={matrix} mockStrategies={mockStrategies} />
                <AbsentNote absent={matrix.absent} />
              </div>
            )}

            {/* Structure only. Building this needs a retail price source, which does not exist
                yet — so the slot is labelled and empty rather than faked. */}
            <div className="rounded-xl border border-dashed border-border p-5">
              <h3 className="text-sm font-medium">Where to buy</h3>
              <p className="mt-1 text-sm text-muted">
                Retailer prices and links are not sourced yet — BasePlate has no retail price feed
                wired in, so there is nothing honest to show here. This section stays empty until
                one exists.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * One figure's buttons. Which one appears is decided entirely by its state, so a figure that
 * cannot benefit from a request is never offered one.
 */
function FigButtons({
  preview,
  busy,
  onRun,
}: {
  preview: MinifigPreview;
  busy: boolean;
  onRun: (action: 'value' | 'refresh' | 'askAgain') => void;
}) {
  const kind = preview.state.kind;
  const base =
    'cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

  // No mapping exists to ask through, so there is no button — offering one would promise an
  // answer that cannot be obtained.
  if (kind === 'unaddressable') return null;

  if (kind === 'absent') {
    return (
      <button
        type="button"
        disabled={busy}
        title="BrickEconomy had no record of this id. Asking again spends a request."
        onClick={() => onRun('askAgain')}
        className={`${base} border border-border bg-surface text-muted hover:text-text`}
      >
        {busy ? '…' : 'ask again'}
      </button>
    );
  }

  if (kind === 'unvalued' || kind === 'unreadable') {
    return (
      <button
        type="button"
        disabled={busy}
        title="Spends up to 1 BrickEconomy request — none if this figure is already cached today."
        onClick={() => onRun('value')}
        className={`${base} bg-accent text-bg hover:opacity-90`}
      >
        {busy ? '…' : 'value'}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      title="Spends up to 1 BrickEconomy request."
      onClick={() => onRun('refresh')}
      className={`${base} border border-border bg-surface text-muted hover:text-text`}
    >
      {busy ? '…' : 'refresh'}
    </button>
  );
}

/**
 * The bulk control, and it never rounds its cost.
 *
 * The number comes from the server-computed plan over the current cache, so it cannot be inflated
 * by a stale client — and figures already valued, permanently absent, unaddressable or shaped like
 * part numbers are not in it.
 */
function BatchControl({
  plan,
  batch,
  exhausted,
  onRun,
  onStop,
}: {
  plan: SetMinifigPanel['plan'];
  batch: { done: number; total: number } | null;
  exhausted: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  if (batch !== null) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <span className="text-xs text-muted">
          Valuing {batch.done} of {batch.total}…
        </span>
        <button
          type="button"
          onClick={onStop}
          className="cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted transition-colors duration-150 hover:text-text"
        >
          Stop
        </button>
        <span className="text-xs text-muted">Everything already fetched is kept.</span>
      </div>
    );
  }

  if (plan.requestCost === 0) {
    return (
      <p className="border-t border-border pt-3 text-xs text-muted">
        {exhausted
          ? 'Every figure here has been asked about — nothing further to spend.'
          : 'No figure here can be valued with a request.'}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
      <button
        type="button"
        onClick={onRun}
        className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-colors duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Value {plan.requestCost} minifigure{plan.requestCost === 1 ? '' : 's'} (spends up to{' '}
        {plan.requestCost} request{plan.requestCost === 1 ? '' : 's'})
      </button>
      <span className="text-xs text-muted">
        about {plan.estimatedSeconds}s
        {plan.remaining > 0 ? ` · ${plan.remaining} more after this` : ''}
      </span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular font-medium">
        {value === null || value === undefined ? (
          <span className="text-sm font-normal italic text-muted">not known</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
