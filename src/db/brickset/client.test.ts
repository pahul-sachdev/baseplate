import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installApiLog, type ApiRequestRecord } from '../apiLog.ts';
import { getKeyUsageStats, getSets } from './client.ts';
import { BricksetAuthError, BricksetError, BricksetLimitError } from './types.ts';

const OPTS = { apiKey: 'test-key', baseUrl: 'https://example.test/api/v3.asmx' };

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

describe('getSets — request shape', () => {
  it('always sends userHash, even empty', async () => {
    // Measured: omitting userHash makes the ASMX endpoint answer 200 with an EMPTY BODY rather
    // than an error, which is indistinguishable from an outage. This is the whole reason the
    // client builds the query string centrally instead of per-method.
    const { impl, calls } = stubFetch([ok({ status: 'success', matches: 0, sets: [] })]);

    await getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl });

    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.pathname.endsWith('/getSets'), true);
    assert.equal(url.searchParams.get('userHash'), '');
    assert.equal(url.searchParams.get('apiKey'), 'test-key');
  });

  it('sends params as a JSON string', async () => {
    const { impl, calls } = stubFetch([ok({ status: 'success', matches: 0, sets: [] })]);

    await getSets(
      { year: '2024', pageSize: 500, pageNumber: 2, orderBy: 'Number' },
      { ...OPTS, fetchImpl: impl },
    );

    const raw = new URL(calls[0]?.url ?? '').searchParams.get('params');
    assert.ok(raw);
    assert.deepEqual(JSON.parse(raw), {
      year: '2024',
      pageSize: 500,
      pageNumber: 2,
      orderBy: 'Number',
    });
  });

  it('passes updatedSince through as a day key', async () => {
    // Verified live: "YYYY-MM-DD" is accepted — year 2023 went from 936 matches to 6. That is
    // the same shape src/db/clock.ts already produces, so no conversion is needed anywhere.
    const { impl, calls } = stubFetch([ok({ status: 'success', matches: 0, sets: [] })]);

    await getSets({ year: '2023', updatedSince: '2026-07-01' }, { ...OPTS, fetchImpl: impl });

    const raw = new URL(calls[0]?.url ?? '').searchParams.get('params') ?? '{}';
    assert.equal((JSON.parse(raw) as { updatedSince?: string }).updatedSince, '2026-07-01');
  });

  it('rejects when the key is missing entirely', async () => {
    const { impl } = stubFetch([]);
    await assert.rejects(
      () => getSets({ year: '2023' }, { apiKey: '', fetchImpl: impl }),
      BricksetAuthError,
    );
  });
});

describe('getSets — response handling', () => {
  it('returns the total match count, not the page length', async () => {
    // Measured: pageSize 1 against year 2023 answers matches:936 with a single set. Pagination
    // is driven off matches, so conflating the two would stop every sync after one page.
    const { impl } = stubFetch([ok({ status: 'success', matches: 936, sets: [{ number: '10312' }] })]);

    const result = await getSets({ year: '2023', pageSize: 1 }, { ...OPTS, fetchImpl: impl });

    assert.equal(result.matches, 936);
    assert.equal(result.sets.length, 1);
  });

  it('tolerates a success response with no sets array', async () => {
    const { impl } = stubFetch([ok({ status: 'success', matches: 0 })]);
    const result = await getSets({ year: '1958' }, { ...OPTS, fetchImpl: impl });
    assert.deepEqual(result, { matches: 0, sets: [] });
  });

  it('maps "API limit exceeded" to a typed error despite the HTTP 200', async () => {
    // The allowance is reported in the BODY, not the status line. Checking response.ok alone
    // would parse this as a successful empty page and silently truncate the sync.
    const { impl } = stubFetch([ok({ status: 'error', message: 'API limit exceeded' })]);

    await assert.rejects(
      () => getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof BricksetLimitError);
        assert.match(error.message, /limit exceeded/i);
        return true;
      },
    );
  });

  it('maps an invalid-key message to an auth error', async () => {
    const { impl } = stubFetch([ok({ status: 'error', message: 'invalid API key' })]);
    await assert.rejects(() => getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl }), BricksetAuthError);
  });

  it('reports any other error status without pretending to understand it', async () => {
    const { impl } = stubFetch([ok({ status: 'error', message: 'something else entirely' })]);

    await assert.rejects(
      () => getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof BricksetError);
        assert.match(error.message, /something else entirely/);
        return true;
      },
    );
  });

  it('names an empty body rather than reporting an empty page', async () => {
    const { impl } = stubFetch([{ status: 200, body: '' }]);
    await assert.rejects(
      () => getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl }),
      /empty body/,
    );
  });

  it('reports a 200 that is not JSON', async () => {
    const { impl } = stubFetch([{ status: 200, body: '<html>maintenance</html>' }]);
    await assert.rejects(() => getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl }), /non-JSON/);
  });

  it('maps 401 to an auth error', async () => {
    const { impl } = stubFetch([{ status: 401, body: 'Unauthorized' }]);
    await assert.rejects(() => getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl }), BricksetAuthError);
  });

  it('wraps a network failure rather than leaking it', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => getSets({ year: '2023' }, { ...OPTS, fetchImpl: impl }),
      /Could not reach Brickset/,
    );
  });
});

describe('getKeyUsageStats', () => {
  it('reduces the UTC timestamps to day keys', async () => {
    const { impl } = stubFetch([
      ok({
        status: 'success',
        matches: 2,
        apiKeyUsage: [
          { dateStamp: '2026-07-29T00:00:00Z', count: 3 },
          { dateStamp: '2026-07-28T00:00:00Z', count: 11 },
        ],
      }),
    ]);

    const usage = await getKeyUsageStats({ ...OPTS, fetchImpl: impl });

    assert.deepEqual(usage, [
      { day: '2026-07-29', count: 3 },
      { day: '2026-07-28', count: 11 },
    ]);
  });

  it('returns an empty list for a key that has spent nothing', async () => {
    const { impl } = stubFetch([ok({ status: 'success', matches: 0, apiKeyUsage: [] })]);
    assert.deepEqual(await getKeyUsageStats({ ...OPTS, fetchImpl: impl }), []);
  });

  it('is not metered, because Brickset does not meter it either', async () => {
    // Only getSets counts against the allowance. Logging the free call would make our meter claim
    // one more request per sync than Brickset's own tally — and mirroring that tally is the whole
    // reason the meter exists.
    const logged: ApiRequestRecord[] = [];
    installApiLog((record) => logged.push(record));

    const usage = stubFetch([ok({ status: 'success', apiKeyUsage: [] })]);
    await getKeyUsageStats({ ...OPTS, fetchImpl: usage.impl });
    assert.equal(logged.length, 0, 'getKeyUsageStats must not reach the meter');

    const sets = stubFetch([ok({ status: 'success', matches: 0, sets: [] })]);
    await getSets({ year: '2023' }, { ...OPTS, fetchImpl: sets.impl });
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.provider, 'brickset');

    // Leave the sink inert for the rest of the suite.
    installApiLog(() => undefined);
  });

  it('drops entries with no usable date rather than inventing one', async () => {
    const { impl } = stubFetch([
      ok({ status: 'success', apiKeyUsage: [{ count: 4 }, { dateStamp: '2026-07-29T00:00:00Z' }] }),
    ]);

    // The dateless row is dropped; the countless row keeps its day and reports zero.
    assert.deepEqual(await getKeyUsageStats({ ...OPTS, fetchImpl: impl }), [
      { day: '2026-07-29', count: 0 },
    ]);
  });
});
