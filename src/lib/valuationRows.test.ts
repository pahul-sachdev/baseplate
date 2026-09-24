import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickValuationRow, type ValuationRowKey } from './valuationRows.ts';

/**
 * Every case below is drawn from rows that actually exist in prisma/dev.db. The ties are not
 * hypothetical: 10236-1 really does hold two conditions stamped the same second.
 */

let seq = 0;

function row(overrides: Partial<ValuationRowKey> = {}): ValuationRowKey {
  seq += 1;
  return {
    setNumber: '10236-1',
    condition: 'sealed',
    fetchedOn: '2026-07-28',
    fetchedAt: new Date('2026-07-28T16:24:59Z'),
    id: `id-${String(seq).padStart(4, '0')}`,
    ...overrides,
  };
}

describe('pickValuationRow — freshness first', () => {
  it('takes the newest day, whatever condition it was filed under', () => {
    // 10212-1: a sealed row from the 28th and a used_nobox row from the 29th.
    const older = row({ condition: 'sealed', fetchedOn: '2026-07-28' });
    const newer = row({ condition: 'used_nobox', fetchedOn: '2026-07-29' });

    assert.equal(pickValuationRow([older, newer], '10212-1'), newer);
    assert.equal(pickValuationRow([newer, older], '10212-1'), newer);
  });

  it('prefers a fresher equivalent spelling over a stale exact one', () => {
    // The reversal of the old rule. Picking the stale exact row would show a stale banner on a set
    // valued today, and offer a Refresh that spends a request for numbers already on disk.
    const staleExact = row({ setNumber: '10236-1', fetchedOn: '2026-07-28' });
    const freshBare = row({ setNumber: '10236', fetchedOn: '2026-07-29' });

    assert.equal(pickValuationRow([staleExact, freshBare], '10236-1'), freshBare);
  });

  it('still prefers the exact spelling when both were fetched the same day', () => {
    // Within a day, spelling decides — the mock part-out provider seeds off the number string, so
    // "10236" and "10236-1" carry genuinely different partOut figures.
    const bare = row({ setNumber: '10236', fetchedOn: '2026-07-28' });
    const exact = row({ setNumber: '10236-1', fetchedOn: '2026-07-28' });

    assert.equal(pickValuationRow([bare, exact], '10236-1'), exact);
    assert.equal(pickValuationRow([exact, bare], '10236'), bare);
  });
});

describe('pickValuationRow — a total order', () => {
  it('makes sealed canonical when conditions tie on the very same second', () => {
    // 10236-1's used_box and used_nobox rows share fetchedAt exactly. Without the condition rank
    // the winner would be whatever order SQLite happened to return.
    const at = new Date('2026-07-28T16:25:07Z');
    const usedBox = row({ condition: 'used_box', fetchedAt: at });
    const usedNoBox = row({ condition: 'used_nobox', fetchedAt: at });
    const sealed = row({ condition: 'sealed', fetchedAt: at });

    assert.equal(pickValuationRow([usedBox, usedNoBox, sealed], '10236-1')?.condition, 'sealed');
    assert.equal(pickValuationRow([sealed, usedNoBox, usedBox], '10236-1')?.condition, 'sealed');
    // And with no sealed row present, the order is still deterministic rather than input-order.
    assert.equal(pickValuationRow([usedNoBox, usedBox], '10236-1')?.condition, 'used_box');
    assert.equal(pickValuationRow([usedBox, usedNoBox], '10236-1')?.condition, 'used_box');
  });

  it('is independent of the order the rows arrive in', () => {
    const rows = [
      row({ condition: 'used_box', fetchedOn: '2026-07-29' }),
      row({ condition: 'sealed', fetchedOn: '2026-07-29' }),
      row({ condition: 'used_nobox', fetchedOn: '2026-07-28' }),
      row({ setNumber: '10236', condition: 'sealed', fetchedOn: '2026-07-29' }),
    ];
    const expected = pickValuationRow(rows, '10236-1');

    assert.equal(pickValuationRow([...rows].reverse(), '10236-1'), expected);
    assert.equal(pickValuationRow([rows[1]!, rows[3]!, rows[0]!, rows[2]!], '10236-1'), expected);
  });

  it('falls back to the id so two otherwise identical rows never tie', () => {
    const a = row({ id: 'aaa' });
    const b = row({ id: 'bbb' });
    assert.equal(pickValuationRow([b, a], '10236-1')?.id, 'aaa');
    assert.equal(pickValuationRow([a, b], '10236-1')?.id, 'aaa');
  });
});

describe('pickValuationRow — junk rows', () => {
  it('never lets an unrecognised condition blank a card that has a good row', () => {
    // The old code validated the row it had already chosen, so one junk row could win and then be
    // discarded, reporting "not valued yet" for a set with real numbers.
    const junk = row({ condition: 'mint_in_sealed_box', fetchedOn: '2026-07-30' });
    const good = row({ condition: 'sealed', fetchedOn: '2026-07-29' });

    assert.equal(pickValuationRow([junk, good], '10236-1'), good);
  });

  it('has no answer when every row is unusable, or when there are none', () => {
    assert.equal(pickValuationRow([row({ condition: 'nonsense' })], '10236-1'), null);
    assert.equal(pickValuationRow([], '10236-1'), null);
  });
});
