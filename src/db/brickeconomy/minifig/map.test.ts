import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapMinifig } from './map.ts';
import type { BrickEconomyMinifig } from './types.ts';

/**
 * The fixture is REAL: the verbatim `data` node BrickEconomy returned for sw0509 on 2026-07-30,
 * trimmed to three price events. Testing the mapper against an invented payload would only prove
 * the mapper agrees with the invention.
 */
const LUKE: BrickEconomyMinifig = {
  minifig_number: 'sw0509',
  name: 'Luke Skywalker',
  description:
    'Luke Skywalker is a Jedi Master who played a crucial role in the defeat of the Galactic ' +
    'Empire and the restoration of peace in the galaxy.',
  set_count: 1,
  sets: ['10236-1'],
  theme: 'Star Wars',
  subtheme: 'Ultimate Collector Series',
  year: 2013,
  released_date: '2013-09-01',
  current_value_new: 37.77,
  price_events_new: [
    { date: '2026-07-27', value: 37.77 },
    { date: '2026-07-08', value: 39.59 },
    { date: '2026-06-21', value: 39.52 },
  ],
  currency: 'USD',
};

describe('mapMinifig — the real payload', () => {
  it('maps every field BrickEconomy actually returns', () => {
    const facts = mapMinifig('sw0509', LUKE);
    assert.equal(facts.minifigNumber, 'sw0509');
    assert.equal(facts.name, 'Luke Skywalker');
    assert.equal(facts.theme, 'Star Wars');
    assert.equal(facts.subtheme, 'Ultimate Collector Series');
    assert.equal(facts.year, 2013);
    assert.equal(facts.releasedOn, '2013-09-01');
    assert.equal(facts.currentValueNew, 37.77);
    assert.equal(facts.currency, 'USD');
    assert.equal(facts.priceEvents.length, 3);
    assert.deepEqual(facts.priceEvents[0], { date: '2026-07-27', value: 37.77 });
  });

  it('carries the exclusivity signal, which needs no BrickLink access', () => {
    const facts = mapMinifig('sw0509', LUKE);
    assert.deepEqual(facts.appearsIn, { listed: ['10236-1'], reported: 1 });
  });

  it('keys on the number as QUERIED, normalised — not the API’s echo', () => {
    // The snapshot row is keyed by what was asked for. Trusting the echo would file the row
    // under a key no read would look for.
    const facts = mapMinifig('SW0509 ', { ...LUKE, minifig_number: 'something-else' });
    assert.equal(facts.minifigNumber, 'sw0509');
  });

  it('preserves a variant letter, because it is part of the identity', () => {
    assert.equal(mapMinifig('sw0011a', {}).minifigNumber, 'sw0011a');
  });
});

describe('mapMinifig — the sacred rule at the mapping boundary', () => {
  it('an unpriced figure maps to null, NEVER 0', () => {
    // $0.00 on a screen used to decide what to pay is a fabricated price.
    const facts = mapMinifig('sw0509', { ...LUKE, current_value_new: undefined });
    assert.equal(facts.currentValueNew, null);
  });

  it('treats a non-positive or non-finite value as absent rather than real', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(mapMinifig('sw0509', { ...LUKE, current_value_new: value }).currentValueNew, null, String(value));
    }
  });

  it('maps an empty payload to all-nulls without throwing', () => {
    const facts = mapMinifig('sw0509', {});
    assert.equal(facts.name, null);
    assert.equal(facts.currentValueNew, null);
    assert.equal(facts.appearsIn, null);
    assert.deepEqual(facts.priceEvents, []);
  });

  it('never invents a name from the number', () => {
    assert.equal(mapMinifig('sw0509', { ...LUKE, name: undefined }).name, null);
    assert.equal(mapMinifig('sw0509', { ...LUKE, name: '   ' }).name, null);
  });
});

describe('mapMinifig — appearsIn distinguishes three different answers', () => {
  it('null when BrickEconomy said nothing about sets', () => {
    assert.equal(mapMinifig('sw0509', { ...LUKE, sets: undefined, set_count: undefined }).appearsIn, null);
  });

  it('reported-and-empty is NOT the same as unreported', () => {
    const facts = mapMinifig('sw0509', { ...LUKE, sets: [], set_count: 0 });
    assert.deepEqual(facts.appearsIn, { listed: [], reported: 0 });
  });

  it('keeps a count that exceeds the named list rather than smoothing it over', () => {
    const facts = mapMinifig('sw0011a', { ...LUKE, sets: ['10236-1'], set_count: 16 });
    assert.deepEqual(facts.appearsIn, { listed: ['10236-1'], reported: 16 });
  });

  it('drops malformed set entries and duplicates', () => {
    const facts = mapMinifig('sw0509', {
      ...LUKE,
      sets: ['10236-1', '10236-1', '', '  ', 42 as unknown as string],
      set_count: 5,
    });
    assert.deepEqual(facts.appearsIn, { listed: ['10236-1'], reported: 5 });
  });
});

describe('mapMinifig — price events are observations, not a trend', () => {
  it('drops malformed events instead of throwing', () => {
    const facts = mapMinifig('sw0509', {
      ...LUKE,
      price_events_new: [
        { date: '2026-07-27', value: 37.77 },
        { date: '', value: 10 },
        { date: '2026-01-01' },
        { value: 5 },
        null as unknown as { date: string },
        { date: '2026-02-02', value: -3 },
      ],
    });
    assert.deepEqual(facts.priceEvents, [{ date: '2026-07-27', value: 37.77 }]);
  });

  it('tolerates a non-array', () => {
    const facts = mapMinifig('sw0509', { ...LUKE, price_events_new: 'nope' as unknown as [] });
    assert.deepEqual(facts.priceEvents, []);
  });

  it('exposes no trend, growth or forecast field at all', () => {
    // A compile-time guarantee made visible: MinifigFacts has no such key, so nothing downstream
    // can render a forecast tier for a figure off a defaulted 0 that would read "Flat".
    const facts = mapMinifig('sw0509', LUKE);
    const keys = Object.keys(facts);
    for (const forbidden of ['trend', 'growth', 'rollingGrowth12Months', 'forecast']) {
      assert.ok(!keys.includes(forbidden), `MinifigFacts must not carry ${forbidden}`);
    }
  });
});
