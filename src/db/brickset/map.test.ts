import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapBricksetPage, mapBricksetSet } from './map.ts';
import type { BricksetSetPayload } from './types.ts';

/**
 * The Jazz Club payload, copied verbatim from a live getSets response. Kept whole rather than
 * trimmed, so the mapper is tested against the shape the API actually sends.
 */
const JAZZ_CLUB: BricksetSetPayload = {
  setID: 34386,
  number: '10312',
  numberVariant: 1,
  name: 'Jazz Club',
  year: 2023,
  theme: 'Icons',
  themeGroup: 'Model making',
  subtheme: 'Modular Buildings Collection',
  category: 'Normal',
  released: true,
  pieces: 2899,
  minifigs: 8,
  launchDate: '2023-01-01T00:00:00Z',
  exitDate: '2025-12-31T00:00:00Z',
  image: {
    thumbnailURL: 'https://images.brickset.com/sets/small/10312-1.jpg',
    imageURL: 'https://images.brickset.com/sets/images/10312-1.jpg',
  },
  availability: 'LEGO exclusive',
  LEGOCom: {
    US: {
      retailPrice: 229.99,
      dateFirstAvailable: '2022-12-15T00:00:00Z',
      dateLastAvailable: '2025-11-22T00:00:00Z',
    },
    UK: { retailPrice: 199.99 },
  },
};

describe('mapBricksetSet — the measured payload', () => {
  it('maps every field the board needs', () => {
    const row = mapBricksetSet(JAZZ_CLUB);

    assert.ok(row);
    assert.equal(row.setNumber, '10312-1');
    assert.equal(row.name, 'Jazz Club');
    assert.equal(row.theme, 'Icons');
    assert.equal(row.year, 2023);
    assert.equal(row.availability, 'LEGO exclusive');
    assert.equal(row.exitDate?.toISOString(), '2025-12-31T00:00:00.000Z');
    assert.equal(row.launchDate?.toISOString(), '2023-01-01T00:00:00.000Z');
    assert.equal(row.imageUrl, 'https://images.brickset.com/sets/images/10312-1.jpg');
  });

  it('takes MSRP from the US block only', () => {
    const row = mapBricksetSet(JAZZ_CLUB);
    // UK lists 199.99; this is a USD tool, so the UK figure must not leak into the MSRP column.
    assert.equal(row?.usRetailPrice, 229.99);
  });

  it('keeps dateLastAvailable as its own fact', () => {
    // 10312 is the reason this column exists: exitDate says 2025-12-31 (a year-end placeholder)
    // while LEGO.com actually stopped selling on 2025-11-22. Both are stored; neither is merged.
    const row = mapBricksetSet(JAZZ_CLUB);
    assert.equal(row?.usDateLastAvailable?.toISOString(), '2025-11-22T00:00:00.000Z');
    assert.notEqual(row?.exitDate?.getTime(), row?.usDateLastAvailable?.getTime());
  });
});

describe('mapBricksetSet — guarding every field', () => {
  it('maps a payload carrying nothing but a number, inventing none of it', () => {
    const row = mapBricksetSet({ number: '75192' });

    assert.deepEqual(row, {
      setNumber: '75192-1',
      name: null,
      theme: null,
      year: null,
      exitDate: null,
      launchDate: null,
      availability: null,
      usRetailPrice: null,
      usDateLastAvailable: null,
      imageUrl: null,
    });
  });

  it('defaults numberVariant to 1, matching the API', () => {
    assert.equal(mapBricksetSet({ number: '10312' })?.setNumber, '10312-1');
  });

  it('honours a real variant suffix', () => {
    assert.equal(mapBricksetSet({ number: '75192', numberVariant: 2 })?.setNumber, '75192-2');
  });

  it('returns null when there is no set number — the one field with no honest fallback', () => {
    // A fabricated primary key would collide two real sets into one row.
    assert.equal(mapBricksetSet({ name: 'Mystery Set' }), null);
    assert.equal(mapBricksetSet({ number: '   ' }), null);
  });

  it('treats an unparseable date as absent, not as the epoch', () => {
    const row = mapBricksetSet({ number: '10312', exitDate: 'not a date' });
    assert.equal(row?.exitDate, null);
  });

  it('treats an empty image URL as no image', () => {
    const row = mapBricksetSet({ number: '10312', image: { thumbnailURL: 'x' } });
    assert.equal(row?.imageUrl, null);
  });

  it('rejects a non-finite retail price rather than storing NaN', () => {
    const row = mapBricksetSet({ number: '10312', LEGOCom: { US: { retailPrice: Number.NaN } } });
    assert.equal(row?.usRetailPrice, null);
  });
});

describe('mapBricksetPage', () => {
  it('keeps the mappable rows and drops only the unusable ones', () => {
    const rows = mapBricksetPage([JAZZ_CLUB, { name: 'no number' }, { number: '10313' }]);
    assert.deepEqual(
      rows.map((row) => row.setNumber),
      ['10312-1', '10313-1'],
    );
  });

  it('maps an empty page to an empty list', () => {
    assert.deepEqual(mapBricksetPage([]), []);
  });
});
