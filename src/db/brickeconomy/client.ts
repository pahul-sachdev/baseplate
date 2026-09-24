import { recordRequest } from '../apiLog.ts';
import {
  BrickEconomyAuthError,
  BrickEconomyError,
  BrickEconomyQuotaError,
  BrickEconomyUnknownSetError,
  type BrickEconomyResponse,
  type BrickEconomySet,
} from './types.ts';

const BASE_URL = 'https://www.brickeconomy.com/api/v1';
const TIMEOUT_MS = 15_000;

/** Error-code strings the docs mention. Observed responses often carry none of them, so
 *  these are only a secondary signal — HTTP status is what actually decides. */
const CODES = {
  quota: ['QuotaExceededError', 'TooManyRequestsError'],
  auth: ['WrongCredentialsError', 'AuthenticationRequiredError'],
  unknown: ['UnknownObject'],
};

export interface FetchOptions {
  apiKey?: string | undefined;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface RawFetchResult {
  data: BrickEconomySet;
  /** The set number that actually resolved — may differ if the -1 retry was used. */
  queriedAs: string;
}

/** Already carries a variant suffix, e.g. "10236-1". */
function hasVariantSuffix(setNumber: string): boolean {
  return /-\d+$/.test(setNumber);
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
    // Error bodies are frequently HTML or bare text ("Bad Request"), not JSON.
    return null;
  }
}

/** Maps a failed response onto a typed error. Status first, code string second. */
function toError(status: number, body: string, setNumber: string): BrickEconomyError {
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
    return new BrickEconomyUnknownSetError(setNumber, status);
  }
  const detail = code ?? body.slice(0, 120).replace(/\s+/g, ' ').trim();
  return new BrickEconomyError(`BrickEconomy request failed (HTTP ${status}): ${detail}`, status);
}

async function requestOnce(
  setNumber: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<BrickEconomySet> {
  const url = `${baseUrl}/set/${encodeURIComponent(setNumber)}?currency=USD`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        // Sent deliberately, though measured behaviour shows the API also answers without it.
        'User-Agent': 'lego-flip-tool/0.1',
        'x-apikey': apiKey,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    recordRequest({ provider: 'brickeconomy', setNumber, status: null });
    throw new BrickEconomyError(
      `Could not reach BrickEconomy: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  // Logged here, per attempt, so the quota meter counts variant retries and rejected requests
  // too — both spend quota, and neither leaves a SetSnapshot row behind to infer from.
  recordRequest({ provider: 'brickeconomy', setNumber, status: response.status });

  const body = await response.text();
  if (!response.ok) throw toError(response.status, body, setNumber);

  let parsed: BrickEconomyResponse;
  try {
    parsed = JSON.parse(body) as BrickEconomyResponse;
  } catch {
    throw new BrickEconomyError(
      `BrickEconomy returned a non-JSON body for "${setNumber}": ${body.slice(0, 120)}`,
      response.status,
    );
  }

  // Unwrap `data`. A 200 with no data node means the set resolved to nothing useful.
  if (parsed.data === undefined || parsed.data === null) {
    throw new BrickEconomyUnknownSetError(setNumber, response.status);
  }
  return parsed.data;
}

/**
 * One set, one HTTP call — plus at most one retry with a "-1" variant suffix when the bare
 * number is rejected. (Measured: the API already normalises "10236" to "10236-1" itself, so
 * the retry is a fallback for numbers it won't normalise, not the common path.)
 */
export async function fetchSetRaw(
  setNumber: string,
  options: FetchOptions = {},
): Promise<RawFetchResult> {
  const apiKey = options.apiKey ?? process.env['BRICKECONOMY_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new BrickEconomyAuthError('BRICKECONOMY_API_KEY is not set in .env', 401);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;

  try {
    return { data: await requestOnce(setNumber, apiKey, fetchImpl, baseUrl), queriedAs: setNumber };
  } catch (error) {
    const retryable = error instanceof BrickEconomyUnknownSetError && !hasVariantSuffix(setNumber);
    if (!retryable) throw error;

    const variant = `${setNumber}-1`;
    return {
      data: await requestOnce(variant, apiKey, fetchImpl, baseUrl),
      queriedAs: variant,
    };
  }
}
