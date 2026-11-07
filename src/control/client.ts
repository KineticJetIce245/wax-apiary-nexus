import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { expandHomePath } from '../storage/conversation-store.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_DAEMON_PARTS = ['.wax', 'waxd'] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_LENGTH = 4_096;
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

export interface DaemonDiscoveryOptions {
  /** Default `~/.wax/waxd`. A leading `~` is expanded. */
  readonly daemonDir?: string;
  /** Used only to resolve the default home directory. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface DaemonDiscovery {
  readonly baseUrl: string;
  readonly token: string;
  readonly infoPath: string;
  readonly tokenPath: string;
}

export interface ControlClientErrorOptions {
  /** Server error code, or `network` | `timeout` | `discovery` | `protocol`. */
  readonly code: string;
  readonly status?: number;
}

/**
 * Typed control-channel failure. Its message is always built from static text
 * and the HTTP status/code alone: never from a response body, a token, a
 * prompt or an output. Callers can therefore log `message` safely.
 */
export class ControlClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, options: ControlClientErrorOptions) {
    super(message);
    this.name = 'ControlClientError';
    this.code = options.code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

interface LoopbackUrl {
  readonly baseUrl: string;
  readonly port: number;
}

/** Error used only to mark the client-side timeout race. */
class ClientTimeoutError extends Error {
  constructor() {
    super('control request timed out');
    this.name = 'ClientTimeoutError';
  }
}

/**
 * Reads `server.json` and the token file written by `ControlServer`.
 *
 * Discovery is deliberately strict: only a loopback HTTP URL on the exact
 * port declared in the info file is accepted. A malformed, redirected or
 * remote endpoint must never receive the daemon token.
 */
export function discoverDaemon(options: DaemonDiscoveryOptions = {}): DaemonDiscovery {
  const daemonDir = resolveDaemonDirectory(options);
  const infoPath = join(daemonDir, 'server.json');

  const raw = readInfoFile(infoPath);
  const info = parseInfoFile(raw, infoPath);

  const host = info['host'];
  if (host !== LOOPBACK_HOST) {
    throw discoveryError(infoPath, `host must be '${LOOPBACK_HOST}'`);
  }

  const port = info['port'];
  if (
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw discoveryError(infoPath, 'port must be an integer between 1 and 65535');
  }

  let endpoint: LoopbackUrl;
  try {
    endpoint = parseLoopbackUrl(info['url']);
  } catch {
    throw discoveryError(infoPath, `url must be http://${LOOPBACK_HOST}:<port>`);
  }
  if (endpoint.port !== port) {
    throw discoveryError(infoPath, 'port does not match url');
  }

  const rawTokenPath = info['tokenPath'];
  if (
    typeof rawTokenPath !== 'string' ||
    rawTokenPath.length === 0 ||
    rawTokenPath.length > MAX_CONFIG_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(rawTokenPath)
  ) {
    throw discoveryError(infoPath, 'tokenPath must be a non-empty string');
  }
  const tokenPath = resolve(expandHomePath(rawTokenPath));

  const token = readTokenFile(infoPath, tokenPath);
  return {
    baseUrl: endpoint.baseUrl,
    token,
    infoPath,
    tokenPath,
  };
}

/**
 * Minimal client for the M4c1 control endpoint.
 *
 * Every request is a single attempt: `trigger` and `load` have side effects and
 * are never retried automatically after a network failure or timeout. Request
 * bodies and server response bodies are never included in thrown errors.
 */
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

  async status(): Promise<readonly unknown[]> {
    const body = await this.request('GET', '/status');
    const value = body['status'];
    if (!Array.isArray(value)) {
      throw protocolError("control response missing 'status' array");
    }
    return value;
  }

  async statusOf(graphId: string): Promise<unknown | undefined> {
    const id = requireId(graphId, 'graphId');
    try {
      const body = await this.request('GET', `/status/${encodeURIComponent(id)}`);
      return requireField(body, 'status');
    } catch (error) {
      // An unloaded graph is a normal answer, not a failure. Every other
      // non-2xx response still propagates as a typed error.
      if (error instanceof ControlClientError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async load(body: {
    definition: unknown;
    bindings: unknown;
    project: { id: string; directory: string };
    idleTtlMs?: number;
  }): Promise<unknown> {
    const response = await this.request('POST', '/graphs/load', {
      definition: body.definition,
      bindings: body.bindings,
      project: body.project,
      ...(body.idleTtlMs === undefined ? {} : { idleTtlMs: body.idleTtlMs }),
    });
    return requireField(response, 'status');
  }

  async trigger(graphId: string, nodeId: string, value: unknown): Promise<unknown> {
    const id = requireId(graphId, 'graphId');
    const node = requireId(nodeId, 'nodeId');
    const body = await this.request('POST', '/trigger', {
      graphId: id,
      nodeId: node,
      value,
    });
    return requireField(body, 'result');
  }

  async unload(graphId: string): Promise<boolean> {
    const id = requireId(graphId, 'graphId');
    const body = await this.request('POST', '/graphs/unload', { graphId: id });
    const unloaded = body['unloaded'];
    if (typeof unloaded !== 'boolean') {
      throw protocolError("control response missing boolean 'unloaded'");
    }
    return unloaded;
  }

  async sweep(): Promise<unknown> {
    const body = await this.request('POST', '/sweep', {});
    return requireField(body, 'report');
  }

  private async request(
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
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${String(MAX_ID_LENGTH)} characters`,
    );
  }
  return value;
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

function resolveDaemonDirectory(options: DaemonDiscoveryOptions): string {
  if (options.daemonDir !== undefined) {
    const value = options.daemonDir;
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_CONFIG_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new ControlClientError('control daemonDir must be a non-empty string', {
        code: 'discovery',
      });
    }
    return resolve(expandHomePath(value));
  }

  const env = options.env;
  const home = env?.['HOME'] || env?.['USERPROFILE'] || homedir();
  return resolve(join(home, ...DEFAULT_DAEMON_PARTS));
}

function readInfoFile(infoPath: string): string {
  try {
    return readFileSync(infoPath, 'utf8');
  } catch {
    throw discoveryError(infoPath, 'server.json is missing or unreadable');
  }
}

function parseInfoFile(raw: string, infoPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw discoveryError(infoPath, 'server.json is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw discoveryError(infoPath, 'server.json must be a JSON object');
  }
  return parsed;
}

function readTokenFile(infoPath: string, tokenPath: string): string {
  let contents: string;
  try {
    contents = readFileSync(tokenPath, 'utf8');
  } catch {
    throw discoveryError(infoPath, `token file '${tokenPath}' is missing or unreadable`);
  }

  const token = contents.trim();
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    /[\s\u0000-\u001f\u007f]/.test(token)
  ) {
    throw discoveryError(
      infoPath,
      `token file '${tokenPath}' does not contain a valid token`,
    );
  }
  return token;
}

/**
 * Strict parser for the only endpoint this client may ever contact. Echoing
 * the rejected value is avoided so a token accidentally embedded in a URL can
 * never end up in an error message.
 */
function parseLoopbackUrl(value: unknown): LoopbackUrl {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CONFIG_LENGTH
  ) {
    throw new Error('invalid loopback url');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid loopback url');
  }

  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname !== LOOPBACK_HOST ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('invalid loopback url');
  }

  const portText = parsed.port;
  if (!/^[0-9]+$/.test(portText)) {
    throw new Error('invalid loopback url');
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('invalid loopback url');
  }

  return {
    baseUrl: `http://${LOOPBACK_HOST}:${String(port)}`,
    port,
  };
}

function discoveryError(infoPath: string, reason: string): ControlClientError {
  return new ControlClientError(
    `daemon discovery failed at '${infoPath}': ${reason}`,
    { code: 'discovery' },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
