import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasVariantSuffix, looksLikeSetNumber, searchKey, withVariantSuffix } from './setNumber.ts';

describe('withVariantSuffix', () => {
  it('appends -1 to a bare number', () => {
    assert.equal(withVariantSuffix('10236'), '10236-1');
  });

  it('leaves an existing suffix alone', () => {
    assert.equal(withVariantSuffix('75192-1'), '75192-1');
  });

  it('never collapses a non-1 variant onto -1', () => {
    // 75192-2 is a genuinely different set and must not resolve to 75192-1's data.
    assert.equal(withVariantSuffix('75192-2'), '75192-2');
    assert.equal(hasVariantSuffix('75192-2'), true);
    assert.equal(hasVariantSuffix('75192'), false);
  });
});

describe('looksLikeSetNumber', () => {
  it('accepts the forms a user actually types', () => {
    assert.equal(looksLikeSetNumber('10236'), true);
    assert.equal(looksLikeSetNumber('75192-1'), true);
    assert.equal(looksLikeSetNumber('  75192  '), true);
  });

  it('rejects names, so they reach search', () => {
    assert.equal(looksLikeSetNumber('millennium falcon'), false);
    assert.equal(looksLikeSetNumber('ewok village'), false);
    assert.equal(looksLikeSetNumber(''), false);
    assert.equal(looksLikeSetNumber('falcon 75192'), false);
  });

  it('sends a letter-prefixed set number to search rather than to the lookup', () => {
    // k8672-1 is a real Rebrickable number, but the safe failure is searching for it — the
    // sets endpoint matches set_num too, so it is still found.
    assert.equal(looksLikeSetNumber('k8672-1'), false);
  });
});

describe('searchKey', () => {
  it('collapses whitespace and case so one query is one request', () => {
    assert.equal(searchKey('  Millennium   FALCON '), 'millennium falcon');
    assert.equal(searchKey('millennium falcon'), 'millennium falcon');
  });
});
