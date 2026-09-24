import { round2 } from '../../../lib/money.ts';
import { normaliseMinifigNumber } from '../../../lib/minifigNumber.ts';
import type { MinifigFacts, MinifigPriceEvent } from '../../../lib/minifigValuePort.ts';
import type { BrickEconomyMinifig } from './types.ts';

/**
 * Raw minifigure payload -> domain facts. Pure, and it DERIVES NOTHING.
 *
 * The set mapper has a `derived` list because it can fall back — a sealed value from a retail
 * price, a no-box value from a with-box one. A figure has exactly one published number and no
 * second thing to compute it from, so there is no fallback to disclose and no `derived` here.
 *
 * In particular there is no trend. BrickEconomy publishes no growth field for a figure
 * (measured), and `price_events_new` is a list of OBSERVED prices — turning its endpoints into a
 * percentage would manufacture the one number the API declined to publish. The events are carried
 * through as the observations they are and rendered as such.
 *
 * `minifigNumber` is the number as QUERIED, normalised, not `data.minifig_number`: the snapshot
 * row is keyed by what we asked for, and using the API's echo would file a row under a key no
 * read would look for.
 */
export function mapMinifig(minifigNumber: string, data: BrickEconomyMinifig): MinifigFacts {
  return {
    minifigNumber: normaliseMinifigNumber(minifigNumber),
    name: text(data.name),
    description: text(data.description),
    theme: text(data.theme),
    subtheme: text(data.subtheme),
    year: positiveInt(data.year),
    releasedOn: text(data.released_date),
    // Null, never 0. A figure BrickEconomy has not priced is "no published value", and $0.00
    // would be a fabricated price on a screen used to decide what to pay.
    currentValueNew: money(data.current_value_new),
    appearsIn: appearsIn(data),
    priceEvents: priceEvents(data.price_events_new),
    currency: text(data.currency),
  };
}

function text(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function positiveInt(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function money(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return round2(value);
}

/**
 * The exclusivity signal: how many sets contain this figure, and which.
 *
 * Null when the payload carried neither key — "BrickEconomy did not say" is a different answer
 * from "it appears in no sets", and only the first should render as an empty slot. A present-but-
 * empty list is preserved as such.
 *
 * Note `reported` and `listed` are kept apart even here, so a figure whose count exceeds its named
 * sets is disclosed rather than smoothed over — the same discipline the set roster needs.
 */
function appearsIn(data: BrickEconomyMinifig): MinifigFacts['appearsIn'] {
  const hasList = Array.isArray(data.sets);
  const reported =
    typeof data.set_count === 'number' && Number.isFinite(data.set_count) && data.set_count >= 0
      ? Math.trunc(data.set_count)
      : null;

  if (!hasList && reported === null) return null;

  const listed: string[] = [];
  const seen = new Set<string>();
  for (const entry of hasList ? (data.sets as unknown[]) : []) {
    if (typeof entry !== 'string') continue;
    const setNumber = entry.trim();
    if (setNumber === '' || seen.has(setNumber)) continue;
    seen.add(setNumber);
    listed.push(setNumber);
  }
  return { listed, reported };
}

/** Observed price points, newest first as the API returns them. Malformed entries are dropped. */
function priceEvents(raw: unknown): MinifigPriceEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: MinifigPriceEvent[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { date, value } = entry as { date?: unknown; value?: unknown };
    if (typeof date !== 'string' || date.trim() === '') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    events.push({ date: date.trim(), value: round2(value) });
  }
  return events;
}
