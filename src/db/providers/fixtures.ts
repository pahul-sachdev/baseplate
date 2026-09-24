import type { PartOutQuote, SetMeta, ValueQuote } from '../../lib/types.ts';

export interface Fixture {
  meta: SetMeta;
  values: ValueQuote;
  partOut: PartOutQuote;
}

function meta(
  setNumber: string,
  name: string,
  theme: string,
  pieces: number,
  msrp: number,
  releaseYear: number,
  retireDate: string | null,
): SetMeta {
  return {
    setNumber,
    name,
    theme,
    pieces,
    msrp,
    releaseYear,
    retireDate: retireDate === null ? null : new Date(`${retireDate}T00:00:00Z`),
    retired: retireDate !== null,
  };
}

/**
 * Hand-written stand-ins for the real price APIs. Numbers are plausible market values, not
 * live quotes — they exist so the engine and CLI can be exercised end to end before keys
 * are wired.
 */
export const FIXTURES: Readonly<Record<string, Fixture>> = {
  '75192': {
    meta: meta('75192', 'Millennium Falcon (UCS)', 'Star Wars', 7541, 799.99, 2017, null),
    values: { sealed: 749.99, usedWithBox: 520, usedNoBox: 430, trend: 0.042 },
    partOut: { partOut: 812.4, lotCount: 940 },
  },
  '10307': {
    meta: meta('10307', 'Eiffel Tower', 'Icons', 10001, 629.99, 2022, null),
    values: { sealed: 599.99, usedWithBox: 430, usedNoBox: 355, trend: 0.011 },
    partOut: { partOut: 655.0, lotCount: 612 },
  },
  '21318': {
    meta: meta('21318', 'Tree House', 'Ideas', 3036, 249.99, 2019, '2022-12-31'),
    values: { sealed: 379.99, usedWithBox: 245, usedNoBox: 195, trend: 0.058 },
    partOut: { partOut: 402.5, lotCount: 418 },
  },
  '10497': {
    meta: meta('10497', 'Galaxy Explorer', 'Icons', 1254, 99.99, 2022, '2024-12-31'),
    values: { sealed: 159.99, usedWithBox: 105, usedNoBox: 82, trend: 0.033 },
    partOut: { partOut: 171.25, lotCount: 236 },
  },
  '75313': {
    meta: meta('75313', 'AT-AT (UCS)', 'Star Wars', 6785, 849.99, 2021, null),
    values: { sealed: 799.99, usedWithBox: 560, usedNoBox: 470, trend: 0.026 },
    partOut: { partOut: 884.6, lotCount: 803 },
  },
  '10276': {
    meta: meta('10276', 'Colosseum', 'Icons', 9036, 549.99, 2020, '2023-06-30'),
    values: { sealed: 719.99, usedWithBox: 500, usedNoBox: 415, trend: 0.047 },
    partOut: { partOut: 762.3, lotCount: 574 },
  },
  '71043': {
    meta: meta('71043', 'Hogwarts Castle', 'Harry Potter', 6020, 469.99, 2018, null),
    values: { sealed: 499.99, usedWithBox: 340, usedNoBox: 275, trend: 0.019 },
    partOut: { partOut: 548.75, lotCount: 889 },
  },
  '42115': {
    meta: meta('42115', 'Lamborghini Sián FKP 37', 'Technic', 3696, 379.99, 2020, '2023-12-31'),
    values: { sealed: 449.99, usedWithBox: 300, usedNoBox: 240, trend: 0.036 },
    partOut: { partOut: 486.2, lotCount: 497 },
  },
};

export function findFixture(setNumber: string): Fixture | null {
  return FIXTURES[setNumber] ?? null;
}
