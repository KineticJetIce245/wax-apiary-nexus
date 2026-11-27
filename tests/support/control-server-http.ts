import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

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

export async function bTrigger(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
  value: unknown,
): Promise<HttpResult> {
  return postJson(url, token, '/lives/trigger', { liveId, beeId, input: inputOf(value) });
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

/** Every delivery answers 202 `{ok:true}` with no run or trace identity. */
export function assertAccepted(result: HttpResult): void {
  assert.equal(result.status, 202, result.text);
  assert.equal(result.body?.['ok'], true, result.text);
  assert.equal(result.body?.['runId'], undefined, result.text);
  assert.equal(result.body?.['traceId'], undefined, result.text);
}

/**
 * Poll `inspect` until the field is at Rest (and hovered when asked). There is
 * no run identity to wait for, so the only knobs are a timeout and whether a
 * user hover counts as settled.
 */
export async function waitForRest(
  url: string,
  token: string,
  liveId: string,
  timeoutMs = 2_000,
  stopAtHovered = true,
): Promise<HttpResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await bInspect(url, token, liveId);
    const status = result.body?.['status'];
    if (
      result.status === 200 &&
      (status?.rest === true || (stopAtHovered && status?.hovered === true))
    ) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `live ${liveId} did not reach Rest before the deadline (status=${String(result.status)})`,
      );
    }
    await delay(10);
  }
}

/** Minimal request shape shared by integration tests' local HTTP helpers. */
export interface RunApiCall {
  (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: Record<string, any> }>;
}

/** Poll through a test-local request helper rather than global fetch. */
export async function waitForRestWith(
  call: RunApiCall,
  liveId: string,
  timeoutMs = 120_000,
  stopAtHovered = true,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await call('GET', `/lives/${encodeURIComponent(liveId)}/inspect`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const status = result.body?.['status'];
    if (typeof status !== 'object' || status === null) {
      throw new Error('inspect response missing status object');
    }
    if (status['rest'] === true || (stopAtHovered && status['hovered'] === true)) {
      return status as Record<string, any>;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `live ${liveId} did not reach Rest before the deadline (status=${JSON.stringify(status)})`,
      );
    }
    await delay(100);
  }
}

/** Await a 202 delivery, then the field's Rest/hover state. */
export async function settleTriggerWith(
  call: RunApiCall,
  liveId: string,
  triggerPromise: Promise<{ readonly status: number; readonly body: Record<string, any> }>,
  timeoutMs = 120_000,
  stopAtHovered = true,
): Promise<Record<string, any>> {
  const trigger = await triggerPromise;
  assert.equal(trigger.status, 202, JSON.stringify(trigger.body));
  assert.equal(trigger.body?.['ok'], true, JSON.stringify(trigger.body));
  return waitForRestWith(call, liveId, timeoutMs, stopAtHovered);
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
): Promise<HttpResult> {
  return getJson(url, token, `/lives/${encodeURIComponent(liveId)}/output`);
}

export async function bList(url: string, token: string): Promise<HttpResult> {
  return getJson(url, token, '/lives');
}

/** Control input is a string or a JSON object used as the Value as-is. */
function inputOf(value: unknown): string | Value {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Value;
  }
  throw new Error('B trigger/answer fixture input must be a string or JSON object');
}

export type AutoGuardDecision = 'allow_once' | 'reject_once' | 'cancelled';

export interface GuardAutoDecider {
  /** Stop polling; safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Decides guards that appear after the test's explicit decisions.
 *
 * DSH may ask for a second approval (for example after a read-only attempt is
 * escalated) depending on the model's tool path. A guard test that only handles
 * its first request leaves that second request parked until the workspace
 * approval timeout, which turns the wake into a ForagerExecutionError 500.
 * This poller keeps the test deterministic without changing the explicit
 * first-decision assertions. The caller must pass every request it already
 * decided so the poller never settles those again.
 */
export function autoDecideGuards(
  url: string,
  token: string,
  knownRequestIds: Iterable<string>,
  decisionFor: (requestId: string) => AutoGuardDecision,
  onDecide?: (requestId: string, decision: AutoGuardDecision) => void,
): GuardAutoDecider {
  const seen = new Set(knownRequestIds);
  let running = true;
  const done = (async () => {
    while (running) {
      try {
        const listed = await getJson(url, token, '/guards');
        const guards = listed.body?.['guards'];
        if (Array.isArray(guards)) {
          for (const guard of guards) {
            if (typeof guard !== 'object' || guard === null) {
              continue;
            }
            const requestId = (guard as Record<string, unknown>)['requestId'];
            if (typeof requestId !== 'string' || seen.has(requestId)) {
              continue;
            }
            const decision = decisionFor(requestId);
            const result = await postJson(url, token, '/guard/decide', {
              requestId,
              decision,
            });
            if (result.status === 200) {
              seen.add(requestId);
              onDecide?.(requestId, decision);
            }
          }
        }
      } catch {
        // The caller stops this poller before closing the server; a transient
        // failure here must not turn into an unhandled rejection.
      }
      await delay(100);
    }
  })();
  return {
    stop: async () => {
      if (!running) {
        await done;
        return;
      }
      running = false;
      await done;
    },
  };
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
        path: '/lives/trigger',
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
