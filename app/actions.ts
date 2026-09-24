'use server';

import { revalidatePath } from 'next/cache';

import { buildDeps } from '../src/composition.ts';
import { prisma } from '../src/db/client.ts';
import { equivalentKeys } from '../src/db/brickeconomy/source.ts';
import { readSetPreviews } from '../src/db/previews.ts';
import {
  RebrickableAuthError,
  RebrickableRateLimitError,
} from '../src/db/rebrickable/client.ts';
import { rebrickableImageProvider } from '../src/db/rebrickable/imageProvider.ts';
import { searchSets } from '../src/db/rebrickable/setSearch.ts';
import { isCachedToday } from '../src/db/readModels.ts';
import { looksLikeSetNumber } from '../src/lib/setNumber.ts';
import type { CatalogHint, SetPreview } from '../src/lib/setPreview.ts';
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  type SetSearchFailure,
} from '../src/lib/setSearchPort.ts';
import type { Condition } from '../src/lib/types.ts';
import { getValuation } from '../src/lib/valuation.ts';

/**
 * The ONLY code paths permitted to spend a BrickEconomy or Rebrickable request.
 *
 * Server components render from the read models, which never call a provider. Everything here
 * runs in response to an explicit click or keystroke, so navigating and reloading the app cannot
 * cost quota.
 *
 * The split this file now encodes: browsing is free and valuing is not.
 *   - searchPreviewsAction  — Rebrickable only, and memoised. NEVER BrickEconomy, however many
 *                             sets it returns. This is what makes a twenty-card grid free.
 *   - valueSetAction        — exactly one BrickEconomy request, for one set, on one click.
 *   - refreshPreviewAction  — the same, after discarding what was cached.
 *
 * None of them takes a condition. One request fills every price band, so valuing is a per-SET act:
 * the row it writes answers the sealed question and the used ones at the same time. Condition is
 * chosen later, in the detail view, purely to pick a verdict.
 */

/**
 * The condition every write is filed under.
 *
 * The engine's cache key is (setNumber, condition, fetchedOn) and that is frozen, so a row has to
 * be labelled something. Writing them all under one label keeps the table from accumulating four
 * identical rows per set per day, and every read is condition-blind anyway.
 */
const CANONICAL_CONDITION: Condition = 'sealed';

/** Runs the engine, which fetches only when the set has no data for today. */
async function valuate(setNumber: string): Promise<void> {
  await getValuation(setNumber, CANONICAL_CONDITION, buildDeps());
}

export type PreviewSearchResponse =
  | { ok: true; previews: SetPreview[] }
  | { ok: false; reason: SetSearchFailure };

/**
 * Search, then hydrate every match from cache — one round trip.
 *
 * Rebrickable is the only provider this can reach. The previews it returns are assembled from
 * rows already on disk, so a search that matches twenty sets still spends zero BrickEconomy
 * requests; the ones with no cached numbers come back as "not valued yet" and wait for a button.
 *
 * Deliberately no revalidatePath: this reads, it does not mutate, and revalidating on every
 * keystroke would throw away the router cache for nothing.
 */
export async function searchPreviewsAction(query: string): Promise<PreviewSearchResponse> {
  // The action is publicly invokable, so the clamp lives here and not only in the component.
  const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (trimmed.length < MIN_QUERY_LENGTH) return { ok: true, previews: [] };

  // A set number resolves to itself. Searching for it would spend a Rebrickable request to be
  // told what the user just typed.
  if (looksLikeSetNumber(trimmed)) {
    return { ok: true, previews: await readSetPreviews([trimmed]) };
  }

  try {
    const results = await searchSets(trimmed);
    // The search payload is already paid for; reusing it is what gives each card a piece count
    // and a photo without a second request.
    const catalog = new Map<string, CatalogHint>(
      results.map((result) => [
        result.setNumber,
        {
          name: result.name,
          year: result.year,
          theme: result.theme,
          pieces: result.pieces,
          imageUrl: result.imageUrl,
        },
      ]),
    );
    const setNumbers = results.map((result) => result.setNumber);
    return { ok: true, previews: await readSetPreviews(setNumbers, catalog) };
  } catch (error) {
    if (error instanceof RebrickableRateLimitError) return { ok: false, reason: 'rate_limited' };
    if (error instanceof RebrickableAuthError) return { ok: false, reason: 'unconfigured' };
    // Anything else is reported as a plain failure: a raw message would leak internals into the
    // browser, and an empty list would claim "no matches" for a question we never got answered.
    return { ok: false, reason: 'unavailable' };
  }
}

export type PreviewUpdate =
  | { ok: true; preview: SetPreview }
  | { ok: false; message: string };

/**
 * Reads back the one card the caller just changed, so the grid can swap it in place.
 *
 * `catalog` is the hint the search payload already paid for. Without it the re-read falls back
 * through Brickset and the engine's own catalogue, and for a set with neither the card loses the
 * name, piece count and photo it was displaying a second earlier — a set the user could see turns
 * into a blank frame the moment they value it.
 */
async function previewFor(
  setNumber: string,
  catalog: CatalogHint | null,
): Promise<SetPreview | null> {
  const hints = new Map<string, CatalogHint>(catalog === null ? [] : [[setNumber, catalog]]);
  const [preview] = await readSetPreviews([setNumber], hints);
  return preview ?? null;
}

/**
 * Value one set. Exactly one BrickEconomy request, and only when that set has no data for today.
 *
 * Returns the updated card rather than relying on revalidatePath, because the grid lives in client
 * state and a path revalidation would never reach it. The other two boards do read from the
 * server, so they are revalidated as well.
 */
export async function valueSetAction(
  setNumber: string,
  catalog: CatalogHint | null = null,
): Promise<PreviewUpdate> {
  const trimmed = setNumber.trim();
  if (trimmed === '') return { ok: false, message: 'No set number.' };

  try {
    await valuate(trimmed);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Valuation failed' };
  }

  revalidatePath('/watchlist');
  revalidatePath('/trending');

  const preview = await previewFor(trimmed, catalog);
  return preview === null
    ? { ok: false, message: 'Valued, but the card could not be read back.' }
    : { ok: true, preview };
}

/**
 * Discard what is cached for a set, then value it again. One BrickEconomy request.
 *
 * Clears both spellings of the number: the adapter's daily snapshot would otherwise answer from
 * "10236" while the card asked about "10236-1", and the refresh would appear to do nothing.
 *
 * Clears EVERY condition too. Reads are condition-blind now, so leaving yesterday's used_box row
 * behind would let it win the re-read and make the refresh look like it did nothing.
 */
export async function refreshPreviewAction(
  setNumber: string,
  catalog: CatalogHint | null = null,
): Promise<PreviewUpdate> {
  const trimmed = setNumber.trim();
  if (trimmed === '') return { ok: false, message: 'No set number.' };
  const keys = equivalentKeys(trimmed);

  await prisma.valuation.deleteMany({ where: { setNumber: { in: keys } } });
  await prisma.setSnapshot.deleteMany({ where: { setNumber: { in: keys } } });

  try {
    await valuate(trimmed);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Refresh failed' };
  }

  revalidatePath('/watchlist');
  revalidatePath('/trending');

  const preview = await previewFor(trimmed, catalog);
  return preview === null
    ? { ok: false, message: 'Refreshed, but the card could not be read back.' }
    : { ok: true, preview };
}

/**
 * Per-set refresh. Deletes today's cached valuation so the engine refetches.
 *
 * Both deletes go through equivalentKeys. They used to match the exact string, so refreshing
 * "10236" left "10236-1"'s snapshot in place, readTodaySnapshot matched it anyway, and the button
 * spent nothing while its confirm dialog promised a request.
 */
export async function refreshSetAction(formData: FormData): Promise<void> {
  const setNumber = String(formData.get('setNumber') ?? '').trim();
  if (setNumber === '') return;
  const keys = equivalentKeys(setNumber);

  if (await isCachedToday(setNumber)) {
    await prisma.valuation.deleteMany({ where: { setNumber: { in: keys } } });
    // The adapter's own daily snapshot would otherwise answer without a network call.
    await prisma.setSnapshot.deleteMany({ where: { setNumber: { in: keys } } });
  }

  try {
    await valuate(setNumber);
  } catch {
    // A failed refresh leaves the previous data in place; the page still renders.
  }

  revalidatePath('/watchlist');
  revalidatePath('/trending');
  revalidatePath('/');
}

/** Fetches artwork for sets that have never been looked up. Throttled inside the adapter. */
export async function refreshImagesAction(formData: FormData): Promise<void> {
  const raw = String(formData.get('setNumbers') ?? '');
  const setNumbers = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');

  for (const setNumber of setNumbers) {
    try {
      // Sequential on purpose: the adapter enforces >=1 req/sec, and bursting risks an IP ban.
      await rebrickableImageProvider.getImage(setNumber);
    } catch {
      // Rate limit or auth failure: stop trying, keep whatever is cached.
      break;
    }
  }

  revalidatePath('/trending');
  revalidatePath('/watchlist');
}

/** Refreshes valuations for a list of sets. The caller confirms the request cost first. */
export async function refreshAllAction(formData: FormData): Promise<void> {
  const raw = String(formData.get('setNumbers') ?? '');
  const setNumbers = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');

  for (const setNumber of setNumbers) {
    try {
      // Skips the network entirely for sets already cached today.
      await valuate(setNumber);
    } catch {
      // Quota exhausted or set unknown: stop, keep what we have.
      break;
    }
  }

  revalidatePath('/trending');
  revalidatePath('/watchlist');
}

export async function saveSetAction(formData: FormData): Promise<void> {
  const setNumber = String(formData.get('setNumber') ?? '').trim();
  if (setNumber === '') return;

  // Idempotent: setNumber is the primary key, so a double submit cannot duplicate.
  await prisma.savedSet.upsert({
    where: { setNumber },
    create: { setNumber },
    update: {},
  });

  revalidatePath('/watchlist');
  revalidatePath('/');
}

export async function removeSetAction(formData: FormData): Promise<void> {
  const setNumber = String(formData.get('setNumber') ?? '').trim();
  if (setNumber === '') return;

  await prisma.savedSet.deleteMany({ where: { setNumber } });
  revalidatePath('/watchlist');
  revalidatePath('/');
}
