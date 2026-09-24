import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MOCK_BACKED_STRATEGIES } from '../../../src/composition.ts';
import { systemClock } from '../../../src/db/clock.ts';
import { readSetMinifigPanel } from '../../../src/db/minifigReads.ts';
import { readSetPreviews } from '../../../src/db/previews.ts';
import { parseOrigin } from '../../../src/lib/origin.ts';
import { isAddressableSetNumber } from '../../../src/lib/setNumber.ts';
import { isCondition, type Condition } from '../../../src/lib/types.ts';
import { SetDetailView } from '../../components/SetDetailView.tsx';

/**
 * The detail/decision view for one set — the same page whichever board opened it.
 *
 * This page NEVER fetches. readSetPreviews reads the local cache and cannot reach the network, so
 * opening detail from a grid of any size spends zero requests. Only the two buttons inside the
 * view may spend, and each says so.
 *
 * The origin travels in ?from= and is validated by parseOrigin — see src/lib/origin.ts for why
 * that is a security boundary and not a convenience. The back link is rendered here, on the
 * server, so it works without JavaScript and is the first focusable thing in <main>.
 *
 * Dynamic because it reads a live database, and because the layout's quota meter must not be
 * frozen at build time. Without it the full route cache could also serve a pre-value render of a
 * set the user just valued.
 */
export const dynamic = 'force-dynamic';

export default async function SetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ setNumber: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Both are Promises in this Next version. The segment arrives already percent-decoded — do not
  // decode it a second time.
  const [{ setNumber: raw }, query] = await Promise.all([params, searchParams]);

  const first = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const setNumber = raw.trim();
  // Deliberately NOT gated on looksLikeSetNumber: "k8672-1" is a real Rebrickable number that
  // fails it, and an unknown number should render an honest "not valued yet" card rather than a
  // 404. Only a number that cannot be one at all is refused — and by the same rule the figure
  // route validates its ?inSet= with, so the two can never disagree about what is addressable.
  if (!isAddressableSetNumber(setNumber)) notFound();

  const origin = parseOrigin(first('from'));

  const conditionRaw = first('condition') ?? 'sealed';
  const condition: Condition = isCondition(conditionRaw) ? conditionRaw : 'sealed';
  const buyPrice = Number(first('buy') ?? '0');
  const buyRaw = Number.isFinite(buyPrice) && buyPrice > 0 ? String(buyPrice) : '';

  // Both are cache reads, so arriving here — or reloading — cannot cost a request. The preview is
  // condition-blind: one stored row answers for every condition, and the URL's condition only
  // seeds the verdict input.
  //
  // The minifigure panel is free for a subtler reason: the figure list is already inside the set's
  // own cached BrickEconomy payload, so listing twenty-four figures adds no request and no second
  // provider. Its own suite pins that with fetch stubbed to throw.
  const [[preview], minifigPanel] = await Promise.all([
    readSetPreviews([setNumber]),
    readSetMinifigPanel(setNumber),
  ]);
  // Unreachable for a non-empty input — mergePreviewMeta falls back to `Set ${setNumber}` — but
  // noUncheckedIndexedAccess is right to make it explicit.
  if (preview === undefined) notFound();

  return (
    <div className="space-y-6">
      <Link
        href={origin.href}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md py-1 text-sm text-muted transition-colors duration-150 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true">←</span> Back to {origin.label}
      </Link>

      <SetDetailView
        initialPreview={preview}
        initialCondition={condition}
        initialBuyRaw={buyRaw}
        initialMinifigPanel={minifigPanel}
        // So a figure link can carry this set AND the board behind it, two hops home.
        originFrom={origin.href}
        // Crossed as a plain array: the set itself lives in src/composition.ts, which imports Prisma.
        mockStrategies={[...MOCK_BACKED_STRATEGIES]}
        today={systemClock.today()}
      />
    </div>
  );
}
