'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

// Importing the composition root is what installs the ApiRequest sink. Without it the Brickset
// sync would spend requests that never reach the log, and the meter would quietly under-report.
import { buildDeps } from '../../src/composition.ts';
import { syncBricksetSets } from '../../src/db/brickset/sync.ts';
import { getValuation } from '../../src/lib/valuation.ts';

/**
 * The only code paths on this page permitted to spend a request — one for Brickset, one for
 * BrickEconomy. /retiring itself renders from cache and cannot reach either.
 */

function retiringPath(months: string): string {
  return months === '' ? '/retiring' : `/retiring?months=${encodeURIComponent(months)}`;
}

/**
 * Pulls the recent-years window from Brickset. Full on first run, incremental after.
 *
 * Never throws for the expected failures: syncBricksetSets records a partial or failed run and
 * returns the reason, which the page then shows. A crash here would lose the rows already
 * written and leave the user with a blank screen instead of an explanation.
 */
export async function syncRetiringAction(formData: FormData): Promise<void> {
  const force = String(formData.get('force') ?? '') === '1';

  await syncBricksetSets({ force });

  revalidatePath('/retiring');
}

/**
 * Values one set from the board. Runs the same cache-first engine path as Lookup, so it spends a
 * BrickEconomy request only when that set has no data for today — and exactly one, never a batch.
 */
export async function valueRetiringSetAction(formData: FormData): Promise<void> {
  const setNumber = String(formData.get('setNumber') ?? '').trim();
  const months = String(formData.get('months') ?? '').trim();
  if (setNumber === '') return;

  let failure: string | null = null;
  try {
    await getValuation(setNumber, 'sealed', buildDeps());
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Valuation failed';
  }

  revalidatePath('/retiring');

  if (failure !== null) {
    const params = new URLSearchParams({ error: failure });
    if (months !== '') params.set('months', months);
    redirect(`/retiring?${params.toString()}`);
  }
  redirect(retiringPath(months));
}
