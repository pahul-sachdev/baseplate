import { MINIFIG_ID_RULES } from './minifigNumber.ts';
import type { MinifigPreview } from './minifigPreview.ts';

/**
 * Planning a "value the remaining figures" click.
 *
 * The plan is computed on the SERVER from the current cache, so the number on the button cannot be
 * inflated by a stale client, and it is the number the batch will actually spend — never a round
 * one. Nothing here performs a request; it decides what a request loop would be allowed to do.
 *
 * Pure and DOM-free, like the rest of src/lib.
 */

/**
 * The most requests ONE click may queue.
 *
 * This is a BUDGET guard, not a rate guard. Measured 2026-07-30: seven BrickEconomy requests in
 * 9.2 seconds drew no 429, so the widely-repeated "4 requests per minute" figure is not enforced —
 * the real ceiling is the published 100 per DAY. A cap still matters because a 22-figure castle is
 * 22% of a day's allowance, and no single click should be able to spend that silently.
 *
 * Env: MINIFIG_BATCH_MAX.
 */
export const DEFAULT_MINIFIG_BATCH_MAX = 4;

/**
 * Minimum gap between two minifig requests, in ms.
 *
 * 1100 matches the Rebrickable client's convention — deliberately conservative for an API that
 * publishes no per-minute allowance, and cheap: a full 4-figure batch takes about four seconds.
 * An earlier draft used 15500 to respect a reported 4/min ceiling; the recon above disproved it,
 * and pacing that a measurement does not support is just a slower app.
 *
 * Env: BRICKECONOMY_MIN_GAP_MS.
 */
export const DEFAULT_MINIFIG_GAP_MS = 1100;

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < 1 || parsed > max) return fallback;
  return parsed;
}

/** Takes a plain record rather than NodeJS.ProcessEnv, like factorsFromEnv. */
export function minifigBatchMaxFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return readPositiveInt(env['MINIFIG_BATCH_MAX'], DEFAULT_MINIFIG_BATCH_MAX, 50);
}

export function minifigGapFromEnv(env: Record<string, string | undefined> = process.env): number {
  return readPositiveInt(env['BRICKECONOMY_MIN_GAP_MS'], DEFAULT_MINIFIG_GAP_MS, 120_000);
}

/** Why one id is not in this batch. A total Record supplies the words. */
export type BatchSkipReason =
  | 'valued_today'
  | 'valued_earlier'
  | 'no_price_today'
  | 'absent'
  | 'unaddressable'
  | 'not_batchable'
  | 'unreadable'
  | 'over_cap';

export const BATCH_SKIP_NOTES: Readonly<Record<BatchSkipReason, string>> = {
  valued_today: 'already valued today — costs nothing and is not re-fetched',
  valued_earlier:
    'already has a value, from an earlier day — bulk valuing does not re-fetch it, because ' +
    'replacing a price you already have is a Refresh and belongs to its own click',
  no_price_today: 'BrickEconomy already answered today with no value for it',
  absent: 'BrickEconomy has no record of this id — asking again needs its own click',
  unaddressable: 'cannot be looked up: this is a Rebrickable id with no BrickEconomy equivalent',
  not_batchable:
    'this id does not look like a minifigure number, so it is left out of bulk valuing — ' +
    'ask for it individually if you want to spend a request finding out',
  unreadable: 'the cached response could not be read; refresh this one individually',
  over_cap: 'beyond this click’s limit — click again to continue',
};

export interface BatchSkip {
  minifigNumber: string;
  reason: BatchSkipReason;
}

export interface BatchPlan {
  /** In roster order. At most this many requests will be ATTEMPTED. */
  askable: readonly string[];
  skipped: readonly BatchSkip[];
  /** askable.length — the number the button MUST print. Never rounded, never omitted. */
  requestCost: number;
  /** So the button can say "about four seconds" and mean it. */
  estimatedSeconds: number;
  /** Ids left over beyond the cap; a second click resumes with them. */
  remaining: number;
}

/**
 * What one click would spend.
 *
 * Skips everything that cannot benefit — already valued today, already priced today, permanently
 * absent, structurally unaddressable, or shaped like a part number. On Hogwarts Castle that turns
 * 24 ids into 4, which is the difference between a fifth of the daily allowance and a rounding
 * error.
 *
 * Resumable by construction: every success writes a snapshot that the next plan skips, so a
 * second click continues rather than restarting.
 */
export function planMinifigBatch(input: {
  figs: readonly MinifigPreview[];
  today: string;
  gapMs: number;
  max: number;
}): BatchPlan {
  const { figs, today, gapMs, max } = input;

  const askable: string[] = [];
  const skipped: BatchSkip[] = [];
  let remaining = 0;

  for (const fig of figs) {
    const { state, minifigNumber } = fig;

    const skip = (reason: BatchSkipReason): void => {
      skipped.push({ minifigNumber, reason });
    };

    switch (state.kind) {
      case 'valued':
        // A figure that already has a price is not "remaining", whatever day it came from.
        // Re-fetching an older one is legitimate but it is a Refresh — a deliberate per-figure
        // act, not something a bulk button decides on the user's behalf.
        skip(
          state.fetchedOn === today && state.provenance.staleFrom === null
            ? 'valued_today'
            : 'valued_earlier',
        );
        continue;
      case 'no_price':
        skip('no_price_today');
        continue;
      case 'absent':
        skip('absent');
        continue;
      case 'unaddressable':
        skip('unaddressable');
        continue;
      case 'unreadable':
        skip('unreadable');
        continue;
      case 'unvalued':
        break;
      default: {
        const exhaustive: never = state;
        throw new Error(`Unhandled minifig state: ${String(exhaustive)}`);
      }
    }

    // An id we cannot batch may still be asked about individually — refusing outright would be
    // predicting someone else's catalogue.
    if (!MINIFIG_ID_RULES[fig.idKind].batchable) {
      skip('not_batchable');
      continue;
    }

    if (askable.length >= max) {
      remaining += 1;
      skip('over_cap');
      continue;
    }
    askable.push(minifigNumber);
  }

  return {
    askable,
    skipped,
    requestCost: askable.length,
    estimatedSeconds: Math.max(0, Math.round((askable.length * gapMs) / 1000)),
    remaining,
  };
}

/** Why a batch stopped early. 'user' and 'cap' are not errors — they are honest partial results. */
export type BatchStopReason = 'user' | 'quota' | 'auth' | 'unavailable' | 'cap';

export const BATCH_STOP_NOTES: Readonly<Record<BatchStopReason, string>> = {
  user: 'Stopped. Everything already fetched has been kept.',
  quota:
    'BrickEconomy’s daily limit was reached, so the run stopped. It resets at 00:00 UTC, and ' +
    'everything already fetched has been kept.',
  auth: 'BrickEconomy rejected the API key, so the run stopped.',
  unavailable: 'BrickEconomy could not be reached, so the run stopped.',
  cap: 'Reached this click’s limit. Click again to continue.',
};

export type BatchOutcome =
  | { kind: 'complete'; attempted: number; valued: number; noPrice: number; absent: number }
  | {
      kind: 'stopped';
      attempted: number;
      valued: number;
      noPrice: number;
      absent: number;
      reason: BatchStopReason;
    };
