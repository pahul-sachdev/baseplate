import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ROSTER_NOTES, idShapeNote, readRoster, type RosterInput } from './minifigRoster.ts';
import { countedNotNamed, isUndercounted } from './minifigValuePort.ts';

/** Verbatim shapes from this project's cached SetSnapshot payloads. */
const EWOK_VILLAGE: RosterInput = {
  kind: 'payload',
  data: {
    minifigs_count: 17,
    minifigs: [
      'sw0011a', 'sw0236', 'sw0338', 'sw0365', 'sw0366', 'sw0367', 'sw0451', 'sw0504',
      'sw0505', 'sw0508', 'sw0509', 'sw0510', 'sw0511', 'sw0512', 'sw0513',
    ],
  },
};

/** 28 counted, 24 named, and 20 of the 24 are BrickLink part numbers. The hard case. */
const HOGWARTS: RosterInput = {
  kind: 'payload',
  data: {
    minifigs_count: 28,
    minifigs: [
      '90398pb015', '90398pb016', '90398pb017', '90398pb019', '90398pb020', '90398pb021',
      '90398pb022', '90398pb023', '90398pb024', '90398pb025', '90398pb026', '90398pb027',
      '90398pb028', '90398pb029', '90398pb030', '90398pb031', '90398pb032', '90398pb033',
      '90398pb034', '90398pb035', 'hp159', 'hp160', 'hp161', 'hp162',
    ],
  },
};

/** Count and array agree — the common case. */
const FALCON: RosterInput = {
  kind: 'payload',
  data: {
    minifigs_count: 8,
    minifigs: ['sw0532', 'sw0661', 'sw0676', 'sw0677', 'sw0700', 'sw0841', 'sw0878', 'sw0879'],
  },
};

/** Big Ben, Colosseum, the helmets: NEITHER key present. Measured on 10 of 29 snapshots. */
const NO_FIGURES: RosterInput = { kind: 'payload', data: {} };

describe('readRoster — five states that must never collapse into each other', () => {
  it('an unvalued set is no_payload, which is NOT "no minifigures"', () => {
    const roster = readRoster({ kind: 'absent' });
    assert.equal(roster.kind, 'no_payload');
  });

  it('an unparseable snapshot is unreadable, never silently "no minifigures"', () => {
    const roster = readRoster({ kind: 'unreadable', reason: 'bad JSON' });
    assert.equal(roster.kind, 'unreadable');
  });

  it('a payload that never mentions minifigures is not_listed, a claim about the LISTING', () => {
    // Every such set in this cache genuinely has no figures — but that is an inference about
    // those ten sets, not a rule, so the wording stays about what BrickEconomy listed.
    assert.equal(readRoster(NO_FIGURES).kind, 'not_listed');
  });

  it('a reported zero is `none` — the only positive claim of no minifigures', () => {
    assert.equal(readRoster({ kind: 'payload', data: { minifigs_count: 0 } }).kind, 'none');
  });

  it('all five kinds are distinct values', () => {
    const kinds = [
      readRoster({ kind: 'absent' }).kind,
      readRoster({ kind: 'unreadable', reason: 'x' }).kind,
      readRoster(NO_FIGURES).kind,
      readRoster({ kind: 'payload', data: { minifigs_count: 0 } }).kind,
      readRoster(FALCON).kind,
    ];
    assert.equal(new Set(kinds).size, 5);
  });
});

describe('readRoster — the counted-but-unnamed gap', () => {
  it('preserves Ewok Village 17-vs-15 rather than equalising it', () => {
    const roster = readRoster(EWOK_VILLAGE);
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.equal(roster.figs.listed.length, 15);
    assert.equal(roster.figs.reported, 17);
    assert.equal(countedNotNamed(roster.figs), 2);
    assert.ok(isUndercounted(roster.figs));
  });

  it('preserves Hogwarts 28-vs-24', () => {
    const roster = readRoster(HOGWARTS);
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.equal(countedNotNamed(roster.figs), 4);
  });

  it('reports no gap when the count and the array agree', () => {
    const roster = readRoster(FALCON);
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.equal(countedNotNamed(roster.figs), 0);
    assert.ok(!isUndercounted(roster.figs));
  });

  it('never reports a negative gap if a count ever came in under the array', () => {
    const roster = readRoster({ kind: 'payload', data: { minifigs_count: 1, minifigs: ['sw0509', 'sw0510'] } });
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.equal(countedNotNamed(roster.figs), 0);
  });
});

describe('readRoster — what it keeps and what it drops', () => {
  it('KEEPS part-shaped ids: what is in BrickEconomy’s catalogue is not our call', () => {
    const roster = readRoster(HOGWARTS);
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.equal(roster.figs.listed.length, 24);
    assert.ok(roster.figs.listed.includes('90398pb015'));
  });

  it('collapses a duplicate id, so the 50% sum cannot double-count', () => {
    const roster = readRoster({
      kind: 'payload',
      data: { minifigs: ['sw0509', 'sw0509', 'sw0510'], minifigs_count: 3 },
    });
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.deepEqual(roster.figs.listed, ['sw0509', 'sw0510']);
    // The count is untouched, so the collapse still shows up as a counted-but-unnamed figure.
    assert.equal(countedNotNamed(roster.figs), 1);
  });

  it('normalises case and whitespace, and preserves BrickEconomy’s order', () => {
    const roster = readRoster({ kind: 'payload', data: { minifigs: [' SW0510 ', 'sw0509'] } });
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.deepEqual(roster.figs.listed, ['sw0510', 'sw0509']);
  });

  it('counts unusable entries instead of throwing, and still returns the readable ones', () => {
    const roster = readRoster({
      kind: 'payload',
      data: { minifigs: ['sw0509', 42, null, 'a/b', '', 'sw0510'], minifigs_count: 6 },
    });
    assert.equal(roster.kind, 'listed');
    if (roster.kind !== 'listed') return;
    assert.deepEqual(roster.figs.listed, ['sw0509', 'sw0510']);
    assert.equal(roster.unreadableEntries, 4);
  });

  it('an array of nothing usable, with no count, is unreadable rather than "no minifigures"', () => {
    const roster = readRoster({ kind: 'payload', data: { minifigs: [42, null] } });
    assert.equal(roster.kind, 'unreadable');
  });

  it('never throws on a hostile or malformed payload', () => {
    const hostile: RosterInput[] = [
      { kind: 'payload', data: { minifigs: 'not-an-array' } },
      { kind: 'payload', data: { minifigs_count: -1 } },
      { kind: 'payload', data: { minifigs_count: 1.5 } },
      { kind: 'payload', data: { minifigs_count: Number.NaN } },
      { kind: 'payload', data: { minifigs: {}, minifigs_count: 'many' } },
    ];
    for (const input of hostile) assert.doesNotThrow(() => readRoster(input), JSON.stringify(input));
  });
});

describe('idShapeNote — an advisory offered before spending, never a block', () => {
  it('flags exactly the part-shaped ids in Hogwarts Castle', () => {
    const roster = readRoster(HOGWARTS);
    if (roster.kind !== 'listed') throw new Error('expected listed');
    const note = idShapeNote(roster.figs.listed);
    assert.ok(note !== null);
    assert.equal(note.unusual.length, 20);
  });

  it('says nothing when every id looks like a figure', () => {
    const roster = readRoster(FALCON);
    if (roster.kind !== 'listed') throw new Error('expected listed');
    assert.equal(idShapeNote(roster.figs.listed), null);
  });
});

describe('ROSTER_NOTES', () => {
  it('gives every non-listed kind words to render', () => {
    for (const kind of ['no_payload', 'unreadable', 'not_listed', 'none'] as const) {
      assert.ok(ROSTER_NOTES[kind].length > 0, kind);
    }
  });
});
