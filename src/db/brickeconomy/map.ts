import { round2 } from '../../lib/money.ts';
import type { SetMeta, ValueQuote } from '../../lib/types.ts';
import { BrickEconomyError, type BrickEconomySet } from './types.ts';

/**
 * Used only when BrickEconomy reports no observed figure, and tunable from .env because it is
 * an estimate rather than data.
 *
 * There is deliberately no sealed-to-used factor. When `current_value_used` is absent there is
 * no used-market signal at all, and inventing one would put a fabricated number in front of a
 * purchase decision; the band stays null and resell_used reports unavailable instead.
 */
export interface DerivationFactors {
  /** usedNoBox when `current_value_used_low` is absent but usedWithBox was observed. */
  usedNoBoxFromUsed: number;
}

export const DEFAULT_FACTORS: DerivationFactors = {
  usedNoBoxFromUsed: 0.8,
};

function readFactor(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Takes a plain record rather than NodeJS.ProcessEnv so callers and tests can pass a literal. */
export function factorsFromEnv(
  env: Record<string, string | undefined> = process.env,
): DerivationFactors {
  return {
    usedNoBoxFromUsed: readFactor(env['USED_NOBOX_FACTOR'], DEFAULT_FACTORS.usedNoBoxFromUsed),
  };
}

export interface MappedSet {
  values: ValueQuote;
  meta: SetMeta;
  /** Engine fields that had to be estimated because the API had no figure for them. */
  derived: string[];
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined || value === '') return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Raw payload -> engine types. Pure: every field is null-guarded, and anything estimated
 * rather than observed is named in `derived` so the CLI can say so out loud.
 *
 * `setNumber` is the number as queried, not `data.set_number`. The engine keys Set and
 * Valuation rows by what it was asked for, so using the API's canonical form here would
 * write a Set row that the Valuation foreign key cannot find.
 */
export function mapSet(
  setNumber: string,
  data: BrickEconomySet,
  factors: DerivationFactors = DEFAULT_FACTORS,
): MappedSet {
  const derived: string[] = [];

  // Everything else hangs off the sealed value, so this is the one field we cannot invent.
  const sealedSource = data.current_value_new ?? data.retail_price_us;
  if (sealedSource === undefined) {
    throw new BrickEconomyError(
      `BrickEconomy returned no current_value_new or retail_price_us for "${setNumber}" — ` +
        'nothing to value it from',
    );
  }
  if (data.current_value_new === undefined) derived.push('sealed (from retail price)');
  const sealed = round2(sealedSource);

  // Measured: an in-production set has no used values at all. That is a real answer, so it
  // stays null and the strategy becomes unavailable downstream — no invented number.
  const usedWithBox =
    data.current_value_used === undefined ? null : round2(data.current_value_used);

  // current_value_used_low is the real no-box signal; the factor is only a fallback, and only
  // meaningful when there is an observed with-box value to scale down from.
  let usedNoBox: number | null;
  if (data.current_value_used_low !== undefined) {
    usedNoBox = round2(data.current_value_used_low);
  } else if (usedWithBox !== null) {
    usedNoBox = round2(usedWithBox * factors.usedNoBoxFromUsed);
    derived.push('usedNoBox');
  } else {
    usedNoBox = null;
  }

  // The API reports growth as a percentage (3.11 = +3.11%); the engine stores a fraction.
  const growthPercent = data.rolling_growth_12months ?? data.rolling_growth_lastyear;
  if (data.rolling_growth_12months === undefined) {
    derived.push(data.rolling_growth_lastyear === undefined ? 'trend (no data)' : 'trend (last year)');
  }
  const trend = growthPercent === undefined ? 0 : Math.round(growthPercent * 100) / 10_000;

  const retireDate = parseDate(data.retired_date);
  const values: ValueQuote = { sealed, usedWithBox, usedNoBox, trend };
  const meta: SetMeta = {
    setNumber,
    name: data.name ?? `Set ${setNumber}`,
    theme: data.theme ?? 'Unknown',
    pieces: data.pieces_count ?? 0,
    msrp: round2(data.retail_price_us ?? 0),
    releaseYear: data.year ?? parseDate(data.released_date)?.getUTCFullYear() ?? 0,
    retireDate,
    // Absent means "still in production", not "unknown".
    retired: data.retired ?? retireDate !== null,
  };

  return { values, meta, derived };
}
