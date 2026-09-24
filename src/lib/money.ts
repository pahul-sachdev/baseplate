/** Rounds to cents. Applied at every boundary so Float money stays clean. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Rounds a value that may legitimately be absent. Null in, null out — never 0. */
export function round2OrNull(value: number | null): number | null {
  return value === null ? null : round2(value);
}

export function formatUSD(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

/**
 * A signed difference: 87.4 -> "+$87.40", -12.4 -> "-$12.40", 0 -> "$0.00".
 *
 * Separate from formatUSD because a delta reads wrong without its sign — "$87.40" in a column
 * headed "vs eBay" looks like a price, not a gain — while a plain amount reads wrong with one.
 */
export function formatUSDDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${formatUSD(value)}`;
}

/** 0.042 -> "+4.2%" */
export function formatPercent(fraction: number): string {
  const sign = fraction >= 0 ? '+' : '';
  return `${sign}${(fraction * 100).toFixed(1)}%`;
}
