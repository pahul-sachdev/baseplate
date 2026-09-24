import type { SetMinifigPanel } from '../../src/lib/minifigPanel.ts';
import { MinifigRow } from './MinifigRow.tsx';
import { RichChip, RosterNote, ShapeAdvisory, ShareBlock } from './minifigParts.tsx';

/**
 * "Minifigures in this set" — the 50% rule, rendered.
 *
 * Every figure in the set, its value or the specific reason it has none, and what share of the
 * set's sealed value they add up to. Assembled entirely from rows already on disk: the figure list
 * comes out of the set's own BrickEconomy payload, which arrived when the set was valued and has
 * been stored verbatim ever since. Opening this costs NOTHING, however many figures a set has.
 *
 * Nothing here fetches. Valuing a figure is a separate, explicit, per-figure act, and the buttons
 * that do it arrive as `rowActions` from the caller so this component cannot spend by accident.
 */
export function MinifigPanel({
  panel,
  hrefFor = null,
  rowActions = null,
  batchControl = null,
}: {
  panel: SetMinifigPanel;
  /** Builds a figure's detail link. Null until the figure route exists. */
  hrefFor?: ((minifigNumber: string) => string) | null;
  /** Per-figure buttons. Null while the panel is read-only. */
  rowActions?: ((preview: SetMinifigPanel['figs'][number]) => React.ReactNode) | null;
  /** The "value the rest" control. Null while the panel is read-only. */
  batchControl?: React.ReactNode;
}) {
  const { roster, figs, share, flag, threshold, shapeNote } = panel;

  return (
    <section className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Minifigures in this set
          </h2>
          <RichChip flag={flag} threshold={threshold} />
        </div>
        <p className="mt-1 text-xs text-muted">
          The figure list came with this set&rsquo;s own valuation, so it cost nothing. Each figure
          is priced separately, and only when you ask.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
        {roster.kind === 'listed' ? (
          <>
            <ShareBlock share={share} flag={flag} />
            <ShapeAdvisory note={shapeNote} />

            <div className="space-y-2">
              {figs.map((preview) => (
                <MinifigRow
                  key={preview.minifigNumber}
                  preview={preview}
                  href={hrefFor === null ? null : hrefFor(preview.minifigNumber)}
                  actions={rowActions === null ? null : rowActions(preview)}
                />
              ))}
            </div>

            {batchControl}
          </>
        ) : (
          // no_payload / unreadable / not_listed / none each get their own sentence. An empty
          // grid would read as "this set has no minifigures" in all four cases, and that is only
          // true in one of them.
          <RosterNote roster={roster} />
        )}
      </div>
    </section>
  );
}
