import type { Clock } from '../lib/ports.ts';

/**
 * Every day-boundary decision in the app uses this one timezone, regardless of where the
 * machine running it happens to be. Change it here and the daily cache key follows.
 */
export const TZ = 'America/New_York';

// en-CA formats as YYYY-MM-DD, which is exactly the day-key shape we store.
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const systemClock: Clock = {
  today: () => dayFormatter.format(new Date()),
  now: () => new Date(),
};
