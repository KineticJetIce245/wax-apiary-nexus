import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';

import type { ControlServerInfo } from '../../src/control/server.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { LiveHive } from '../../src/b/types.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { parseComposition, type Value } from '../../src/runtime/index.js';

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, any> | undefined;
  readonly text: string;
  readonly headers: Headers;
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function readResponse(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: Record<string, any> | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, any>;
    }
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text, headers: response.headers };
}

export async function getJson(url: string, token: string, path: string): Promise<HttpResult> {
  const response = await fetch(`${url}${path}`, { headers: authHeader(token) });
  return readResponse(response);
}

export async function postJson(
  url: string,
  token: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

/** Convert a legacy composition + bindings fixture into a B live. */
export function liveFrom(
  definition: Record<string, unknown>,
  bindings: Record<string, unknown>,
  liveId?: string,
): LiveHive {
  const parsed = parseComposition(definition);
  return fromCompositionDefinition(
    parsed,
    bindings as GraphBindings,
    liveId ?? parsed.id,
  );
}

export async function bLoad(
  url: string,
  token: string,
  body: Record<string, any>,
): Promise<HttpResult> {
  return postJson(url, token, '/lives', {
    live: liveFrom(body.definition, body.bindings, body.liveId),
    project: body.project,
  });
}

export async function bLoadLive(
  url: string,
  token: string,
  live: LiveHive,
  project?: { readonly id: string; readonly directory: string },
): Promise<HttpResult> {
  return postJson(url, token, '/lives', {
    live,
    ...(project === undefined ? {} : { project }),
  });
}

export async function bWake(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
  value: unknown,
): Promise<HttpResult> {
  return postJson(url, token, '/lives/wake', { liveId, beeId, input: inputOf(value) });
}

export async function bAnswer(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
  value: unknown,
  tokenValue?: string,
): Promise<HttpResult> {
  return postJson(url, token, '/lives/answer', {
    liveId,
    beeId,
    input: inputOf(value),
    ...(tokenValue === undefined ? {} : { token: tokenValue }),
  });
}

export async function bUnload(
  url: string,
  token: string,
  liveId: string,
): Promise<HttpResult> {
  return postJson(url, token, '/lives/unload', { liveId });
}

export async function bInspect(
  url: string,
  token: string,
  liveId: string,
): Promise<HttpResult> {
  return getJson(url, token, `/lives/${encodeURIComponent(liveId)}/inspect`);
}

export async function bOutput(
  url: string,
  token: string,
  liveId: string,
  runId?: string,
): Promise<HttpResult> {
  const query = runId === undefined ? '' : `?runId=${encodeURIComponent(runId)}`;
  return getJson(url, token, `/lives/${encodeURIComponent(liveId)}/output${query}`);
}

export async function bList(url: string, token: string): Promise<HttpResult> {
  return getJson(url, token, '/lives');
}

function inputOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Value & Record<string, unknown>;
    if (record.kind === 'text' && typeof record.text === 'string') {
      return record.text;
    }
  }
  throw new Error('B wake/answer fixture only supports text input');
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolvePromise, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

export async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = probe.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}

/** Sends a raw request target without URL normalization (`..` stays intact). */
export async function rawGet(
  info: ControlServerInfo,
  token: string,
  rawPath: string,
): Promise<{ readonly status: number; readonly text: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: info.port,
        method: 'GET',
        path: rawPath,
        headers: authHeader(token),
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          resolvePromise({ status: response.statusCode ?? 0, text });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Announces a body that is never sent. An implementation which checks
 * Content-Length before reading must answer 413 immediately; one which reads
 * until `end` cannot answer at all.
 */
export async function announcedButUnsentBody(
  info: ControlServerInfo,
  token: string,
  contentLength: number,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpRequest> | undefined;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      request?.destroy();
      reject(new Error('server did not answer before the request body was sent'));
    }, 2_000);
    timer.unref();

    request = httpRequest(
      {
        host: '127.0.0.1',
        port: info.port,
        method: 'POST',
        path: '/trigger',
        headers: {
          ...authHeader(token),
          'content-type': 'application/json',
          'content-length': String(contentLength),
        },
      },
      (response) => {
        response.resume();
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        request?.destroy();
        resolvePromise(response.statusCode ?? 0);
      },
    );
    request.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    request.flushHeaders();
  });
}
