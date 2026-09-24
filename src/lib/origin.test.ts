import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ORIGIN,
  ORIGIN_LABELS,
  detailHref,
  isSafeInternalPath,
  parseOrigin,
  type OriginKey,
} from './origin.ts';

describe('parseOrigin — the pages it knows', () => {
  it('names each origin correctly', () => {
    assert.deepEqual(parseOrigin('/'), { key: 'lookup', href: '/', label: 'Lookup' });
    assert.deepEqual(parseOrigin('/watchlist'), {
      key: 'watchlist',
      href: '/watchlist',
      label: 'Watchlist',
    });
    assert.deepEqual(parseOrigin('/trending'), {
      key: 'trending',
      href: '/trending',
      label: 'Trending',
    });
    assert.deepEqual(parseOrigin('/retiring'), {
      key: 'retiring',
      href: '/retiring',
      label: 'Retiring',
    });
  });

  it('preserves the query verbatim — it is what carries a board view home', () => {
    // The retiring board's entire state: sort, theme, price range, both flags, in-board query.
    const from = '/retiring?months=12&sort=value&theme=Star%20Wars&min=50&max=300&pos=1&valued=1&q=falcon';
    const origin = parseOrigin(from);
    assert.equal(origin.href, from);
    assert.equal(origin.label, 'Retiring');
  });

  it('preserves a Lookup query, so a search survives the round trip', () => {
    assert.equal(parseOrigin('/?q=falcon&sort=sealed_asc').href, '/?q=falcon&sort=sealed_asc');
  });

  it('accepts a query on Trending, so a future filtered board needs no change here', () => {
    // Trending has no controls today. When it grows them it follows the retiring recipe, and
    // this asserts the origin layer is already ready for it.
    const from = '/trending?sort=growth&theme=Icons';
    assert.deepEqual(parseOrigin(from), { key: 'trending', href: from, label: 'Trending' });
  });

  it('strips a fragment when matching the page', () => {
    assert.equal(parseOrigin('/watchlist#top').key, 'watchlist');
  });
});

describe('parseOrigin — everything it refuses', () => {
  /** Each of these must fall back WHOLLY to Lookup: href included, not just the label. */
  const rejected: ReadonlyArray<readonly [string, string | string[] | undefined]> = [
    ['nothing at all', undefined],
    ['an empty string', ''],
    ['an absolute URL', 'https://evil.com'],
    ['a protocol-relative URL', '//evil.com'],
    ['a backslash escape browsers normalise to //', '/\\evil.com'],
    ['a double backslash', '\\\\evil.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a bare host', 'evil.com'],
    ['a relative path with no leading slash', 'trending'],
    ['a newline', '/trending\nX'],
    ['a tab', '/trending\tX'],
    ['a leading space', ' /trending'],
    ['a DEL character', '/trending\u007fX'],
    ['an over-long path', `/trending?q=${'a'.repeat(600)}`],
    ['an unknown page', '/admin'],
    ['a path that merely starts like a known one', '/trendingXYZ'],
    ['the detail route itself, so ?from= cannot nest', '/set/10236-1?from=/set/75192-1'],
    // The figure route is not an origin either. Set → Figure → back-to-Set travels in scalar
    // parameters (see src/lib/figOrigin.ts) precisely so this file never has to learn about it.
    ['the minifig route, so ?from= cannot nest there either', '/minifig/sw0509?inSet=10236-1'],
    ['a repeated ?from=, where intent is unknowable', ['/trending', '/watchlist']],
  ];

  for (const [name, value] of rejected) {
    it(`falls back to Lookup for ${name}`, () => {
      assert.deepEqual(parseOrigin(value), DEFAULT_ORIGIN);
    });
  }

  it('never lets the URL supply the label', () => {
    // The words on the button come from ORIGIN_LABELS or they do not render at all.
    const labels = Object.values(ORIGIN_LABELS);
    for (const [, value] of rejected) {
      assert.ok(labels.includes(parseOrigin(value).label));
    }
  });
});

describe('isSafeInternalPath', () => {
  it('accepts an ordinary internal path', () => {
    assert.equal(isSafeInternalPath('/retiring?sort=value'), true);
    assert.equal(isSafeInternalPath('/'), true);
  });

  it('rejects the off-origin forms', () => {
    assert.equal(isSafeInternalPath('//evil.com'), false);
    assert.equal(isSafeInternalPath('/\\evil.com'), false);
    assert.equal(isSafeInternalPath('https://evil.com'), false);
    assert.equal(isSafeInternalPath(undefined), false);
  });
});

describe('detailHref', () => {
  it('carries the origin, encoded', () => {
    assert.equal(detailHref('10236-1', '/trending'), '/set/10236-1?from=%2Ftrending');
  });

  it('omits ?from= for Lookup, which is already the fallback', () => {
    assert.equal(detailHref('10236-1', '/'), '/set/10236-1');
  });

  it('drops an unsafe origin rather than encoding it into the link', () => {
    // A URL that carries a value the detail page will reject only invites someone to trust it.
    assert.equal(detailHref('10236-1', '//evil.com'), '/set/10236-1');
    assert.equal(detailHref('10236-1', 'javascript:alert(1)'), '/set/10236-1');
  });

  it('encodes a set number that would otherwise change the path', () => {
    assert.equal(detailHref('a/b', '/'), '/set/a%2Fb');
    assert.equal(detailHref('k 8672', '/'), '/set/k%208672');
  });

  it('round-trips every origin through the link and back', () => {
    const origins = [
      '/',
      '/watchlist',
      '/trending',
      '/retiring?months=12&sort=opportunity&theme=Star%20Wars&pos=1',
      '/?q=millennium%20falcon&sort=sealed_desc',
    ];
    for (const from of origins) {
      const href = detailHref('10236-1', from);
      // Undo what the href builder did to `from`, the way the framework hands it to the page.
      const encoded = href.includes('?from=') ? href.slice(href.indexOf('?from=') + 6) : undefined;
      const decoded = encoded === undefined ? undefined : decodeURIComponent(encoded);
      assert.equal(parseOrigin(decoded).href, from);
    }
  });
});

describe('ORIGIN_LABELS', () => {
  it('labels every origin', () => {
    for (const key of Object.keys(ORIGIN_LABELS) as OriginKey[]) {
      assert.ok(ORIGIN_LABELS[key].length > 0);
    }
  });
});
