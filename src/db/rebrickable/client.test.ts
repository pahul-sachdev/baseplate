import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchSetImage,
  fetchThemes,
  RebrickableAuthError,
  RebrickableRateLimitError,
  searchSetsRaw,
} from './client.ts';

const BASE = 'https://example.test/api/v3';
// minGapMs: 0 everywhere except the throttle suite — the real 1100ms gap would otherwise be paid
// by every stubbed call in this file, not just the one case that means to measure it.
const OPTS = { apiKey: 'test-key', baseUrl: BASE, minGapMs: 0 };

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Replays scripted responses and records what was requested. */
function stubFetch(responses: Array<{ status: number; body: string }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    assert.ok(next, `unexpected extra request to ${String(url)}`);
    return new Response(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

const FALCON = {
  set_num: '75192-1',
  name: 'Millennium Falcon',
  year: 2017,
  theme_id: 171,
  num_parts: 7541,
  set_img_url: 'https://cdn.rebrickable.com/media/sets/75192-1.jpg',
};

describe('searchSetsRaw — request shape', () => {
  it('asks the list endpoint with the query and a bounded page size', async () => {
    const { impl, calls } = stubFetch([ok({ results: [] })]);

    await searchSetsRaw('millennium falcon', { ...OPTS, fetchImpl: impl });

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.origin + url.pathname, 'https://example.test/api/v3/lego/sets/');
    assert.equal(url.searchParams.get('search'), 'millennium falcon');
    assert.equal(url.searchParams.get('page_size'), '20');
  });

  it('sends the literal "key " prefix Rebrickable requires', async () => {
    const { impl, calls } = stubFetch([ok({ results: [] })]);

    await searchSetsRaw('falcon', { ...OPTS, fetchImpl: impl });

    assert.equal(calls[0]?.headers['Authorization'], 'key test-key');
    assert.equal(calls[0]?.headers['Accept'], 'application/json');
  });

  it('rejects a missing key without making a request', async () => {
    const { impl, calls } = stubFetch([]);

    await assert.rejects(
      () => searchSetsRaw('falcon', { apiKey: '', baseUrl: BASE, minGapMs: 0, fetchImpl: impl }),
      RebrickableAuthError,
    );
    assert.equal(calls.length, 0);
  });
});

describe('searchSetsRaw — mapping', () => {
  it('maps every field the dropdown shows', async () => {
    const { impl } = stubFetch([ok({ results: [FALCON] })]);

    const rows = await searchSetsRaw('falcon', { ...OPTS, fetchImpl: impl });

    assert.deepEqual(rows, [
      {
        setNumber: '75192-1',
        name: 'Millennium Falcon',
        year: 2017,
        themeId: 171,
        pieces: 7541,
        imageUrl: 'https://cdn.rebrickable.com/media/sets/75192-1.jpg',
      },
    ]);
  });

  it('reports absent fields as null rather than as 0 or an empty string', async () => {
    const { impl } = stubFetch([ok({ results: [{ set_num: '123-1', name: 'Thing' }] })]);

    const rows = await searchSetsRaw('thing', { ...OPTS, fetchImpl: impl });

    assert.equal(rows[0]?.year, null);
    assert.equal(rows[0]?.pieces, null);
    assert.equal(rows[0]?.imageUrl, null);
    assert.equal(rows[0]?.themeId, null);
  });

  it('drops rows that cannot name a set, keeping the ones that can', async () => {
    const { impl } = stubFetch([
      ok({ results: [null, 'nonsense', { name: 'no number' }, { set_num: '9-1' }, FALCON] }),
    ]);

    const rows = await searchSetsRaw('falcon', { ...OPTS, fetchImpl: impl });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.setNumber, '75192-1');
  });

  it('treats a response with no results array as no matches', async () => {
    const { impl } = stubFetch([ok({ count: 0 })]);
    assert.deepEqual(await searchSetsRaw('zzz', { ...OPTS, fetchImpl: impl }), []);
  });
});

describe('searchSetsRaw — failures are never disguised as "no matches"', () => {
  it('maps 429 to the rate limit error rather than retrying into a ban', async () => {
    const { impl } = stubFetch([{ status: 429, body: 'Too Many Requests' }]);
    await assert.rejects(
      () => searchSetsRaw('falcon', { ...OPTS, fetchImpl: impl }),
      RebrickableRateLimitError,
    );
  });

  it('maps 401 and 403 to an auth error', async () => {
    const first = stubFetch([{ status: 401, body: 'Unauthorized' }]);
    await assert.rejects(
      () => searchSetsRaw('falcon', { ...OPTS, fetchImpl: first.impl }),
      RebrickableAuthError,
    );

    const second = stubFetch([{ status: 403, body: 'Forbidden' }]);
    await assert.rejects(
      () => searchSetsRaw('falcon', { ...OPTS, fetchImpl: second.impl }),
      RebrickableAuthError,
    );
  });

  it('reports an unexpected status instead of returning an empty list', async () => {
    const { impl } = stubFetch([{ status: 503, body: 'Service Unavailable' }]);
    await assert.rejects(() => searchSetsRaw('falcon', { ...OPTS, fetchImpl: impl }), /HTTP 503/);
  });

  it('reports a 200 that is not JSON', async () => {
    const { impl } = stubFetch([{ status: 200, body: '<html>maintenance</html>' }]);
    await assert.rejects(() => searchSetsRaw('falcon', { ...OPTS, fetchImpl: impl }), /non-JSON/);
  });

  it('wraps a network failure rather than leaking it', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => searchSetsRaw('falcon', { ...OPTS, fetchImpl: impl }),
      /Could not reach Rebrickable/,
    );
  });
});

describe('fetchThemes', () => {
  it('asks for the whole list in one page and maps the parent link', async () => {
    const { impl, calls } = stubFetch([
      ok({
        next: 'https://example.test/api/v3/lego/themes/?page=2',
        results: [
          { id: 158, name: 'Star Wars', parent_id: null },
          { id: 171, name: 'Ultimate Collector Series', parent_id: 158 },
          { id: 0, name: '' },
          { name: 'no id' },
        ],
      }),
    ]);

    const themes = await fetchThemes({ ...OPTS, fetchImpl: impl });

    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.origin + url.pathname, 'https://example.test/api/v3/lego/themes/');
    assert.equal(url.searchParams.get('page_size'), '1000');
    // `next` is present and deliberately not followed: one request, or the label is not worth it.
    assert.equal(calls.length, 1);
    assert.deepEqual(themes, [
      { id: 158, name: 'Star Wars', parentId: null },
      { id: 171, name: 'Ultimate Collector Series', parentId: 158 },
    ]);
  });
});

describe('the shared throttle', () => {
  it('serialises search behind the image provider with at least a second between requests', async () => {
    const at: number[] = [];
    const impl = (async (url: string | URL | Request) => {
      at.push(Date.now());
      const body = String(url).includes('/lego/sets/?') ? { results: [] } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    // minGapMs deliberately omitted: this is the one case that exercises the real 1100ms gap,
    // and it fires a search and an image fetch together to prove they share one queue.
    const shared = { apiKey: 'test-key', baseUrl: BASE, fetchImpl: impl };
    await Promise.all([
      searchSetsRaw('millennium falcon', shared),
      fetchSetImage('75192-1', shared),
    ]);

    assert.equal(at.length, 2);
    const gap = (at[1] ?? 0) - (at[0] ?? 0);
    assert.ok(gap >= 1000, `requests were ${gap}ms apart, which would burst Rebrickable`);
  });
});
