import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_MINIFIG_NUMBER_LENGTH,
  MINIFIG_ID_KINDS,
  MINIFIG_ID_RULES,
  classifyMinifigId,
  isRoutableMinifigNumber,
  looksLikeMinifigNumber,
  normaliseMinifigNumber,
} from './minifigNumber.ts';
import { looksLikeSetNumber } from './setNumber.ts';

/**
 * The corpus is REAL: every distinct prefix and every variant-letter id present in this project's
 * cached BrickEconomy set payloads on 2026-07-30, plus the twenty part-shaped ids Hogwarts Castle
 * lists among its minifigures. The classifier's whole job is to sort exactly these.
 */
const BRICKECONOMY_IDS = [
  'sw0509', 'sw0532', 'sw0661', 'cas559', 'cas579', 'gen099', 'hp159', 'hp162',
  'idea099', 'idea103', 'sim001', 'sim006', 'sp001', 'tlm001', 'twn417', 'twn423',
];

/** Seven ids in the cache carry a variant letter. It is part of the identity, never stripped. */
const VARIANT_IDS = ['sw0001c', 'sw0002a', 'sw0011a', 'sw0028a', 'sw0521b', 'sw0636b', 'twn177a'];

/** BrickLink PART numbers for microfigures. Measured: GET /minifig/90398pb015 answers HTTP 400. */
const PART_SHAPED_IDS = [
  '90398pb015', '90398pb016', '90398pb020', '90398pb027', '90398pb033', '90398pb035',
];

describe('classifyMinifigId — the three id spaces', () => {
  it('classifies every real BrickEconomy id in the cache', () => {
    for (const id of [...BRICKECONOMY_IDS, ...VARIANT_IDS]) {
      assert.equal(classifyMinifigId(id), 'brickeconomy', id);
    }
  });

  it('classifies the part-shaped ids as unclassified, never as figures', () => {
    // These must not be 'brickeconomy': they would then join a batch and burn 20 requests on 400s.
    for (const id of PART_SHAPED_IDS) {
      assert.equal(classifyMinifigId(id), 'unclassified', id);
    }
  });

  it('recognises Rebrickable ids so they can be refused with words rather than a 404', () => {
    for (const id of ['fig-001549', 'fig-000001', 'fig-0123456']) {
      assert.equal(classifyMinifigId(id), 'rebrickable', id);
    }
  });

  it('is case- and whitespace-insensitive, because a URL and a payload disagree about case', () => {
    assert.equal(classifyMinifigId('SW0509'), 'brickeconomy');
    assert.equal(classifyMinifigId('  sw0509  '), 'brickeconomy');
  });

  it('never throws, whatever arrives from a URL', () => {
    for (const raw of ['', '   ', '-', '???', 'a'.repeat(200), '../../etc/passwd', '%2e%2e']) {
      assert.doesNotThrow(() => classifyMinifigId(raw), JSON.stringify(raw));
    }
  });
});

describe('normaliseMinifigNumber — no equivalence rule, deliberately', () => {
  it('trims and lowercases', () => {
    assert.equal(normaliseMinifigNumber('  SW0509 '), 'sw0509');
  });

  it('KEEPS the variant letter — sw0011a is Chewbacca and sw0011 is a different figure', () => {
    // The set adapter's equivalentKeys() folds "10236" into "10236-1". Copying that idea here
    // would file one figure's price under another figure's name.
    assert.equal(normaliseMinifigNumber('sw0011a'), 'sw0011a');
    assert.notEqual(normaliseMinifigNumber('sw0011a'), normaliseMinifigNumber('sw0011'));
  });
});

describe('MINIFIG_ID_RULES', () => {
  it('is total over MINIFIG_ID_KINDS, so a new kind cannot ship without words', () => {
    for (const kind of MINIFIG_ID_KINDS) {
      const rule = MINIFIG_ID_RULES[kind];
      assert.ok(rule !== undefined, kind);
      assert.ok(rule.label.length > 0, `${kind} needs a label`);
    }
    assert.equal(Object.keys(MINIFIG_ID_RULES).length, MINIFIG_ID_KINDS.length);
  });

  it('never offers a button for an unaddressable id', () => {
    // There is no mapping to ask through, so a request would be a guess about which figure it is.
    assert.equal(MINIFIG_ID_RULES.rebrickable.askable, false);
    assert.equal(MINIFIG_ID_RULES.rebrickable.batchable, false);
  });

  it('lets an unclassified id be asked once, but never batched', () => {
    // Refusing outright would predict a 400; batching 20 of them would spend a fifth of the day.
    assert.equal(MINIFIG_ID_RULES.unclassified.askable, true);
    assert.equal(MINIFIG_ID_RULES.unclassified.batchable, false);
  });

  it('gives every unaskable kind a non-empty note, so nothing renders as a bare dash', () => {
    for (const kind of MINIFIG_ID_KINDS) {
      const rule = MINIFIG_ID_RULES[kind];
      if (rule.askable && rule.batchable) continue;
      assert.ok(rule.note.length > 0, `${kind} must explain itself`);
    }
  });
});

describe('looksLikeMinifigNumber — search dispatch can never be ambiguous', () => {
  it('accepts figure numbers', () => {
    for (const id of [...BRICKECONOMY_IDS, ...VARIANT_IDS]) {
      assert.ok(looksLikeMinifigNumber(id), id);
    }
  });

  it('rejects part-shaped ids, which fall through to name search', () => {
    for (const id of PART_SHAPED_IDS) assert.ok(!looksLikeMinifigNumber(id), id);
  });

  it('is disjoint from looksLikeSetNumber over the whole corpus', () => {
    for (const id of [...BRICKECONOMY_IDS, ...VARIANT_IDS, ...PART_SHAPED_IDS]) {
      assert.ok(!(looksLikeMinifigNumber(id) && looksLikeSetNumber(id)), id);
    }
  });

  it('is disjoint from looksLikeSetNumber over a generated sweep', () => {
    // A set number starts with a digit and a figure number cannot, but asserting it beats
    // believing it — a collision would make the search box silently pick the wrong lookup.
    const generated: string[] = [];
    for (let n = 1; n <= 400; n += 1) {
      generated.push(String(n), `${n}-1`, `sw${String(n).padStart(4, '0')}`, `cas${n}`, `fig-00${n}`);
    }
    for (const value of generated) {
      assert.ok(!(looksLikeMinifigNumber(value) && looksLikeSetNumber(value)), value);
    }
  });

  it('rejects free text, so typing a name still searches sets', () => {
    for (const raw of ['ewok village', 'luke', 'millennium falcon', 'sw', '0509', '']) {
      assert.ok(!looksLikeMinifigNumber(raw), raw);
    }
  });
});

describe('isRoutableMinifigNumber — a URL segment, and displayable text', () => {
  it('accepts every real id, including the unaddressable shapes', () => {
    // fig-001549 must ROUTE so the page can explain why it cannot be valued, rather than 404.
    for (const id of [...BRICKECONOMY_IDS, ...VARIANT_IDS, ...PART_SHAPED_IDS, 'fig-001549']) {
      assert.ok(isRoutableMinifigNumber(id), id);
    }
  });

  it('refuses anything that could leave the segment or carry a payload', () => {
    const refused = [
      '', '   ', 'a/b', '..', '../etc', 'a b', 'a\\b', 'a?b', 'a#b', '<script>', 'a%00',
      'x'.repeat(MAX_MINIFIG_NUMBER_LENGTH + 1),
    ];
    for (const raw of refused) assert.ok(!isRoutableMinifigNumber(raw), JSON.stringify(raw));
  });
});
