import { isCachedToday, readImages, readLatestValuation } from '../../src/db/readModels.ts';
import { TRENDING_SETS } from '../../src/trending.ts';
import { refreshAllAction, refreshImagesAction } from '../actions.ts';
import { SetCard } from '../components/SetCard.tsx';
import { SubmitButton } from '../components/SubmitButton.tsx';

/**
 * Trending — a curated list, ranked by 12-month growth.
 *
 * Renders entirely from cache, including images. The two refresh buttons are the only paths
 * that spend requests, and each states its exact cost before running.
 *
 * Dynamic because it reads a live database. Prerendering would bake in the values — and the
 * quota meter — as they were at build time, which a build step verified it does by default.
 * Being dynamic costs nothing here: these are local SQLite reads, not API calls.
 */
export const dynamic = 'force-dynamic';
export default async function TrendingPage() {
  const setNumbers = [...TRENDING_SETS];

  const [images, valuations, cachedFlags] = await Promise.all([
    readImages(setNumbers),
    Promise.all(setNumbers.map((setNumber) => readLatestValuation(setNumber))),
    Promise.all(setNumbers.map((setNumber) => isCachedToday(setNumber))),
  ]);

  const rows = setNumbers
    .map((setNumber, index) => ({
      setNumber,
      cached: valuations[index] ?? null,
      image: images.get(setNumber) ?? { imageUrl: null, known: false },
      freshToday: cachedFlags[index] ?? false,
    }))
    // Ranked by 12m growth descending; sets with no cached valuation sink to the bottom.
    .sort((a, b) => (b.cached?.valuation.trend ?? -Infinity) - (a.cached?.valuation.trend ?? -Infinity));

  const staleValuations = rows.filter((row) => !row.freshToday).map((row) => row.setNumber);
  const missingImages = rows.filter((row) => !row.image.known).map((row) => row.setNumber);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trending</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            A curated list you control — edit{' '}
            <code className="rounded bg-bg px-1 py-0.5 text-xs">src/trending.ts</code> to change
            it. Ranked by 12-month growth. This is not a live market scan.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {missingImages.length > 0 ? (
            <form action={refreshImagesAction}>
              <input type="hidden" name="setNumbers" value={missingImages.join(',')} />
              <SubmitButton
                variant="quiet"
                pendingLabel="Fetching images…"
                confirm={`Fetch ${missingImages.length} image${missingImages.length === 1 ? '' : 's'} from Rebrickable? Throttled to 1 per second, so this takes about ${missingImages.length} seconds.`}
              >
                Fetch {missingImages.length} image{missingImages.length === 1 ? '' : 's'}
              </SubmitButton>
            </form>
          ) : null}

          {staleValuations.length > 0 ? (
            <form action={refreshAllAction}>
              <input type="hidden" name="setNumbers" value={staleValuations.join(',')} />
              <SubmitButton
                pendingLabel="Refreshing…"
                confirm={`Refresh ${staleValuations.length} set${staleValuations.length === 1 ? '' : 's'}? This spends up to ${staleValuations.length} of your 100 daily BrickEconomy requests.`}
              >
                Refresh all ({staleValuations.length})
              </SubmitButton>
            </form>
          ) : (
            <span className="text-xs text-muted">All values current today</span>
          )}
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <SetCard
            key={row.setNumber}
            setNumber={row.setNumber}
            cached={row.cached}
            image={row.image}
            // Where the detail view's back link returns to. A literal because this board holds no
            // client state: its ranking is computed here, on the server, on every render.
            from="/trending"
          />
        ))}
      </div>
    </div>
  );
}
