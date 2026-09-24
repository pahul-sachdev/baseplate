import { redirect } from 'next/navigation';

import { MOCK_BACKED_STRATEGIES } from '../src/composition.ts';
import { systemClock } from '../src/db/clock.ts';
import { readSetPreviews } from '../src/db/previews.ts';
import { isLookupSortKey, type LookupSortKey } from '../src/lib/lookupView.ts';
import { looksLikeSetNumber } from '../src/lib/setNumber.ts';
import { LookupBoard } from './components/LookupBoard.tsx';

/**
 * Lookup.
 *
 * This page NEVER fetches. It hands the board whatever the URL says, and searching costs a
 * Rebrickable request only on an explicit keystroke or button, never on a page load.
 *
 * `?q=` and `?sort=` are mirrored here by the board so that leaving for a set's detail view and
 * coming back lands on the same search. They are seeds, not commands: a cold URL fills the box and
 * waits for the user to ask, because rendering must not spend.
 *
 * `?set=` is the old deep link, which /watchlist and /retiring used to point at. It now redirects
 * to the real detail route so existing bookmarks keep working.
 */
export default async function LookupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // Before any other work: redirect() throws, and there is nothing here worth doing first.
  const deepLinked = (first('set') ?? '').trim();
  if (deepLinked !== '') {
    const carried = new URLSearchParams();
    const condition = first('condition');
    if (condition !== undefined && condition !== 'sealed') carried.set('condition', condition);
    const buy = first('buy');
    if (buy !== undefined && buy !== '0') carried.set('buy', buy);
    const query = carried.toString();
    redirect(`/set/${encodeURIComponent(deepLinked)}${query === '' ? '' : `?${query}`}`);
  }

  const initialQuery = (first('q') ?? '').trim();
  const sortRaw = first('sort') ?? 'relevance';
  const initialSort: LookupSortKey = isLookupSortKey(sortRaw) ? sortRaw : 'relevance';

  // A cache read, so arriving here — or reloading — cannot cost a request. Only a set NUMBER is
  // resolved this way; a name would need Rebrickable, and that has to stay an explicit act.
  const initialPreviews = looksLikeSetNumber(initialQuery)
    ? await readSetPreviews([initialQuery])
    : [];

  return (
    <LookupBoard
      initialQuery={initialQuery}
      initialSort={initialSort}
      initialPreviews={initialPreviews}
      // Crossed as a plain array: the set itself lives in src/composition.ts, which imports Prisma.
      mockStrategies={[...MOCK_BACKED_STRATEGIES]}
      today={systemClock.today()}
    />
  );
}
