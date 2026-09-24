import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { SetSearchResult } from '../../lib/setSearchPort.ts';
import { RebrickableRateLimitError } from './client.ts';
import { rankSearchResults, resetSearchCaches, searchSets } from './setSearch.ts';

const BASE = 'https://example.test/api/v3';

interface StubConfig {
  sets?: unknown;
  themes?: unknown;
  setsStatus?: number;
  themesStatus?: number;
}

/** Routes by path so one stub can serve both endpoints and count each independently. */
function routingStub(config: StubConfig = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    const themes = href.includes('/lego/themes/');
    const body = themes ? (config.themes ?? { results: [] }) : (config.sets ?? { results: [] });
    const status = (themes ? config.themesStatus : config.setsStatus) ?? 200;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

  const count = (fragment: string) => calls.filter((href) => href.includes(fragment)).length;
  return { impl, calls, sets: () => count('/lego/sets/'), themes: () => count('/lego/themes/') };
}

const options = (impl: typeof fetch) => ({
  apiKey: 'test-key',
  baseUrl: BASE,
  minGapMs: 0,
  fetchImpl: impl,
});

const SETS = {
  results: [
    {
      set_num: '75192-1',
      name: 'Millennium Falcon',
      year: 2017,
      theme_id: 171,
      num_parts: 7541,
      set_img_url: 'https://cdn.rebrickable.com/media/sets/75192-1.jpg',
    },
    { set_num: '75295-1', name: 'Millennium Falcon Microfighter', year: 2021, theme_id: 158, num_parts: 101 },
  ],
};

const THEMES = {
  results: [
    { id: 158, name: 'Star Wars', parent_id: null },
    { id: 171, name: 'Ultimate Collector Series', parent_id: 158 },
  ],
};

beforeEach(() => {
  resetSearchCaches();
});

describe('searchSets — the per-day memo', () => {
  it('serves an identical query without a second request', async () => {
    const stub = routingStub({ sets: SETS, themes: THEMES });

    const first = await searchSets('millennium falcon', options(stub.impl));
    const second = await searchSets('  Millennium   FALCON  ', options(stub.impl));

    assert.equal(stub.sets(), 1);
    assert.deepEqual(first, second);
  });

  it('does not cache a rejection, so a rate limit stays retryable', async () => {
    const failing = routingStub({ setsStatus: 429 });
    await assert.rejects(
      () => searchSets('millennium falcon', options(failing.impl)),
      RebrickableRateLimitError,
    );

    const recovered = routingStub({ sets: SETS, themes: THEMES });
    const results = await searchSets('millennium falcon', options(recovered.impl));

    assert.equal(recovered.sets(), 1);
    assert.equal(results.length, 2);
  });

  it('never asks for a query too short to mean anything', async () => {
    const stub = routingStub({ sets: SETS });
    assert.deepEqual(await searchSets('m', options(stub.impl)), []);
    assert.equal(stub.calls.length, 0);
  });
});

describe('searchSets — the theme index', () => {
  it('fetches the theme list once across different queries', async () => {
    const stub = routingStub({ sets: SETS, themes: THEMES });

    await searchSets('millennium falcon', options(stub.impl));
    await searchSets('ewok village', options(stub.impl));

    assert.equal(stub.sets(), 2);
    assert.equal(stub.themes(), 1);
  });

  it('does not spend a request on themes when nothing matched', async () => {
    const stub = routingStub({ sets: { results: [] }, themes: THEMES });

    assert.deepEqual(await searchSets('zzzzz', options(stub.impl)), []);
    assert.equal(stub.themes(), 0);
  });

  it('names a known theme and prefixes a sub-theme with its root', async () => {
    const stub = routingStub({ sets: SETS, themes: THEMES });

    const results = await searchSets('millennium falcon', options(stub.impl));

    assert.equal(results[0]?.theme, 'Star Wars · Ultimate Collector Series');
    // A root theme names itself; it is not prefixed with a repeat of its own name.
    assert.equal(results[1]?.theme, 'Star Wars');
  });

  it('reports null for an id the theme list never mentioned', async () => {
    const stub = routingStub({ sets: SETS, themes: { results: [] } });

    const results = await searchSets('millennium falcon', options(stub.impl));

    assert.equal(results[0]?.theme, null);
  });

  it('still returns results when the theme list fails, and does not ask again', async () => {
    const stub = routingStub({ sets: SETS, themesStatus: 429 });

    const first = await searchSets('millennium falcon', options(stub.impl));
    assert.equal(first.length, 2);
    assert.equal(first[0]?.theme, null);

    await searchSets('ewok village', options(stub.impl));
    assert.equal(stub.themes(), 1);
  });
});

describe('rankSearchResults', () => {
  const result = (name: string, pieces: number | null, setNumber: string): SetSearchResult => ({
    setNumber,
    name,
    year: null,
    theme: null,
    pieces,
    imageUrl: null,
  });

  it('puts the exact-name match with the most pieces first', () => {
    const ranked = rankSearchResults('millennium falcon', [
      result('Millennium Falcon Microfighter', 101, '75295-1'),
      result('Mini Millennium Falcon', 87, '30057-1'),
      result('Millennium Falcon', 7541, '75192-1'),
      result('Millennium Falcon', 1351, '75257-1'),
    ]);

    assert.deepEqual(
      ranked.map((entry) => entry.setNumber),
      ['75192-1', '75257-1', '75295-1', '30057-1'],
    );
  });

  it('keeps the source order when nothing distinguishes two rows', () => {
    const ranked = rankSearchResults('falcon', [
      result('Falcon', null, 'a-1'),
      result('Falcon', null, 'b-1'),
    ]);

    assert.deepEqual(
      ranked.map((entry) => entry.setNumber),
      ['a-1', 'b-1'],
    );
  });

  it('never drops a row', () => {
    const input = [result('Something Else', 10, 'x-1'), result('Millennium Falcon', 7541, '75192-1')];
    assert.equal(rankSearchResults('millennium falcon', input).length, 2);
  });
});
