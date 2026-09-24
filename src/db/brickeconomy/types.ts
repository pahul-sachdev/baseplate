/**
 * The shape of BrickEconomy's `data` node.
 *
 * Every field is optional, and that is not defensive padding — it is measured. An
 * in-production set (75192) returns no `retired`, no `current_value_used*` of any kind,
 * and no `rolling_growth_12months`. A retired set (10236-1) returns all of them.
 * Nothing here may be assumed present.
 */
export interface BrickEconomySet {
  set_number?: string;
  name?: string;
  theme?: string;
  subtheme?: string;
  year?: number;
  pieces_count?: number;
  minifigs_count?: number;
  availability?: string;

  retail_price_us?: number;

  released_date?: string;
  /** Absent while a set is still in production — expected, not an error. */
  retired_date?: string;
  /** Absent (not `false`) while a set is still in production. */
  retired?: boolean;

  current_value_new?: number;
  current_value_used?: number;
  current_value_used_low?: number;
  current_value_used_high?: number;

  forecast_value_new_2_years?: number;
  forecast_value_new_5_years?: number;

  rolling_growth_12months?: number;
  rolling_growth_lastyear?: number;

  price_events_new?: PriceEvent[];
  price_events_used?: PriceEvent[];

  currency?: string;
}

export interface PriceEvent {
  date?: string;
  value?: number;
}

export interface BrickEconomyResponse {
  data?: BrickEconomySet;
}

/** Base for everything this adapter throws, so callers can catch one type. */
export class BrickEconomyError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'BrickEconomyError';
    this.status = status;
  }
}

/** 401/403 — key rejected or missing. */
export class BrickEconomyAuthError extends BrickEconomyError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'BrickEconomyAuthError';
  }
}

/** 400/404 — no such set, after the -1 variant retry. */
export class BrickEconomyUnknownSetError extends BrickEconomyError {
  readonly setNumber: string;

  constructor(setNumber: string, status: number) {
    super(`BrickEconomy has no set "${setNumber}"`, status);
    this.name = 'BrickEconomyUnknownSetError';
    this.setNumber = setNumber;
  }
}

/** 429 — the 100-request daily quota is spent. Resets 00:00 UTC. */
export class BrickEconomyQuotaError extends BrickEconomyError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'BrickEconomyQuotaError';
  }
}
