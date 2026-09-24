import { round2 } from '../../lib/money.ts';
import type { PartOutQuote, SetMeta, ValueQuote } from '../../lib/types.ts';

/**
 * Deterministic stand-in data for sets that aren't in FIXTURES, so an unfamiliar set number
 * produces plausible, reproducible output instead of an error. Same set number always yields
 * the same numbers.
 */

const THEMES = ['Star Wars', 'Icons', 'Technic', 'Ideas', 'City', 'Harry Potter', 'Ninjago', 'Marvel'];

/** FNV-1a, 32-bit. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, stable PRNG so a seed replays identically. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (next: () => number, lo: number, hi: number): number => lo + next() * (hi - lo);

/** Prices ending in .99, the way LEGO actually prices things. */
function priceish(value: number): number {
  return round2(Math.max(4.99, Math.floor(value) + 0.99));
}

interface Seeded {
  meta: SetMeta;
  values: ValueQuote;
  partOut: PartOutQuote;
}

export function seededSet(setNumber: string): Seeded {
  const next = rng(hash(setNumber));

  const pieces = Math.floor(between(next, 200, 4200));
  const msrp = priceish(pieces * between(next, 0.08, 0.12));
  const releaseYear = Math.floor(between(next, 2015, 2026));
  const retired = next() < 0.5;
  const retireDate = retired
    ? new Date(Date.UTC(releaseYear + Math.floor(between(next, 2, 5)), 11, 31))
    : null;
  const theme = THEMES[Math.floor(next() * THEMES.length)] ?? 'Icons';

  // Retired sets trade above MSRP; current ones hover around it.
  const sealed = round2(msrp * (retired ? between(next, 1.1, 1.9) : between(next, 0.85, 1.15)));
  const usedWithBox = round2(sealed * between(next, 0.62, 0.72));
  const usedNoBox = round2(usedWithBox * between(next, 0.78, 0.86));
  const partOut = round2(sealed * between(next, 1.05, 1.6));
  // 3dp — 0.1% granularity, the resolution a trend figure is actually worth.
  const trend = Math.round(between(next, -0.03, 0.08) * 1000) / 1000;

  return {
    meta: {
      setNumber,
      name: `Set ${setNumber}`,
      theme,
      pieces,
      msrp,
      releaseYear,
      retireDate,
      retired,
    },
    values: { sealed, usedWithBox, usedNoBox, trend },
    partOut: { partOut, lotCount: Math.max(1, Math.round(pieces / 8)) },
  };
}
