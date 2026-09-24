import Image from 'next/image';
import Link from 'next/link';

import type { CachedImage, CachedValuation } from '../../src/db/readModels.ts';
import { formatPercent, formatUSD } from '../../src/lib/money.ts';
import { detailHref } from '../../src/lib/origin.ts';
import { trendDirection } from '../../src/lib/trend.ts';
import { IMAGE_FIT, IMAGE_FRAME, IMAGE_FRAME_EMPTY } from '../../src/lib/setPreview.ts';
import { refreshSetAction } from '../actions.ts';
import { FreshnessTag } from './valuationParts.tsx';
import { SubmitButton } from './SubmitButton.tsx';

/** Placeholder that reserves the exact image box, so a missing photo never shifts the layout. */
function ImageSlot({ image, alt }: { image: CachedImage; alt: string }) {
  if (image.imageUrl === null) {
    return (
      <div className={IMAGE_FRAME_EMPTY}>
        <span className="text-xs text-muted">{image.known ? 'No image' : 'Not fetched'}</span>
      </div>
    );
  }
  return (
    <div className={IMAGE_FRAME}>
      <Image
        src={image.imageUrl}
        alt={alt}
        fill
        sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw"
        className={IMAGE_FIT}
      />
    </div>
  );
}

/**
 * Compact card for Watchlist and Trending. Renders only cached data; the Refresh button is the
 * explicit action that may spend a request.
 *
 * The whole card opens the detail view, via the stretched-link pattern: the real <Link> lives
 * inside the heading and an ::after pseudo-element covers the card. That keeps the set name as
 * genuine link text inside the <h3> — good for heading and link navigation — while never nesting
 * the Refresh form inside another interactive element, which wrapping the card in an <a> would.
 *
 * `from` is where Back should return to. It is required rather than defaulted because a silent
 * default is how every card ends up claiming it came from Lookup.
 */
export function SetCard({
  setNumber,
  cached,
  image,
  from,
  extra,
}: {
  setNumber: string;
  cached: CachedValuation | null;
  image: CachedImage;
  /** The page this card is on, as a relative path plus query. See src/lib/origin.ts. */
  from: string;
  extra?: React.ReactNode;
}) {
  const name = cached?.set?.name ?? `Set ${setNumber}`;
  const growth = cached?.valuation.trend ?? null;

  return (
    // `isolate` is load-bearing: `relative` with z-index auto creates no stacking context, so the
    // z-20 controls below would otherwise compete at page level and could paint over the sticky
    // header. Text selection over the card body is lost to the cover — the accepted cost of a
    // whole-card click target.
    <article className="group relative isolate flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 transition-colors duration-150 hover:border-accent/60 focus-within:border-accent">
      <ImageSlot image={image} alt={name} />

      <div>
        <h3 className="truncate text-sm font-semibold" title={name}>
          <Link
            href={detailHref(setNumber, from)}
            // Off deliberately. A prefetch here is request-free — the detail route reads only the
            // local cache — but a grid of cards would still fire a render and six queries each.
            prefetch={false}
            className="cursor-pointer transition-colors duration-150 after:absolute after:inset-0 after:z-10 after:rounded-xl group-hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {name}
          </Link>
        </h3>
        <p className="tabular text-xs text-muted">{setNumber}</p>
      </div>

      {cached === null ? (
        <p className="text-xs text-muted">
          No cached valuation. Refresh spends one BrickEconomy request.
        </p>
      ) : (
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-xs text-muted">Sealed</dt>
            <dd className="tabular font-medium">{formatUSD(cached.valuation.sealed)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Used</dt>
            <dd className="tabular font-medium">
              {cached.valuation.usedWithBox === null ? (
                <span className="text-muted">—</span>
              ) : (
                formatUSD(cached.valuation.usedWithBox)
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">12m</dt>
            <dd
              className={`tabular font-medium ${
                growth !== null && trendDirection(growth) === 'up' ? 'text-buy' : ''
              }`}
            >
              {growth === null ? '—' : formatPercent(growth)}
            </dd>
          </div>
        </dl>
      )}

      {cached !== null && cached.provenance.staleFrom !== null ? (
        <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
          Stale — from {cached.provenance.staleFrom}
        </p>
      ) : null}

      {/* z-20 lifts the real controls above the link cover — without it the card would swallow
          every click on Refresh and Remove. */}
      <div className="relative z-20 mt-auto flex items-center justify-between gap-2 pt-1">
        {cached !== null ? (
          <FreshnessTag fetchedOn={cached.valuation.fetchedOn} isStale={cached.isStale} />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <form action={refreshSetAction}>
            <input type="hidden" name="setNumber" value={setNumber} />
            <input type="hidden" name="condition" value="sealed" />
            <SubmitButton
              variant="quiet"
              pendingLabel="…"
              confirm={`Refresh ${setNumber}? This spends 1 BrickEconomy request.`}
            >
              Refresh
            </SubmitButton>
          </form>
          {extra}
        </div>
      </div>
    </article>
  );
}
