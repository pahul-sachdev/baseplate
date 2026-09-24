import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isLookupSortKey,
  LOOKUP_SORT_OPTIONS,
  sortPreviews,
  type LookupSortKey,
} from './lookupView.ts';
import type { SetPreview } from './setPreview.ts';

const ALL_KEYS: readonly LookupSortKey[] = LOOKUP_SORT_OPTIONS.map((option) => option.key);

function preview(
  setNumber: string,
  overrides: {
    name?: string;
    year?: number | null;
    sealed?: number;
    usedWithBox?: number | null;
    usedNoBox?: number | null;
    valued?: boolean;
  } = {},
): SetPreview {
  const {
    name = `Set ${setNumber}`,
    year = 2020,
    sealed = 100,
    usedWithBox = 80,
    usedNoBox = 60,
    valued = true,
  } = overrides;

  return {
    meta: {
      setNumber,
      name,
      theme: 'Icons',
      year,
      pieces: 1000,
      msrp: 199.99,
      retireDate: null,
      imageUrl: null,
      onWatchlist: false,
    },
    valuation: valued
      ? {
          kind: 'fresh',
          fetchedOn: '2026-07-29',
          provenance: { derived: [], staleFrom: null },
          valuation: {
            setNumber,
            condition: 'sealed',
            sealed,
            usedWithBox,
            usedNoBox,
            partOut: 50,
            trend: 0.01,
            fetchedAt: new Date('2026-07-29T12:00:00Z'),
            fetchedOn: '2026-07-29',
          },
        }
      : { kind: 'none' },
  };
}

const order = (rows: readonly SetPreview[]): string[] => rows.map((row) => row.meta.setNumber);

describe('sortPreviews — reorders, never filters', () => {
  it('returns every card for every key', () => {
    const rows = [
      preview('A-1'),
      preview('B-1', { valued: false }),
      preview('C-1', { year: null, usedWithBox: null, usedNoBox: null }),
    ];

    for (const key of ALL_KEYS) {
      const sorted = sortPreviews(rows, key);
      assert.equal(sorted.length, rows.length, `${key} dropped a card`);
      assert.deepEqual([...order(sorted)].sort(), ['A-1', 'B-1', 'C-1'], `${key} lost a set`);
    }
  });

  it('does not mutate the array it was given', () => {
    const rows = [preview('A-1', { sealed: 10 }), preview('B-1', { sealed: 900 })];
    const before = order(rows);
    sortPreviews(rows, 'sealed_desc');
    assert.deepEqual(order(rows), before);
  });

  it('leaves the search order alone for "relevance"', () => {
    const rows = [preview('Z-1', { sealed: 1 }), preview('A-1', { sealed: 999 })];
    assert.deepEqual(order(sortPreviews(rows, 'relevance')), ['Z-1', 'A-1']);
  });
});

describe('sortPreviews — the keys', () => {
  it('ranks sealed price high to low', () => {
    const rows = [
      preview('LOW-1', { sealed: 10 }),
      preview('HIGH-1', { sealed: 900 }),
      preview('MID-1', { sealed: 100 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_desc')), ['HIGH-1', 'MID-1', 'LOW-1']);
  });

  it('ranks sealed price low to high', () => {
    const rows = [
      preview('LOW-1', { sealed: 10 }),
      preview('HIGH-1', { sealed: 900 }),
      preview('MID-1', { sealed: 100 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_asc')), ['LOW-1', 'MID-1', 'HIGH-1']);
  });

  it('falls back to the no-box figure for a set that has only that', () => {
    // Otherwise a set with a real used price sinks as though it had no used data at all.
    const rows = [
      preview('WITHBOX-1', { usedWithBox: 50, usedNoBox: 40 }),
      preview('NOBOXONLY-1', { usedWithBox: null, usedNoBox: 200 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'used_desc')), ['NOBOXONLY-1', 'WITHBOX-1']);
  });

  it('sorts by name and by year', () => {
    const named = [preview('B-1', { name: 'Zebra' }), preview('A-1', { name: 'Aardvark' })];
    assert.deepEqual(order(sortPreviews(named, 'name_asc')), ['A-1', 'B-1']);

    const dated = [preview('OLD-1', { year: 1999 }), preview('NEW-1', { year: 2024 })];
    assert.deepEqual(order(sortPreviews(dated, 'year_desc')), ['NEW-1', 'OLD-1']);
  });
});

describe('sortPreviews — unknowns sink, they never read as zero', () => {
  it('puts unvalued cards last on a price sort, without hiding them', () => {
    const rows = [
      preview('UNVALUED-1', { valued: false }),
      preview('CHEAP-1', { sealed: 5 }),
      preview('RICH-1', { sealed: 500 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_desc')), [
      'RICH-1',
      'CHEAP-1',
      'UNVALUED-1',
    ]);
  });

  it('puts unvalued cards last on an ASCENDING price sort too', () => {
    // The regression test for the obvious wrong implementation. Negating the descending
    // comparator also flips the nulls, and an unvalued card would lead a "lowest price first"
    // sort as though it were the cheapest thing on the page. It is not cheap; it is unknown.
    const rows = [
      preview('UNVALUED-1', { valued: false }),
      preview('CHEAP-1', { sealed: 5 }),
      preview('RICH-1', { sealed: 500 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_asc')), [
      'CHEAP-1',
      'RICH-1',
      'UNVALUED-1',
    ]);
  });

  it('puts a set with no used data last, below a genuinely cheap used one', () => {
    const rows = [
      preview('NOUSED-1', { usedWithBox: null, usedNoBox: null }),
      preview('CHEAP-1', { usedWithBox: 1 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'used_desc')), ['CHEAP-1', 'NOUSED-1']);
  });

  it('puts an unknown year last', () => {
    const rows = [preview('NOYEAR-1', { year: null }), preview('OLD-1', { year: 1980 })];
    assert.deepEqual(order(sortPreviews(rows, 'year_desc')), ['OLD-1', 'NOYEAR-1']);
  });

  it('keeps stale cards in the ranking — their prices are real, just older', () => {
    const stale = preview('STALE-1', { sealed: 900 });
    const rows = [
      preview('FRESH-1', { sealed: 10 }),
      { ...stale, valuation: { ...stale.valuation, kind: 'stale' as const } } as SetPreview,
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_desc')), ['STALE-1', 'FRESH-1']);
  });
});

describe('sortPreviews — ties fall back to search relevance', () => {
  it('keeps the incoming order when the key cannot separate two cards', () => {
    const rows = [
      preview('FIRST-1', { sealed: 100 }),
      preview('SECOND-1', { sealed: 100 }),
      preview('THIRD-1', { sealed: 100 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_desc')), [
      'FIRST-1',
      'SECOND-1',
      'THIRD-1',
    ]);
  });

  it('keeps unvalued cards in relevance order among themselves', () => {
    const rows = [
      preview('B-1', { valued: false }),
      preview('A-1', { valued: false }),
      preview('PRICED-1', { sealed: 5 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_desc')), ['PRICED-1', 'B-1', 'A-1']);
  });

  it('keeps unvalued cards in relevance order under an ascending sort as well', () => {
    const rows = [
      preview('B-1', { valued: false }),
      preview('A-1', { valued: false }),
      preview('PRICED-1', { sealed: 5 }),
    ];
    assert.deepEqual(order(sortPreviews(rows, 'sealed_asc')), ['PRICED-1', 'B-1', 'A-1']);
  });
});

describe('isLookupSortKey', () => {
  it('accepts every published option and nothing else', () => {
    for (const key of ALL_KEYS) assert.equal(isLookupSortKey(key), true);
    assert.equal(isLookupSortKey('sealed'), false);
    assert.equal(isLookupSortKey(''), false);
    assert.equal(isLookupSortKey('used_box'), false);
  });

  it('publishes sealed_asc, so a ?sort= URL for it is not silently rejected', () => {
    assert.equal(isLookupSortKey('sealed_asc'), true);
    assert.ok(ALL_KEYS.includes('sealed_asc'));
  });
});

describe('LOOKUP_SORT_OPTIONS', () => {
  it('has no duplicate keys', () => {
    assert.equal(new Set(ALL_KEYS).size, ALL_KEYS.length);
  });

  it('gives every option distinct words', () => {
    // Two sorts that read identically in the menu are two sorts a user cannot choose between —
    // the exact failure a copy-paste of the sealed_desc entry would produce.
    const labels = LOOKUP_SORT_OPTIONS.map((option) => option.label);
    assert.equal(new Set(labels).size, labels.length);
    for (const option of LOOKUP_SORT_OPTIONS) {
      assert.ok(option.label.length > 0, `${option.key} has no label`);
      assert.ok(option.hint.length > 0, `${option.key} has no hint`);
    }
  });

  it('names the direction on both sealed sorts', () => {
    const sealed = LOOKUP_SORT_OPTIONS.filter((option) => option.key.startsWith('sealed_'));
    assert.equal(sealed.length, 2);
    for (const option of sealed) assert.match(option.label, /high to low|low to high/);
  });
});
