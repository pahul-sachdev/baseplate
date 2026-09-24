import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { equivalentKeys } from './source.ts';

describe('equivalentKeys — which set numbers may share a cached snapshot', () => {
  it('treats a bare number and its -1 variant as the same set', () => {
    assert.deepEqual(equivalentKeys('10236'), ['10236', '10236-1']);
    assert.deepEqual(equivalentKeys('10236-1'), ['10236-1', '10236']);
  });

  it('never collapses a non-1 variant onto the bare number', () => {
    // 75192-2 is a different set from 75192-1. Serving one as the other would report
    // the wrong prices entirely.
    assert.deepEqual(equivalentKeys('75192-2'), ['75192-2']);
    assert.deepEqual(equivalentKeys('75192-13'), ['75192-13']);
  });

  it('handles letter-suffixed numbers as opaque', () => {
    assert.deepEqual(equivalentKeys('10236a'), ['10236a', '10236a-1']);
  });
});
