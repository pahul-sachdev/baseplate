import { round2 } from '../../lib/money.ts';
import type { BricksetSetPayload } from './types.ts';

/**
 * Raw Brickset payload -> a BricksetSet row. Pure, and null-guarded to the point of tedium
 * because every upstream field genuinely can be absent.
 *
 * Nothing here estimates. There is no derivation step and no equivalent of the BrickEconomy
 * adapter's `derived` list, because this table stores only what Brickset said: an absent exit
 * date becomes null and the board reports "retirement date unknown", rather than being back-
 * filled from launch dates, availability, or LEGO.com's last-available date.
 */

export interface BricksetRow {
  setNumber: string;
  name: string | null;
  theme: string | null;
  year: number | null;
  exitDate: Date | null;
  launchDate: Date | null;
  availability: string | null;
  usRetailPrice: number | null;
  usDateLastAvailable: Date | null;
  imageUrl: string | null;
}

/** Brickset dates arrive as "2023-01-01T00:00:00Z". Anything unparseable is absent, not epoch. */
function parseDate(value: string | undefined): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function finiteNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The set number in the app's canonical form: "10312-1", matching what Lookup, Trending and the
 * BrickEconomy adapter all key on. numberVariant defaults to 1, which is the API's own default
 * for a set with a single variant.
 */
function toSetNumber(payload: BricksetSetPayload): string | null {
  const number = nonEmpty(payload.number);
  if (number === null) return null;
  const variant = finiteNumber(payload.numberVariant) ?? 1;
  return `${number}-${variant}`;
}

/**
 * Returns null when the payload carries no set number — the one field with no honest fallback,
 * since it is the primary key and inventing one would collide two real sets into a single row.
 */
export function mapBricksetSet(payload: BricksetSetPayload): BricksetRow | null {
  const setNumber = toSetNumber(payload);
  if (setNumber === null) return null;

  const us = payload.LEGOCom?.US;
  const usRetailPrice = finiteNumber(us?.retailPrice);

  return {
    setNumber,
    name: nonEmpty(payload.name),
    theme: nonEmpty(payload.theme),
    year: finiteNumber(payload.year),
    exitDate: parseDate(payload.exitDate),
    launchDate: parseDate(payload.launchDate),
    availability: nonEmpty(payload.availability),
    usRetailPrice: usRetailPrice === null ? null : round2(usRetailPrice),
    usDateLastAvailable: parseDate(us?.dateLastAvailable),
    imageUrl: nonEmpty(payload.image?.imageURL),
  };
}

/** Maps a page, dropping only the entries with no usable set number. */
export function mapBricksetPage(payloads: BricksetSetPayload[]): BricksetRow[] {
  return payloads.flatMap((payload) => {
    const row = mapBricksetSet(payload);
    return row === null ? [] : [row];
  });
}
