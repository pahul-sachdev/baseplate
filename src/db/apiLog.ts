/**
 * Records outbound API requests so the quota meter can be exact.
 *
 * This is an installable sink rather than a direct Prisma call, for one specific reason: the
 * HTTP clients are unit-tested with a stubbed fetch, and those tests must not write to a
 * database. No sink installed means recordRequest is a no-op, so the clients stay testable in
 * isolation while the real app still counts every request.
 */

export type ApiProvider = 'brickeconomy' | 'rebrickable' | 'brickset';

export interface ApiRequestRecord {
  provider: ApiProvider;
  setNumber: string | null;
  /**
   * The figure a /minifig/{n} call was about. OPTIONAL, so the five existing call sites — which
   * are all about sets or lists — compile unchanged.
   *
   * A separate field from setNumber rather than an overloaded one: "sw0509" is not a set number,
   * and a column that sometimes holds one makes every later query over ApiRequest a guess. Note
   * `provider` stays 'brickeconomy' for a figure — it is the same key, the same allowance and the
   * same meter, so a fig request must count exactly like a set request.
   */
  minifigNumber?: string | null;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
}

export type ApiLogSink = (record: ApiRequestRecord) => void;

let sink: ApiLogSink | null = null;

export function installApiLog(next: ApiLogSink): void {
  sink = next;
}

/**
 * Called from inside the HTTP clients, once per attempt — so a -1 variant retry counts twice and
 * a rejected request still counts. Never throws and never blocks: logging must not be able to
 * break a lookup.
 */
export function recordRequest(record: ApiRequestRecord): void {
  if (sink === null) return;
  try {
    sink(record);
  } catch {
    // A failed write must not take the request down with it.
  }
}
