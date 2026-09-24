'use server';

// Importing the composition root is what installs the ApiRequest sink. Without it every minifig
// request would go unlogged and the quota meter would quietly under-report — the same trap
// app/retiring/actions.ts already carries a comment about.
import '../../src/composition.ts';

import {
  askAgainMinifig,
  getMinifigLookup,
  refreshMinifig,
} from '../../src/db/brickeconomy/minifig/source.ts';
import {
  readMinifigDetail,
  readMinifigPreviews,
  readSetMinifigPanel,
  searchCachedMinifigs,
} from '../../src/db/minifigReads.ts';
import { looksLikeMinifigNumber } from '../../src/lib/minifigNumber.ts';
import type { MinifigDetail, SetMinifigPanel } from '../../src/lib/minifigPanel.ts';
import type { MinifigPreview } from '../../src/lib/minifigPreview.ts';

/**
 * The minifigure server actions.
 *
 * Split from app/actions.ts so the two features do not contend for one file, and structured the
 * same way: the reads here touch the database only, and the spends are per-figure and explicit.
 *
 * Nothing in this file values a whole set of figures in one call. The batch is the CLIENT calling
 * the single-figure action once per figure, sequentially, so no action can sleep for minutes, the
 * cost is re-planned from the cache between each one, and a stopped run keeps everything it
 * already wrote.
 */

/**
 * Re-read a set's figure panel from cache. ZERO requests.
 *
 * Called after the set itself is valued: that response carries the figure list, so a set valued a
 * moment ago goes from "no figure list" to a full roster without a navigation and without a
 * second request.
 */
export async function readSetMinifigPanelAction(setNumber: string): Promise<SetMinifigPanel | null> {
  const trimmed = setNumber.trim();
  if (trimmed === '') return null;
  return readSetMinifigPanel(trimmed);
}

/** One figure, from cache. ZERO requests. */
export async function readMinifigDetailAction(minifigNumber: string): Promise<MinifigDetail | null> {
  const trimmed = minifigNumber.trim();
  if (trimmed === '') return null;
  return readMinifigDetail(trimmed);
}

/**
 * The Lookup figure branch. ZERO requests, always — no provider is reachable from here at all.
 *
 * Two shapes, because only two are honest:
 *   - an exact figure number resolves to itself, with a Value button. No search is needed to know
 *     what "sw0509" is.
 *   - free text searches only figures ALREADY on disk, and the UI says so.
 *
 * There is no name search that could value its results, and this is not a shortcoming to work
 * around: BrickEconomy publishes no minifigure search endpoint, and Rebrickable's answers in the
 * fig-001549 id space, which has no published mapping to BrickEconomy's sw0509 — Rebrickable
 * exposes external_ids for parts but not minifigures, its bulk CSV has no BrickLink column, and
 * its staff closed the request to add one. Pretending otherwise would mean guessing which
 * BrickLink figure a Rebrickable result is, and a guess is exactly what this tool must not print.
 */
export async function searchMinifigsAction(query: string): Promise<MinifigPreview[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  if (looksLikeMinifigNumber(trimmed)) return readMinifigPreviews([trimmed]);
  return searchCachedMinifigs(trimmed);
}

export type MinifigUpdate =
  | { ok: true; preview: MinifigPreview }
  | { ok: false; message: string };

/**
 * Reads the figure back out of the cache after a lookup, so the client swaps in the full state —
 * valued, priceless or absent — rather than trying to reconstruct it from the lookup's shape.
 */
async function previewFor(minifigNumber: string): Promise<MinifigUpdate> {
  const [preview] = await readMinifigPreviews([minifigNumber]);
  return preview === undefined
    ? { ok: false, message: 'Looked it up, but the row could not be read back.' }
    : { ok: true, preview };
}

/** Turns a lookup failure into words a card can show. A refusal is not an error message. */
function messageFor(lookup: Awaited<ReturnType<typeof getMinifigLookup>>): string | null {
  if (lookup.ok) return null;
  switch (lookup.reason) {
    // Both of these are ANSWERS, not failures: the figure's own state now says so, and showing an
    // error banner on top of it would read as "something went wrong" when nothing did.
    case 'no_record':
    case 'unaddressable':
      return null;
    case 'quota':
    case 'auth':
    case 'unavailable':
      return lookup.message;
    default: {
      const exhaustive: never = lookup;
      throw new Error(`Unhandled lookup failure: ${String(exhaustive)}`);
    }
  }
}

/**
 * Value one minifigure. UP TO one BrickEconomy request.
 *
 * Zero when a non-provisional snapshot for today exists, and zero when the figure is already
 * recorded absent — which is why every button says "up to 1" rather than "1".
 */
export async function valueMinifigAction(minifigNumber: string): Promise<MinifigUpdate> {
  const trimmed = minifigNumber.trim();
  if (trimmed === '') return { ok: false, message: 'No minifigure number.' };

  let lookup: Awaited<ReturnType<typeof getMinifigLookup>>;
  try {
    lookup = await getMinifigLookup(trimmed);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Lookup failed' };
  }

  const message = messageFor(lookup);
  if (message !== null) return { ok: false, message };
  return previewFor(trimmed);
}

/** Discard this figure's cached numbers and look it up again. Up to one request. */
export async function refreshMinifigAction(minifigNumber: string): Promise<MinifigUpdate> {
  const trimmed = minifigNumber.trim();
  if (trimmed === '') return { ok: false, message: 'No minifigure number.' };

  try {
    const lookup = await refreshMinifig(trimmed);
    const message = messageFor(lookup);
    if (message !== null) return { ok: false, message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Refresh failed' };
  }
  return previewFor(trimmed);
}

/**
 * The ONE deliberate override of the permanent negative cache. Exactly one request.
 *
 * BrickEconomy may add a catalogue entry later, so refusing forever would be a permanent claim
 * built on a single observation — but retrying silently would spend quota forever.
 */
export async function askAgainMinifigAction(minifigNumber: string): Promise<MinifigUpdate> {
  const trimmed = minifigNumber.trim();
  if (trimmed === '') return { ok: false, message: 'No minifigure number.' };

  try {
    const lookup = await askAgainMinifig(trimmed);
    const message = messageFor(lookup);
    if (message !== null) return { ok: false, message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Lookup failed' };
  }
  return previewFor(trimmed);
}
