import type { QuotaUsage } from '../../src/db/readModels.ts';

/**
 * Exact counts from the ApiRequest log — not inferred from cached snapshots, so variant retries
 * and rejected requests are included.
 *
 * BrickEconomy gets a bar because it has a published 100/day limit. Brickset gets a bare count
 * and no denominator: its API reports usage only and never an allowance, so a "/limit" here would
 * be a number this app made up.
 */
export function QuotaMeter({ quota }: { quota: QuotaUsage }) {
  const pct = Math.min(100, Math.round((quota.brickeconomy / quota.limit) * 100));
  const tight = quota.brickeconomy >= quota.limit * 0.8;

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted"
      title={`BrickEconomy ${quota.brickeconomy}/${quota.limit} · Rebrickable ${quota.rebrickable} · Brickset ${quota.brickset} (no published limit) · resets 00:00 UTC`}
    >
      <span className="tabular whitespace-nowrap">
        <span className={tight ? 'text-warn' : undefined}>{quota.brickeconomy}</span>/{quota.limit}
      </span>
      <span className="hidden sm:inline">BrickEconomy today</span>
      <span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
        <span
          className={`block h-full rounded-full transition-[width] duration-200 ${tight ? 'bg-warn' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </span>

      {quota.brickset > 0 ? (
        <span className="tabular hidden whitespace-nowrap border-l border-border pl-2 sm:inline">
          {quota.brickset} Brickset
        </span>
      ) : null}
    </div>
  );
}
