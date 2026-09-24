import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { figHref, parseBuyRaw, parseCondition, parseFigOrigin, setReturnHref } from './figOrigin.ts';
import { MAX_FROM_LENGTH, ORIGIN_LABELS, parseOrigin } from './origin.ts';
import { isAddressableSetNumber } from './setNumber.ts';

/**
 * The figure route's back chain. The security question is the same one origin.ts answers, asked of
 * a new parameter: can anything arriving in the URL become a destination, or a word on the screen?
 */

/**
 * The rejection table from origin.test.ts, re-aimed at `inSet`. If a value cannot be a safe path,
 * it certainly cannot be a set number — and the point is that it is never treated as a path at
 * all: `inSet` is validated as a NUMBER and then handed to detailHref, which builds the URL.
 */
const HOSTILE = [
  'https://evil.com',
  '//evil.com',
  '/\\evil.com',
  '\\\\evil.com',
  'javascript:alert(1)',
  'evil.com',
  '/set/10236-1',
  '../../etc/passwd',
  '10236-1?from=/evil',
  '10236 1',
  '10236\n-1',
  '10236\t-1',
  ' /10236',
  '10236',
  'a'.repeat(MAX_FROM_LENGTH + 1),
  '<script>alert(1)</script>',
  '10236%2f..',
];

describe('parseFigOrigin — the Set → Figure → Set chain', () => {
  it('returns to the set, carrying the decision state it was opened with', () => {
    const origin = parseFigOrigin({
      inSet: '10236-1',
      cond: 'used_box',
      buy: '300',
      from: '/?q=ewok',
    });

    assert.equal(origin.kind, 'set');
    if (origin.kind !== 'set') return;
    assert.equal(origin.setNumber, '10236-1');
    assert.equal(origin.board.key, 'lookup');
    assert.match(origin.href, /^\/set\/10236-1\?/);
    assert.match(origin.href, /condition=used_box/);
    assert.match(origin.href, /buy=300/);
  });

  it('keeps the board underneath, so the set’s own back link still works', () => {
    const origin = parseFigOrigin({
      inSet: '10236-1',
      cond: undefined,
      buy: undefined,
      from: '/retiring?months=12&theme=Star+Wars',
    });
    if (origin.kind !== 'set') throw new Error('expected a set origin');
    assert.equal(origin.board.key, 'retiring');
    // The set href carries the board, so one more click gets all the way home.
    assert.equal(parseOrigin(decodeURIComponent(/from=([^&]*)/.exec(origin.href)?.[1] ?? '')).key, 'retiring');
  });

  it('falls back to the board when there is no set', () => {
    const origin = parseFigOrigin({ inSet: undefined, cond: undefined, buy: undefined, from: '/trending' });
    assert.equal(origin.kind, 'board');
    assert.equal(origin.href, '/trending');
    assert.equal(origin.label, ORIGIN_LABELS.trending);
  });

  it('falls back to Lookup when there is neither', () => {
    const origin = parseFigOrigin({ inSet: undefined, cond: undefined, buy: undefined, from: undefined });
    assert.equal(origin.kind, 'board');
    assert.equal(origin.href, '/');
    assert.equal(origin.label, ORIGIN_LABELS.lookup);
  });
});

describe('the new parameter is not a new open redirect', () => {
  it('refuses every hostile inSet, and never lets it reach an href', () => {
    for (const value of HOSTILE) {
      const origin = parseFigOrigin({ inSet: value, cond: undefined, buy: undefined, from: '/' });
      assert.equal(origin.kind, 'board', value);
      assert.equal(origin.href, '/', value);
      // The decisive assertion: the rejected text appears NOWHERE in what would be rendered.
      assert.ok(!origin.href.includes(value), value);
    }
  });

  it('refuses a repeated parameter rather than guessing which was meant', () => {
    const origin = parseFigOrigin({
      inSet: ['10236-1', '75192-1'],
      cond: undefined,
      buy: undefined,
      from: '/',
    });
    assert.equal(origin.kind, 'board');
  });

  it('never lets the URL supply a word — the label is built from the number alone', () => {
    const origin = parseFigOrigin({ inSet: '10236-1', cond: undefined, buy: undefined, from: '/' });
    if (origin.kind !== 'set') throw new Error('expected a set origin');
    assert.equal(origin.fallbackLabel, 'Set 10236-1');
    assert.ok(isAddressableSetNumber(origin.setNumber));
  });

  it('still refuses /minifig/… as a board origin, so ?from= cannot nest there either', () => {
    // origin.ts is untouched and knows nothing about figures; this pins that it stays that way.
    assert.equal(parseOrigin('/minifig/sw0509?inSet=10236-1').href, '/');
    assert.equal(parseOrigin('/minifig/sw0509').key, 'lookup');
  });

  it('bounds the chain at two hops by construction', () => {
    // A figure's origin is a set NUMBER and a set's origin is a BOARD, so a third level has
    // nowhere to live. Feeding a figure URL back in as `from` lands on Lookup.
    const nested = parseFigOrigin({
      inSet: '10236-1',
      cond: undefined,
      buy: undefined,
      from: '/minifig/sw0509?inSet=75192-1',
    });
    if (nested.kind !== 'set') throw new Error('expected a set origin');
    assert.equal(nested.board.href, '/');
    assert.ok(!nested.href.includes('sw0509'));
  });
});

describe('cond and buy are narrowed, never passed through', () => {
  it('narrows the condition to the union or drops it', () => {
    assert.equal(parseCondition('used_box'), 'used_box');
    assert.equal(parseCondition('open_box'), 'open_box');
    for (const junk of ['evil', '', 'SEALED', undefined, ['sealed', 'used_box']]) {
      assert.equal(parseCondition(junk as string | string[] | undefined), null, String(junk));
    }
  });

  it('re-serialises the buy price, so no exponent form reaches a URL', () => {
    assert.equal(parseBuyRaw('300'), '300');
    assert.equal(parseBuyRaw(' 300.50 '), '300.5');
    assert.equal(parseBuyRaw('1e3'), '1000');
  });

  it('drops a buy price that is not one', () => {
    for (const junk of ['abc', '-5', '0', '', '1e999', 'Infinity', 'NaN', '300%', '99999999999']) {
      assert.equal(parseBuyRaw(junk), '', junk);
    }
  });

  it('drops junk without throwing and still returns a usable origin', () => {
    const origin = parseFigOrigin({ inSet: '10236-1', cond: 'evil', buy: '1e999', from: '/' });
    if (origin.kind !== 'set') throw new Error('expected a set origin');
    assert.ok(!origin.href.includes('evil'));
    assert.ok(!origin.href.includes('1e999'));
    assert.ok(!origin.href.includes('Infinity'));
  });
});

describe('figHref — the link a figure row points at', () => {
  it('carries the whole chain', () => {
    const href = figHref('sw0509', {
      inSet: '10236-1',
      cond: 'used_box',
      buyRaw: '300',
      from: '/retiring?months=12',
    });
    assert.match(href, /^\/minifig\/sw0509\?/);
    assert.match(href, /inSet=10236-1/);
    assert.match(href, /cond=used_box/);
    assert.match(href, /buy=300/);
    assert.match(href, /from=%2Fretiring%3Fmonths%3D12/);
  });

  it('stays clean for the commonest case', () => {
    assert.equal(figHref('sw0509', {}), '/minifig/sw0509');
    assert.equal(figHref('sw0509', { from: '/' }), '/minifig/sw0509');
    // 'sealed' is the default the set page assumes, so carrying it is noise.
    assert.equal(figHref('sw0509', { cond: 'sealed' }), '/minifig/sw0509');
  });

  it('drops unusable values rather than encoding them', () => {
    for (const value of HOSTILE) {
      const href = figHref('sw0509', { inSet: value, from: value });
      assert.equal(href, '/minifig/sw0509', value);
    }
  });

  it('encodes a figure number that would otherwise leave the segment', () => {
    assert.equal(figHref('a/b', {}), '/minifig/a%2Fb');
  });
});

describe('the round trip is true by construction', () => {
  const CASES = [
    { setNumber: '10236-1', from: '/', cond: null, buyRaw: '' },
    { setNumber: '10236-1', from: '/?q=ewok&sort=sealed_desc', cond: 'used_box' as const, buyRaw: '300' },
    { setNumber: '75192', from: '/retiring?months=12&theme=Star+Wars', cond: 'incomplete' as const, buyRaw: '12.5' },
    { setNumber: 'k8672-1', from: '/watchlist', cond: 'open_box' as const, buyRaw: '' },
    { setNumber: 'CELEBV-1', from: '/trending', cond: null, buyRaw: '99' },
  ];

  it('figHref → parseFigOrigin lands on exactly the href setReturnHref builds', () => {
    // One writer for both directions, so Set → Figure → back cannot drift onto a different
    // decision state than the one the user left.
    for (const parts of CASES) {
      const href = figHref('sw0509', {
        inSet: parts.setNumber,
        cond: parts.cond,
        buyRaw: parts.buyRaw,
        from: parts.from,
      });
      const query = href.slice(href.indexOf('?') + 1);
      const params = new Map(
        query.split('&').map((pair) => {
          const [key = '', value = ''] = pair.split('=');
          return [key, decodeURIComponent(value)] as const;
        }),
      );
      const origin = parseFigOrigin({
        inSet: params.get('inSet'),
        cond: params.get('cond'),
        buy: params.get('buy'),
        from: params.get('from'),
      });

      if (origin.kind !== 'set') throw new Error(`expected a set origin for ${parts.setNumber}`);
      assert.equal(origin.href, setReturnHref(parts), parts.setNumber);
    }
  });

  it('a maximal retiring view survives the whole chain without collapsing to Lookup', () => {
    const board =
      '/retiring?months=24&sort=growth_desc&theme=Star+Wars&price=100-500&flags=positive&q=falcon';
    const href = figHref('sw0509', { inSet: '10236-1', cond: 'used_box', buyRaw: '300', from: board });
    assert.ok(href.length < MAX_FROM_LENGTH * 2);

    const query = href.slice(href.indexOf('?') + 1);
    const params = new Map(
      query.split('&').map((pair) => {
        const [key = '', value = ''] = pair.split('=');
        return [key, decodeURIComponent(value)] as const;
      }),
    );
    const origin = parseFigOrigin({
      inSet: params.get('inSet'),
      cond: params.get('cond'),
      buy: params.get('buy'),
      from: params.get('from'),
    });
    if (origin.kind !== 'set') throw new Error('expected a set origin');
    assert.equal(origin.board.href, board);
  });
});

describe('isAddressableSetNumber', () => {
  it('accepts every real shape this app has seen', () => {
    for (const value of ['10236-1', '75192', 'k8672-1', 'CELEBV-1', '10236']) {
      assert.ok(isAddressableSetNumber(value), value);
    }
  });

  it('refuses anything that could leave the segment', () => {
    for (const value of ['', '   ', '..', 'a/b', 'a b', 'a\\b', 'a?b', 'a#b', 'x'.repeat(33)]) {
      assert.ok(!isAddressableSetNumber(value), JSON.stringify(value));
    }
  });
});
