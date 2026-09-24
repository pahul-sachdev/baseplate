import Link from 'next/link';

import type { MinifigPreview } from '../../src/lib/minifigPreview.ts';
import { FigValue } from './minifigParts.tsx';

/**
 * One minifigure in a set's panel.
 *
 * A row rather than a card: a 24-figure set is a list, and twenty-four image-sized cards would
 * bury the set's own numbers. There is no artwork to show anyway — BrickEconomy publishes none for
 * figures, and Rebrickable's is keyed by an id space with no mapping to this one.
 *
 * `href` is optional so the row can ship before the figure route exists, and light up when it
 * does, without this file changing shape. When present the whole row is the click target, using
 * the same stretched-link pattern as SetCard — see it for the full reasoning on `isolate`.
 */
export function MinifigRow({
  preview,
  href = null,
  actions = null,
}: {
  preview: MinifigPreview;
  href?: string | null;
  /** Buttons, lifted above the link cover by the caller's own z-20 wrapper. */
  actions?: React.ReactNode;
}) {
  const { minifigNumber, name } = preview;
  const label = name ?? minifigNumber;

  return (
    <article className="group relative isolate flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 transition-colors duration-150 hover:border-accent/60 focus-within:border-accent">
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-medium" title={label}>
          {href === null ? (
            label
          ) : (
            <Link
              href={href}
              // Off deliberately: the figure route reads only the local cache, so a prefetch is
              // provably request-free — but twenty-four rows prefetching is twenty-four pointless
              // renders. Same call as the set cards.
              prefetch={false}
              className="cursor-pointer transition-colors duration-150 after:absolute after:inset-0 after:z-10 after:rounded-lg group-hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {label}
            </Link>
          )}
        </h4>
        <p className="tabular truncate text-xs text-muted">
          {minifigNumber}
          {name !== null && preview.state.kind === 'valued' && preview.state.facts.theme !== null
            ? ` · ${preview.state.facts.theme}`
            : ''}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <FigValue preview={preview} />
      </div>

      {actions === null ? null : (
        // z-20 lifts the real controls above the link cover; without it the row swallows the click.
        <div className="relative z-20 flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </article>
  );
}
