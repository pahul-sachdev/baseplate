export type TrendDirection = 'up' | 'flat' | 'down';

/** Growth beyond ±2% a year is movement; inside that band is noise. */
const FLAT_BAND_PERCENT = 2;

/**
 * Classifies a trend. Takes the stored fraction (0.0311 = +3.11%) and applies the
 * thresholds in percentage terms: above +2% is up, below -2% is down.
 */
export function trendDirection(trend: number): TrendDirection {
  const percent = trend * 100;
  if (percent > FLAT_BAND_PERCENT) return 'up';
  if (percent < -FLAT_BAND_PERCENT) return 'down';
  return 'flat';
}
