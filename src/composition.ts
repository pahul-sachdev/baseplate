import { installApiLog } from './db/apiLog.ts';
import { getProvenance, type Provenance } from './db/brickeconomy/source.ts';
import { prisma } from './db/client.ts';
import { systemClock } from './db/clock.ts';
import { brickEconomyCatalogProvider } from './db/providers/catalogProvider.ts';
import { mockPartOutProvider } from './db/providers/partOutProvider.ts';
import { brickEconomyValueProvider } from './db/providers/valueProvider.ts';
import { prismaValuationStore } from './db/valuationStore.ts';
import type { EngineDeps } from './lib/ports.ts';

/**
 * The composition root: the only place that knows which implementations back the ports.
 *
 * Sealed/used values and set metadata are live from BrickEconomy. Part-out is still mock
 * data — BrickLink keys aren't wired yet, and the provider name says so in the CLI output
 * so a mock number is never mistaken for a real one.
 */
/**
 * Persist every outbound request so the quota meter is exact. Installed here, at the wiring
 * layer, so CLI runs and web requests both count against the same daily total.
 *
 * Fire-and-forget with a swallowed rejection: a logging failure must never break a lookup, and
 * awaiting it would put a database write on the critical path of every HTTP call.
 */
installApiLog((record) => {
  void prisma.apiRequest
    .create({
      data: {
        provider: record.provider,
        setNumber: record.setNumber,
        // Undefined when the caller is about a set or a list; stored as null either way, so a
        // minifig request is auditable by number and a set request is unchanged.
        minifigNumber: record.minifigNumber ?? null,
        status: record.status,
        requestedOn: systemClock.today(),
      },
    })
    .catch(() => undefined);
});

export function buildDeps(): EngineDeps {
  return {
    values: brickEconomyValueProvider,
    partOut: mockPartOutProvider,
    catalog: brickEconomyCatalogProvider,
    store: prismaValuationStore,
    clock: systemClock,
  };
}

/** How trustworthy today's numbers are: what was estimated, and whether they are stale. */
export function getDataProvenance(setNumber: string): Promise<Provenance> {
  return getProvenance(setNumber);
}

/**
 * Strategies whose numbers come from a mock provider rather than a live source. Part-out is
 * mock until BrickLink is wired, and it is frequently the recommended play — especially now
 * that resell_used goes unavailable when a set has no used-market data.
 */
export const MOCK_BACKED_STRATEGIES: ReadonlySet<string> = new Set(['part_out']);

/** Releases the DB connection so a short-lived process can exit. */
export async function closeDeps(): Promise<void> {
  await prisma.$disconnect();
}
