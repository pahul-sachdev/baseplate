import { readImages, readLatestValuation, readSavedSets } from '../../src/db/readModels.ts';
import { removeSetAction } from '../actions.ts';
import { SetCard } from '../components/SetCard.tsx';
import { SubmitButton } from '../components/SubmitButton.tsx';

/**
 * Cache-only render: listing the watchlist never touches a provider.
 *
 * Dynamic because the watchlist is mutable state in the database — prerendering would serve a
 * build-time snapshot of it, and freeze the header's quota meter with it.
 */
export const dynamic = 'force-dynamic';
export default async function WatchlistPage() {
  const saved = await readSavedSets();
  const setNumbers = saved.map((row) => row.setNumber);

  const [images, valuations] = await Promise.all([
    readImages(setNumbers),
    Promise.all(setNumbers.map((setNumber) => readLatestValuation(setNumber))),
  ]);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
        <p className="mt-1 text-sm text-muted">
          {saved.length === 0
            ? 'Sets you save from Lookup appear here.'
            : `${saved.length} set${saved.length === 1 ? '' : 's'}, showing cached values.`}
        </p>
      </section>

      {saved.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          Nothing saved yet.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {setNumbers.map((setNumber, index) => (
            <SetCard
              key={setNumber}
              setNumber={setNumber}
              cached={valuations[index] ?? null}
              image={images.get(setNumber) ?? { imageUrl: null, known: false }}
              from="/watchlist"
              extra={
                <form action={removeSetAction}>
                  <input type="hidden" name="setNumber" value={setNumber} />
                  <SubmitButton variant="quiet" pendingLabel="…">
                    Remove
                  </SubmitButton>
                </form>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
