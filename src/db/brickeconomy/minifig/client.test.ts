import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BrickEconomyAuthError,
  BrickEconomyError,
  BrickEconomyQuotaError,
} from '../types.ts';
import { fetchMinifigRaw } from './client.ts';
import { BrickEconomyUnknownMinifigError } from './types.ts';

/**
 * The HTTP contract for one minifigure.
 *
 * Imports no Prisma and sets no DATABASE_URL, matching ../client.test.ts — the client is pure
 * transport, which is why the request pacer lives in source.ts and not here.
 */

const KEY = 'test-key';

function respond(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

function ok(data: unknown): typeof fetch {
  return respond(200, JSON.stringify({ data }));
}

describe('fetchMinifigRaw — the endpoint contract', () => {
  it('calls /minifig/{n} with the API key and unwraps `data`', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: { minifig_number: 'sw0509', name: 'Luke' } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const data = await fetchMinifigRaw('sw0509', { apiKey: KEY, fetchImpl, baseUrl: 'https://x/api/v1' });

    assert.equal(seenUrl, 'https://x/api/v1/minifig/sw0509?currency=USD');
    assert.equal(seenHeaders['x-apikey'], KEY);
    assert.equal(seenHeaders['Accept'], 'application/json');
    assert.equal(data.name, 'Luke');
  });

  it('sends a variant letter through verbatim — it is part of the identity', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchMinifigRaw('sw0011a', { apiKey: KEY, fetchImpl, baseUrl: 'https://x/api/v1' });
    assert.match(seenUrl, /\/minifig\/sw0011a\?/);
  });

  it('NEVER retries with a "-1" suffix, unlike the set client', async () => {
    // A figure number has no variant-suffix concept, so a retry would either fetch a different
    // figure or spend a second request to be told the same no.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('Bad Request', { status: 400 });
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchMinifigRaw('sw0509', { apiKey: KEY, fetchImpl }),
      BrickEconomyUnknownMinifigError,
    );
    assert.equal(calls, 1);
  });

  it('throws before any request when the key is missing', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchMinifigRaw('sw0509', { apiKey: '', fetchImpl }),
      BrickEconomyAuthError,
    );
    assert.equal(calls, 0);
  });
});

describe('fetchMinifigRaw — status maps to a typed failure', () => {
  const cases: Array<[number, string, new (...args: never[]) => Error]> = [
    // MEASURED: /minifig/90398pb015 really does answer 400 with this exact non-JSON body.
    [400, 'Bad Request', BrickEconomyUnknownMinifigError],
    [404, 'Not Found', BrickEconomyUnknownMinifigError],
    [429, 'Too Many Requests', BrickEconomyQuotaError],
    [401, 'Unauthorized', BrickEconomyAuthError],
    [403, 'Forbidden', BrickEconomyAuthError],
    [500, 'Server Error', BrickEconomyError],
  ];

  for (const [status, body, expected] of cases) {
    it(`maps HTTP ${status} to ${expected.name}`, async () => {
      await assert.rejects(
        () => fetchMinifigRaw('sw0509', { apiKey: KEY, fetchImpl: respond(status, body) }),
        expected,
      );
    });
  }

  it('treats a 200 with no data node as "no such figure"', async () => {
    await assert.rejects(
      () => fetchMinifigRaw('sw0509', { apiKey: KEY, fetchImpl: respond(200, '{}') }),
      BrickEconomyUnknownMinifigError,
    );
  });

  it('treats a non-JSON 200 as a plain failure, not as an absence', async () => {
    // An absence is permanent, so it must never be inferred from a body we simply could not read.
    await assert.rejects(
      () => fetchMinifigRaw('sw0509', { apiKey: KEY, fetchImpl: respond(200, '<html>') }),
      (error: unknown) =>
        error instanceof BrickEconomyError && !(error instanceof BrickEconomyUnknownMinifigError),
    );
  });

  it('reports a network failure without claiming the figure does not exist', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchMinifigRaw('sw0509', { apiKey: KEY, fetchImpl }),
      (error: unknown) =>
        error instanceof BrickEconomyError && !(error instanceof BrickEconomyUnknownMinifigError),
    );
  });

  it('carries the figure number on the unknown error, for the absence row', async () => {
    await fetchMinifigRaw('sw0509', { apiKey: KEY, fetchImpl: ok({ name: 'Luke' }) });
    try {
      await fetchMinifigRaw('90398pb015', { apiKey: KEY, fetchImpl: respond(400, 'Bad Request') });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof BrickEconomyUnknownMinifigError);
      assert.equal(error.minifigNumber, '90398pb015');
      assert.equal(error.status, 400);
    }
  });
});
