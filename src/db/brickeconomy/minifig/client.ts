import { recordRequest } from '../../apiLog.ts';
import {
  BrickEconomyAuthError,
  BrickEconomyError,
  BrickEconomyQuotaError,
} from '../types.ts';
import {
  BrickEconomyUnknownMinifigError,
  type BrickEconomyMinifig,
  type BrickEconomyMinifigResponse,
} from './types.ts';

/**
 * The HTTP call for one minifigure. No Prisma, no cache, no policy — mirrors ../client.ts.
 *
 * Deliberately free of any database import, so this stays unit-testable with a stubbed fetch and
 * no DATABASE_URL, exactly like the set client's suite. That is also why the request pacer lives
 * in ./source.ts rather than here.
 */

const BASE_URL = 'https://www.brickeconomy.com/api/v1';
const TIMEOUT_MS = 15_000;

/** Same error-code strings as the set endpoint; status is still what actually decides. */
const CODES = {
  quota: ['QuotaExceededError', 'TooManyRequestsError'],
  auth: ['WrongCredentialsError', 'AuthenticationRequiredError'],
  unknown: ['UnknownObject'],
};

export interface MinifigFetchOptions {
  apiKey?: string | undefined;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

function extractErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const direct = record['code'] ?? record['error_code'];
    if (typeof direct === 'string') return direct;
    const nested = record['error'];
    if (typeof nested === 'string') return nested;
    if (typeof nested === 'object' && nested !== null) {
      const code = (nested as Record<string, unknown>)['code'];
      if (typeof code === 'string') return code;
    }
    return null;
  } catch {
    // MEASURED: /minifig/90398pb015 answers HTTP 400 with the bare body `Bad Request`, which is
    // not JSON at all. Status has to be what decides.
    return null;
  }
}

function toError(status: number, body: string, minifigNumber: string): BrickEconomyError {
  const code = extractErrorCode(body);

  if (status === 429 || (code !== null && CODES.quota.includes(code))) {
    return new BrickEconomyQuotaError(
      'BrickEconomy daily limit hit (100 requests/day, resets 00:00 UTC)',
    );
  }
  if (status === 401 || status === 403 || (code !== null && CODES.auth.includes(code))) {
    return new BrickEconomyAuthError(
      status === 403
        ? 'BrickEconomy rejected the request (403). Check the key has API access.'
        : 'BrickEconomy rejected BRICKECONOMY_API_KEY (401). Check the value in .env.',
      status,
    );
  }
  if (status === 400 || status === 404 || (code !== null && CODES.unknown.includes(code))) {
    // The one error that writes a permanent MinifigAbsence row — see ./source.ts.
    return new BrickEconomyUnknownMinifigError(minifigNumber, status);
  }
  const detail = code ?? body.slice(0, 120).replace(/\s+/g, ' ').trim();
  return new BrickEconomyError(`BrickEconomy request failed (HTTP ${status}): ${detail}`, status);
}

/**
 * One minifigure, one HTTP call.
 *
 * There is deliberately NO "-1" variant retry, unlike the set client. A figure number has no
 * variant-suffix concept: "sw0011a" and "sw0011" are different figures, so a retry would either
 * fetch the wrong figure or spend a second request to be told the same no.
 */
export async function fetchMinifigRaw(
  minifigNumber: string,
  options: MinifigFetchOptions = {},
): Promise<BrickEconomyMinifig> {
  const apiKey = options.apiKey ?? process.env['BRICKECONOMY_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new BrickEconomyAuthError('BRICKECONOMY_API_KEY is not set in .env', 401);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  const url = `${baseUrl}/minifig/${encodeURIComponent(minifigNumber)}?currency=USD`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'lego-flip-tool/0.1',
        'x-apikey': apiKey,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    recordRequest({ provider: 'brickeconomy', setNumber: null, minifigNumber, status: null });
    throw new BrickEconomyError(
      `Could not reach BrickEconomy: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // Logged per attempt, before ok is checked — a rejected request spends quota too, and the
  // minifigNumber is recorded so a batch of four is auditable rather than four anonymous rows.
  recordRequest({
    provider: 'brickeconomy',
    setNumber: null,
    minifigNumber,
    status: response.status,
  });

  const body = await response.text();
  if (!response.ok) throw toError(response.status, body, minifigNumber);

  let parsed: BrickEconomyMinifigResponse;
  try {
    parsed = JSON.parse(body) as BrickEconomyMinifigResponse;
  } catch {
    throw new BrickEconomyError(
      `BrickEconomy returned a non-JSON body for "${minifigNumber}": ${body.slice(0, 120)}`,
      response.status,
    );
  }

  // A 200 with no data node means the figure resolved to nothing useful.
  if (parsed.data === undefined || parsed.data === null) {
    throw new BrickEconomyUnknownMinifigError(minifigNumber, response.status);
  }
  return parsed.data;
}
