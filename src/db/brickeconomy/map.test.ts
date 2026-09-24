import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_FACTORS, factorsFromEnv, mapSet } from './map.ts';
import { BrickEconomyError, type BrickEconomySet } from './types.ts';

/** Trimmed from a real 10236-1 response: retired, every value present. */
const EWOK: BrickEconomySet = {
  set_number: '10236-1',
  name: 'Ewok Village',
  theme: 'Star Wars',
  subtheme: 'Ultimate Collector Series',
  year: 2013,
  pieces_count: 1990,
  retail_price_us: 249.99,
  released_date: '2013-09-01',
  retired_date: '2016-11-29',
  retired: true,
  current_value_new: 918,
  current_value_used: 590.46,
  current_value_used_low: 550,
  current_value_used_high: 708.56,
  rolling_growth_12months: 3.11,
};

/** Trimmed from a real 75192 response: in production, so no used data and no `retired`. */
const FALCON: BrickEconomySet = {
  set_number: '75192-1',
  name: 'Millennium Falcon',
  theme: 'Star Wars',
  year: 2017,
  pieces_count: 7541,
  retail_price_us: 849.99,
  released_date: '2018-01-10',
  current_value_new: 849.99,
};

describe('mapSet — a retired set with complete data', () => {
  const { values, meta, derived } = mapSet('10236-1', EWOK);

  it('maps the observed value bands straight through', () => {
    assert.equal(values.sealed, 918);
    assert.equal(values.usedWithBox, 590.46);
    assert.equal(values.usedNoBox, 550); // current_value_used_low, the real signal
  });

  it('converts the growth percentage into a fraction', () => {
    assert.equal(values.trend, 0.0311);
  });

  it('maps the catalog fields', () => {
    assert.equal(meta.name, 'Ewok Village');
    assert.equal(meta.theme, 'Star Wars');
    assert.equal(meta.pieces, 1990);
    assert.equal(meta.msrp, 249.99);
    assert.equal(meta.releaseYear, 2013);
    assert.equal(meta.retired, true);
    assert.equal(meta.retireDate?.toISOString().slice(0, 10), '2016-11-29');
  });

  it('estimates nothing', () => {
    assert.deepEqual(derived, []);
  });
});

describe('mapSet — an in-production set with fields absent', () => {
  const { values, meta, derived } = mapSet('75192', FALCON);

  it('reports no used value rather than inventing one', () => {
    // There is no used-market signal at all for this set. A guess here would put a fabricated
    // number in front of a purchase decision; resell_used goes unavailable instead.
    assert.equal(values.usedWithBox, null);
  });

  it('reports no no-box value either, since there is nothing to scale down from', () => {
    assert.equal(values.usedNoBox, null);
  });

  it('does not list the absent bands as estimated — they are absent, not estimated', () => {
    assert.ok(!derived.includes('usedWithBox'));
    assert.ok(!derived.includes('usedNoBox'));
  });

  it('treats an absent `retired` as still in production, not as unknown', () => {
    assert.equal(meta.retired, false);
    assert.equal(meta.retireDate, null);
  });

  it('falls back to a flat trend when no growth figure is reported', () => {
    assert.equal(values.trend, 0);
  });

  it('names every estimated field so the CLI can flag them', () => {
    assert.deepEqual(derived, ['trend (no data)']);
  });
});

describe('mapSet — partial data', () => {
  it('uses current_value_used_low when present even if high is missing', () => {
    const { values, derived } = mapSet('x', { current_value_new: 100, current_value_used: 70, current_value_used_low: 61 });
    assert.equal(values.usedNoBox, 61);
    // No value band was estimated; only the absent growth figure is noted.
    assert.ok(!derived.some((d) => d.startsWith('used')));
  });

  it('falls back to last-year growth when the 12-month figure is absent', () => {
    const { values, derived } = mapSet('x', { current_value_new: 100, rolling_growth_lastyear: 4.78 });
    assert.equal(values.trend, 0.0478);
    assert.ok(derived.includes('trend (last year)'));
  });

  it('still derives no-box from an observed with-box value', () => {
    // The one surviving fallback: there IS a used signal, just not a no-box breakdown.
    const { values, derived } = mapSet('x', { current_value_new: 100, current_value_used: 70 });
    assert.equal(values.usedWithBox, 70);
    assert.equal(values.usedNoBox, 56); // 70 * 0.80
    assert.ok(derived.includes('usedNoBox'));
  });

  it('falls back to retail price when there is no current value', () => {
    const { values, derived } = mapSet('x', { retail_price_us: 49.99 });
    assert.equal(values.sealed, 49.99);
    assert.ok(derived.includes('sealed (from retail price)'));
  });

  it('throws when there is no value to work from at all', () => {
    assert.throws(() => mapSet('x', { name: 'Mystery' }), BrickEconomyError);
  });

  it('infers the release year from released_date when `year` is absent', () => {
    const { meta } = mapSet('x', { current_value_new: 10, released_date: '2019-04-01' });
    assert.equal(meta.releaseYear, 2019);
  });

  it('treats a retired_date with no `retired` flag as retired', () => {
    const { meta } = mapSet('x', { current_value_new: 10, retired_date: '2020-01-31' });
    assert.equal(meta.retired, true);
  });

  it('substitutes placeholders for missing catalog text', () => {
    const { meta } = mapSet('99999', { current_value_new: 10 });
    assert.equal(meta.name, 'Set 99999');
    assert.equal(meta.theme, 'Unknown');
    assert.equal(meta.pieces, 0);
  });
});

describe('mapSet — set number identity', () => {
  it('keys the set by the number as queried, not the API’s canonical form', () => {
    // The engine writes Set and Valuation rows under the number it was asked for; using
    // data.set_number here would break the Valuation foreign key.
    const { meta } = mapSet('10236', EWOK);
    assert.equal(meta.setNumber, '10236');
  });
});

describe('derivation factors', () => {
  it('honours the env override for the no-box fallback', () => {
    const factors = factorsFromEnv({ USED_NOBOX_FACTOR: '0.75' });
    assert.equal(factors.usedNoBoxFromUsed, 0.75);

    // usedWithBox observed, used_low absent -> scaled by the override.
    const { values } = mapSet('x', { current_value_new: 100, current_value_used: 80 }, factors);
    assert.equal(values.usedNoBox, 60); // 80 * 0.75
  });

  it('falls back to defaults on missing or nonsense values', () => {
    assert.deepEqual(factorsFromEnv({}), DEFAULT_FACTORS);
    assert.deepEqual(factorsFromEnv({ USED_NOBOX_FACTOR: 'abc' }), DEFAULT_FACTORS);
    assert.deepEqual(factorsFromEnv({ USED_NOBOX_FACTOR: '-1' }), DEFAULT_FACTORS);
  });
});
