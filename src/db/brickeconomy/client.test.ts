import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchSetRaw } from './client.ts';
import {
  BrickEconomyAuthError,
  BrickEconomyError,
  BrickEconomyQuotaError,
  BrickEconomyUnknownSetError,
} from './types.ts';

const OPTS = { apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' };

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

describe('fetchSetRaw — request shape', () => {
  it('uses the path form and sends all three headers', async () => {
    const { impl, calls } = stubFetch([ok({ data: { name: 'Ewok Village' } })]);

    await fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://example.test/api/v1/set/10236-1?currency=USD');
    assert.equal(calls[0]?.headers['Accept'], 'application/json');
    assert.equal(calls[0]?.headers['x-apikey'], 'test-key');
    assert.ok((calls[0]?.headers['User-Agent'] ?? '').length > 0);
  });

  it('unwraps the data node', async () => {
    const { impl } = stubFetch([ok({ data: { name: 'Ewok Village', current_value_new: 918 } })]);

    const { data } = await fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl });

    assert.equal(data.current_value_new, 918);
  });

  it('rejects when the key is missing entirely', async () => {
    const { impl } = stubFetch([]);
    await assert.rejects(
      () => fetchSetRaw('10236', { apiKey: '', fetchImpl: impl }),
      BrickEconomyAuthError,
    );
  });
});

describe('fetchSetRaw — the -1 variant retry', () => {
  it('retries once with a -1 suffix when a bare number is rejected', async () => {
    // Measured: unknown sets answer 400 with a bare "Bad Request" body, not JSON.
    const { impl, calls } = stubFetch([
      { status: 400, body: 'Bad Request' },
      ok({ data: { name: 'Ewok Village' } }),
    ]);

    const result = await fetchSetRaw('10236', { ...OPTS, fetchImpl: impl });

    assert.equal(calls.length, 2);
    assert.ok(calls[1]?.url.includes('/set/10236-1?'));
    assert.equal(result.queriedAs, '10236-1');
  });

  it('does not retry a number that already carries a variant suffix', async () => {
    const { impl, calls } = stubFetch([{ status: 400, body: 'Bad Request' }]);

    await assert.rejects(
      () => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }),
      BrickEconomyUnknownSetError,
    );
    assert.equal(calls.length, 1);
  });

  it('gives up after one retry', async () => {
    const { impl, calls } = stubFetch([
      { status: 400, body: 'Bad Request' },
      { status: 400, body: 'Bad Request' },
    ]);

    await assert.rejects(
      () => fetchSetRaw('99999999', { ...OPTS, fetchImpl: impl }),
      BrickEconomyUnknownSetError,
    );
    assert.equal(calls.length, 2);
  });

  it('treats a 200 with no data node as an unknown set', async () => {
    const { impl } = stubFetch([ok({}), ok({})]);
    await assert.rejects(
      () => fetchSetRaw('12345', { ...OPTS, fetchImpl: impl }),
      BrickEconomyUnknownSetError,
    );
  });
});

describe('fetchSetRaw — error mapping is driven by HTTP status', () => {
  it('maps 401 to an auth error even though the body is HTML', async () => {
    // Measured: a bad key returns an IIS HTML error page, with no error code anywhere.
    const { impl } = stubFetch([{ status: 401, body: '<html><title>401 - Unauthorized</title></html>' }]);

    await assert.rejects(
      () => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof BrickEconomyAuthError);
        assert.match(error.message, /BRICKECONOMY_API_KEY/);
        return true;
      },
    );
  });

  it('maps 403 to an auth error', async () => {
    const { impl } = stubFetch([{ status: 403, body: 'Forbidden' }]);
    await assert.rejects(() => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }), BrickEconomyAuthError);
  });

  it('maps 429 to a quota error naming the daily limit', async () => {
    const { impl } = stubFetch([{ status: 429, body: 'Too Many Requests' }]);

    await assert.rejects(
      () => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof BrickEconomyQuotaError);
        assert.match(error.message, /daily limit/i);
        return true;
      },
    );
  });

  it('still honours a documented code string when one is present', async () => {
    const { impl } = stubFetch([{ status: 500, body: JSON.stringify({ code: 'QuotaExceededError' }) }]);
    await assert.rejects(() => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }), BrickEconomyQuotaError);
  });

  it('reports an unexpected status without pretending to understand it', async () => {
    const { impl } = stubFetch([{ status: 503, body: 'Service Unavailable' }]);

    await assert.rejects(
      () => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof BrickEconomyError);
        assert.match(error.message, /HTTP 503/);
        return true;
      },
    );
  });

  it('reports a 200 that is not JSON', async () => {
    const { impl } = stubFetch([{ status: 200, body: '<html>maintenance</html>' }]);
    await assert.rejects(
      () => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }),
      /non-JSON/,
    );
  });

  it('wraps a network failure rather than leaking it', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchSetRaw('10236-1', { ...OPTS, fetchImpl: impl }),
      /Could not reach BrickEconomy/,
    );
  });
});
