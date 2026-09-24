import { BrickEconomyError } from '../types.ts';

/**
 * The shape of BrickEconomy's `data` node for GET /api/v1/minifig/{minifigNumber}.
 *
 * MEASURED 2026-07-30 against the live API — six successful payloads (sw0509, sw0011a, cas559,
 * twn417, idea099, hp159) all returned exactly these twelve keys and no others:
 *
 *   minifig_number, name, description, set_count, sets, theme, subtheme, year, released_date,
 *   current_value_new, price_events_new, currency
 *
 * Every field is optional anyway. The set payload taught that lesson — an in-production set
 * returns no `retired`, no used values and no growth — and nothing here may be assumed present
 * either. In particular `current_value_new` may be absent for a figure BrickEconomy has not
 * priced, and that must render as "no published value", never as $0.00.
 *
 * WHAT A MINIFIGURE DOES NOT HAVE, confirmed rather than assumed:
 *   - no current_value_used / _low / _high  — there is no used band for a figure
 *   - no forecast_value_new_2_years / _5_years
 *   - no rolling_growth_12months / _lastyear — so no trend, and no forecast tier
 *   - no retail_price_us, no retired / retired_date, no availability, no image
 *
 * WHAT ONLY A MINIFIGURE HAS: description, set_count, sets — and the last two are the
 * exclusivity signal, which therefore needs no BrickLink access at all.
 */
export interface BrickEconomyMinifig {
  minifig_number?: string;
  name?: string;
  description?: string;

  /** Number of sets this figure appears in. sw0509 returns 1; sw0011a returns 16. */
  set_count?: number;
  /** The set numbers containing it, in the app's usual "10236-1" form. */
  sets?: string[];

  theme?: string;
  subtheme?: string;
  year?: number;
  released_date?: string;

  /** The only money figure published for a figure. */
  current_value_new?: number;
  /** The last 12 recorded price changes, same shape as a set's. */
  price_events_new?: MinifigPriceEventPayload[];

  currency?: string;
}

export interface MinifigPriceEventPayload {
  date?: string;
  value?: number;
}

export interface BrickEconomyMinifigResponse {
  data?: BrickEconomyMinifig;
}

/**
 * 400/404 — BrickEconomy has no minifigure with this number.
 *
 * MEASURED: GET /api/v1/minifig/90398pb015 answers HTTP 400 with the bare body `Bad Request`
 * (not JSON, so no error code can be extracted and the status is what decides). Twenty ids of
 * that shape sit in this database's figure lists, which is exactly why this error is the one
 * thing that writes a permanent MinifigAbsence row.
 *
 * A separate class from BrickEconomyUnknownSetError so that a figure's absence can never be
 * confused with a set's, and so the absence-writing branch can be a single instanceof check.
 */
export class BrickEconomyUnknownMinifigError extends BrickEconomyError {
  readonly minifigNumber: string;

  constructor(minifigNumber: string, status: number) {
    super(`BrickEconomy has no minifigure "${minifigNumber}"`, status);
    this.name = 'BrickEconomyUnknownMinifigError';
    this.minifigNumber = minifigNumber;
  }
}
