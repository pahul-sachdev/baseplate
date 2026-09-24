import {
  readCachedForecasts,
  readRetiringCandidates,
  readSyncState,
  todayUtc,
} from '../../src/db/brickset/readModels.ts';
import { estimateSyncRequests } from '../../src/db/brickset/sync.ts';
import { parseBoardView, resolveWindowMonths } from '../../src/lib/retiring.ts';
import { Notice } from '../components/valuationParts.tsx';
import { RetiringBoard } from '../components/RetiringBoard.tsx';
import { SubmitButton } from '../components/SubmitButton.tsx';
import { syncRetiringAction } from './actions.ts';

/**
 * Retiring soon — a market-wide board, not a curated list.
 *
 * The candidate pool is Brickset's catalogue, cached locally: cheap, bulk, and on its own
 * allowance. The forecast layer is BrickEconomy, and it is applied ONLY to sets that already have
 * a cached snapshot. Loading this page makes zero calls to either provider, no matter how many
 * candidates it holds — the two buttons are the only paths that spend anything, and each states
 * its cost first.
 *
 * That is why the forecast is a badge and not a filter. Deciding "positive forecast" for an
 * unvalued set would need one BrickEconomy request per candidate, which would exhaust the daily
 * quota on a single render — and would hide every set that simply has not been valued yet. So the
 * board shows every candidate, grades each cached forecast into a tier, and marks the rest as not
 * valued yet.
 *
 * Dynamic because it reads a live database, and because prerendering would bake the sync date and
 * the quota meter in at build time.
 */
export const dynamic = 'force-dynamic';

export default async function RetiringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const monthsParam = first('months');
  const months = resolveWindowMonths(monthsParam, process.env);
  const error = first('error');

  // Parsed here rather than from window.location in the client, so the first server render already
  // matches what the client computes — no hydration mismatch, and a shared link paints correctly
  // the first time instead of flashing the default order.
  const initialView = parseBoardView(first);

  const today = todayUtc();
  const [candidates, sync] = await Promise.all([
    readRetiringCandidates(months, today),
    readSyncState(),
  ]);

  // Cache-only: this reads SetSnapshot rows that already exist and never triggers a fetch.
  const forecasts = await readCachedForecasts(candidates.map((row) => row.setNumber));

  const mode = sync.hasFullSync ? 'incremental' : 'full';
  const estimate = estimateSyncRequests(mode);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Retiring soon</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Sets leaving retail within {months} months, from the Brickset catalogue cache, soonest
            first. Rendered entirely from cache — loading this page spends nothing. Add{' '}
            <code className="rounded bg-bg px-1 py-0.5 text-xs">?months=12</code> to widen it.
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <form action={syncRetiringAction}>
            {/* A partial or failed run must not leave the cursor advanced, so retry a full pass. */}
            <input type="hidden" name="force" value={sync.hasFullSync ? '0' : '1'} />
            <SubmitButton
              pendingLabel="Syncing…"
              confirm={
                mode === 'full'
                  ? `Run a full Brickset sync? This pulls the current year and the prior four, spending roughly ${estimate} Brickset requests (a separate allowance from BrickEconomy's 100/day).`
                  : `Refresh the retiring list? This pulls only sets changed since the last sync, spending roughly ${estimate} Brickset requests.`
              }
            >
              {mode === 'full' ? 'Sync retiring list' : 'Refresh retiring list'}
            </SubmitButton>
          </form>

          <p className="tabular text-right text-xs text-muted">
            {sync.lastRunAt === null ? (
              'Never synced'
            ) : (
              <>
                Synced {sync.lastRunAt.toISOString().slice(0, 10)} · {sync.cachedSets.toLocaleString()}{' '}
                sets cached
              </>
            )}
          </p>
          {sync.reportedUsage30d === null ? null : (
            // Usage only, with no denominator: getKeyUsageStats reports what a key has spent and
            // never what it is allowed, so any "/limit" here would be invented.
            //
            // Read BEFORE the sync ran, so it excludes that sync's own requests — said plainly,
            // because a figure of 3 sitting under a run that spent 12 otherwise looks wrong.
            <p className="tabular text-right text-xs text-muted">
              Brickset reported {sync.reportedUsage30d} requests in the 30 days before that sync
              {sync.reportedUsageOn === null ? '' : ` (read ${sync.reportedUsageOn})`}
            </p>
          )}
        </div>
      </section>

      {error !== undefined ? <Notice>{error}</Notice> : null}

      {sync.lastRunStatus === 'partial' || sync.lastRunStatus === 'failed' ? (
        <Notice>
          <strong className="font-semibold">Incomplete sync</strong> —{' '}
          {sync.lastRunMessage ?? 'The last sync did not finish.'} The board below shows only what
          was cached; run the sync again to fill the gap.
        </Notice>
      ) : null}

      {candidates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          {sync.cachedSets === 0
            ? 'No Brickset data yet. Run the sync to pull the recent-years catalogue.'
            : `No set in the cache has an exit date within the next ${months} months.`}
        </p>
      ) : (
        // The controls live client-side so reordering is instant. They filter rows already loaded
        // here, so no control can reach a provider — the Map is flattened to a plain object
        // because Maps do not survive the RSC boundary as props.
        <RetiringBoard
          rows={candidates}
          forecasts={Object.fromEntries(forecasts)}
          today={today}
          months={monthsParam ?? ''}
          initialView={initialView}
        />
      )}
    </div>
  );
}
