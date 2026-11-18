import type { SweepSessionsReport } from '../session/session-registry.js';
import { ControlClientError } from './client-errors.js';
import { parseLoopbackUrl, type LoopbackUrl } from './client-discovery.js';
import {
  parseSessionSummary,
  parseSweepSessionsReport,
  type SessionSummary,
} from './client-session.js';

export { ControlClientError } from './client-errors.js';
export { discoverDaemon } from './client-discovery.js';
export type { DaemonDiscovery, DaemonDiscoveryOptions } from './client-discovery.js';
export type { SessionSummary } from './client-session.js';
export type { SweepSessionsReport };


const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_ID_LENGTH = 512;
const MAX_TIMEOUT_MS = 2_147_483_647;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/;

export interface ControlClientOptions {
  /** Must be `http://127.0.0.1:<port>`; no path, query or fragment. */
  readonly baseUrl: string;
  /** Bearer token. Never placed in a URL, error message or log. */
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** Default 30_000. Positive integer. */
  readonly timeoutMs?: number;
}

/** Base control-channel client: health and session operations. */
export class ControlClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ControlClientOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new ControlClientError('control client options are required', {
        code: 'discovery',
      });
    }

    let baseUrl: LoopbackUrl;
    try {
      baseUrl = parseLoopbackUrl(options.baseUrl);
    } catch {
      throw new ControlClientError(
        `control baseUrl must be http://${LOOPBACK_HOST}:<port>`,
        { code: 'discovery' },
      );
    }
    this.baseUrl = baseUrl.baseUrl;

    this.token = requireToken(options.token);
    this.timeoutMs = requireTimeout(options.timeoutMs);
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request('GET', '/health');
  }

  /**
   * Session summaries in the daemon's registry order. Each entry carries only
   * `sessionId`, `harness`, `projectId`, `busy` and `bound`; a malformed entry
   * is a protocol error, never a partially trusted object.
   */
  async listSessions(): Promise<readonly SessionSummary[]> {
    const body = await this.request('GET', '/sessions');
    const value = body['sessions'];
    if (!Array.isArray(value)) {
      throw protocolError("control response missing 'sessions' array");
    }
    return value.map((entry) => parseSessionSummary(entry));
  }

  /**
   * Close one idle session that is not bound to a loaded graph.
   *
   * 404 means the session is unknown or already closed and resolves `false`,
   * matching `unload`; a busy or graph-bound session is a 409 and is thrown.
   * The attempt is never retried.
   */
  async closeSession(sessionId: string): Promise<boolean> {
    const id = requireId(sessionId, 'sessionId');
    try {
      const body = await this.request('POST', '/sessions/close', {
        sessionId: id,
      });
      const closed = body['closed'];
      if (typeof closed !== 'boolean') {
        throw protocolError("control response missing boolean 'closed'");
      }
      return closed;
    } catch (error) {
      if (error instanceof ControlClientError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Run one idle-session sweep over the real control API.
   *
   * The server owns the configured TTL; the request carries no policy. The
   * report contains session ids and a static failure reason only, never a
   * native id, prompt, output or token. The request has side effects and is
   * never retried.
   */
  async sweepSessions(): Promise<SweepSessionsReport> {
    const body = await this.request('POST', '/sessions/sweep', {});
    return parseSweepSessionsReport(requireField(body, 'report'));
  }

  protected async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.token}`,
    };
    let serialized: string | undefined;
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      serialized = JSON.stringify(payload ?? {});
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    const init: RequestInit = {
      method,
      headers,
      signal,
      // A local control server never redirects. Refusing a redirect also
      // prevents the bearer token from being replayed to another endpoint.
      redirect: 'error',
      ...(serialized === undefined ? {} : { body: serialized }),
    };

    let response: Response;
    try {
      response = await fetchWithTimeout(
        () => this.fetchImpl(`${this.baseUrl}${path}`, init),
        this.timeoutMs,
      );
    } catch (error) {
      throw transportError(error, signal, this.timeoutMs);
    }

    if (!response.ok) {
      let text = '';
      try {
        text = await readBodyLimited(response, response.status, MAX_RESPONSE_BYTES);
      } catch {
        // The status is authoritative; an unreadable error body must not turn
        // an HTTP failure into a different kind of error.
      }
      throw statusError(response.status, text, this.token);
    }

    let text: string;
    try {
      text = await readBodyLimited(response, response.status, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ControlClientError) {
        throw error;
      }
      // A body that stalls until the abort signal fires is a timeout, not a
      // generic network failure.
      throw transportError(error, signal, this.timeoutMs);
    }

    const body = parseResponseObject(text, response.status);
    if (body['ok'] !== true) {
      throw protocolError("control response did not have 'ok: true'");
    }
    return body;
  }
}

/** Error used only to mark the client-side timeout race. */
class ClientTimeoutError extends Error {
  constructor() {
    super('control request timed out');
    this.name = 'ClientTimeoutError';
  }
}

async function fetchWithTimeout(
  call: () => Promise<Response>,
  timeoutMs: number,
): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ClientTimeoutError()), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function transportError(
  error: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): ControlClientError {
  if (
    error instanceof ClientTimeoutError ||
    signal.aborted ||
    errorName(error) === 'AbortError' ||
    errorName(error) === 'TimeoutError'
  ) {
    return new ControlClientError(
      `control request timed out after ${String(timeoutMs)} ms`,
      { code: 'timeout' },
    );
  }
  // Deliberately static: fetch errors can carry the URL and low-level network
  // details, and this message is intended to be safe to log.
  return new ControlClientError('control request failed: network error', {
    code: 'network',
  });
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return '';
  }
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

async function readBodyLimited(
  response: Response,
  status: number,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const numeric = Number(declared);
    if (Number.isSafeInteger(numeric) && numeric > maxBytes) {
      await cancelBody(response);
      throw responseTooLarge(status);
    }
  }

  const stream = response.body;
  if (stream === null) {
    return '';
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(status);
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already be released.
    }
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: the client is about to fail this response anyway.
  }
}

function responseTooLarge(status: number): ControlClientError {
  return new ControlClientError(
    `control response exceeded the ${String(MAX_RESPONSE_BYTES / (1024 * 1024))} MiB size limit`,
    { code: 'protocol', status },
  );
}

function parseResponseObject(text: string, status: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ControlClientError('control response was not valid JSON', {
      code: 'protocol',
      status,
    });
  }
  if (!isRecord(parsed)) {
    throw new ControlClientError('control response was not a JSON object', {
      code: 'protocol',
      status,
    });
  }
  return parsed;
}

function statusError(
  status: number,
  text: string,
  token: string,
): ControlClientError {
  return new ControlClientError(`${staticStatusMessage(status)} (HTTP ${String(status)})`, {
    status,
    code: extractErrorCode(text, status, token),
  });
}

/**
 * Preserve only a server code that is structurally safe and is not the token.
 * The server's `error` message is intentionally ignored: it is response body
 * content and may echo a prompt, output or token.
 */
function extractErrorCode(text: string, status: number, token: string): string {
  const fallback = `http-${String(status)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) {
    return fallback;
  }
  const code = parsed['code'];
  if (
    typeof code !== 'string' ||
    !SAFE_ERROR_CODE.test(code) ||
    code.includes(token)
  ) {
    return fallback;
  }
  return code;
}

function staticStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return 'control request was rejected';
    case 401:
      return 'control request was not authorized';
    case 403:
      return 'control request was forbidden';
    case 404:
      return 'control request target was not found';
    case 405:
      return 'control request method was not allowed';
    case 409:
      return 'control request conflicted with the current state';
    case 413:
      return 'control request was too large';
    case 415:
      return 'control request used an unsupported media type';
    default:
      return status >= 500 ? 'control server failed' : 'control request failed';
  }
}

function protocolError(message: string): ControlClientError {
  return new ControlClientError(message, { code: 'protocol' });
}

function requireField(
  body: Record<string, unknown>,
  field: string,
): unknown {
  if (!Object.hasOwn(body, field)) {
    throw protocolError(`control response missing '${field}'`);
  }
  return body[field];
}

function requireId(value: unknown, field: string): string {
  if (!isBoundedString(value, MAX_ID_LENGTH)) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${String(MAX_ID_LENGTH)} characters`,
    );
  }
  return value;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function requireToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ControlClientError(
      'control token must be a non-empty string without whitespace',
      { code: 'discovery' },
    );
  }
  return value;
}

function requireTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new ControlClientError('control timeoutMs must be a positive integer', {
      code: 'discovery',
    });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
