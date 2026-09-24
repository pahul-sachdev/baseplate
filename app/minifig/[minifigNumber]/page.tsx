import Link from 'next/link';
import { notFound } from 'next/navigation';

import { systemClock } from '../../../src/db/clock.ts';
import { readMinifigDetail } from '../../../src/db/minifigReads.ts';
import { resolveBackLink } from '../../../src/db/originLabel.ts';
import { parseFigOrigin } from '../../../src/lib/figOrigin.ts';
import { isRoutableMinifigNumber } from '../../../src/lib/minifigNumber.ts';
import { MinifigDetailView } from '../../components/MinifigDetailView.tsx';

/**
 * One minifigure's detail view — the same page whichever set or board opened it.
 *
 * This page NEVER fetches. readMinifigDetail reads the local cache and cannot reach the network,
 * and so does resolveBackLink, so arriving here — even for a figure never seen before, opened from
 * a set never valued — spends zero requests. Only the buttons inside the view may spend, and each
 * says what it costs.
 *
 * The origin travels in four scalars rather than a nested ?from=, so that src/lib/origin.ts keeps
 * refusing every path-shaped origin it always did — see src/lib/figOrigin.ts for why that matters
 * and how the chain stays bounded at two hops.
 *
 * Dynamic for the same reasons as the set route: a live database, and a quota meter that must not
 * be frozen at build time.
 */
export const dynamic = 'force-dynamic';

export default async function MinifigDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ minifigNumber: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ minifigNumber: raw }, query] = await Promise.all([params, searchParams]);

  const minifigNumber = raw.trim();
  // Deliberately NOT gated on classifyMinifigId: a Rebrickable id like "fig-001549" is routable
  // and must reach an honest page explaining why it cannot be valued, rather than a 404 that
  // teaches nothing. Only a string that could not be a figure number at all is refused.
  if (!isRoutableMinifigNumber(minifigNumber)) notFound();

  const origin = parseFigOrigin({
    inSet: query['inSet'],
    cond: query['cond'],
    buy: query['buy'],
    from: query['from'],
  });

  // Both cache reads. The back link's WORDS come from the database — the URL supplied only a
  // validated set number, never a name.
  const [detail, backLink] = await Promise.all([
    readMinifigDetail(minifigNumber),
    resolveBackLink(origin),
  ]);
  if (detail === null) notFound();

  return (
    <div className="space-y-6">
      <Link
        href={backLink.href}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md py-1 text-sm text-muted transition-colors duration-150 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true">←</span> Back to {backLink.label}
      </Link>

      <MinifigDetailView
        initialPreview={detail.preview}
        inSet={origin.kind === 'set' ? origin.setNumber : null}
        today={systemClock.today()}
      />
    </div>
  );
}
