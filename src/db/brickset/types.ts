/**
 * The shape of Brickset's getSets response.
 *
 * Every field is optional, and that is measured rather than defensive. A set that never reached
 * retail has no `exitDate`; an old set has no `LEGOCom` block; a set with no artwork has no
 * `image.imageURL`. Nothing here may be assumed present.
 */

export interface BricksetLegoComRegion {
  retailPrice?: number;
  dateFirstAvailable?: string;
  dateLastAvailable?: string;
}

export interface BricksetSetPayload {
  setID?: number;
  number?: string;
  numberVariant?: number;
  name?: string;
  theme?: string;
  themeGroup?: string;
  subtheme?: string;
  year?: number;
  category?: string;
  released?: boolean;
  pieces?: number;
  minifigs?: number;

  /** ISO-8601 with a Z suffix, e.g. "2023-01-01T00:00:00Z". */
  launchDate?: string;
  /**
   * ISO-8601 with a Z suffix. MEASURED: frequently a year-granularity placeholder — 10312 lists
   * "2025-12-31T00:00:00Z" while LEGOCom.US.dateLastAvailable is the precise "2025-11-22". The UI
   * labels a December-31 date as an end-of-year estimate rather than presenting it as exact.
   */
  exitDate?: string;

  /** A distribution label ("LEGO exclusive", "Retail", …), not a retirement flag. */
  availability?: string;

  image?: {
    thumbnailURL?: string;
    imageURL?: string;
  };

  LEGOCom?: {
    US?: BricksetLegoComRegion;
    UK?: BricksetLegoComRegion;
    CA?: BricksetLegoComRegion;
    DE?: BricksetLegoComRegion;
  };

  bricksetURL?: string;
  lastUpdated?: string;
}

/** getSets. `matches` is the TOTAL for the query, not the page size — pagination relies on it. */
export interface BricksetSetsResponse {
  status?: string;
  matches?: number;
  message?: string;
  sets?: BricksetSetPayload[];
}

/** getKeyUsageStats. Per-day counts for the last 30 days, stamped in UTC. */
export interface BricksetKeyUsageResponse {
  status?: string;
  matches?: number;
  message?: string;
  apiKeyUsage?: Array<{ dateStamp?: string; count?: number }>;
}

/** Base for everything this adapter throws, so callers can catch one type. */
export class BricksetError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'BricksetError';
    this.status = status;
  }
}

/** Key rejected or missing. */
export class BricksetAuthError extends BricksetError {
  constructor(message: string, status: number | null = null) {
    super(message, status);
    this.name = 'BricksetAuthError';
  }
}

/**
 * Brickset's allowance is spent. Answered as HTTP 200 with
 * {"status":"error","message":"API limit exceeded"} — not a 429 — so status alone cannot
 * detect it.
 *
 * Never fatal to a page: the sync stops, records a partial run, and the board keeps serving
 * the cache with the shortfall disclosed.
 */
export class BricksetLimitError extends BricksetError {
  constructor(message: string) {
    super(message, 200);
    this.name = 'BricksetLimitError';
  }
}
