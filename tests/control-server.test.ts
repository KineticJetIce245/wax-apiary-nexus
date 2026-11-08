import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions } from '../src/adapters/harness.js';
import {
  ControlServer,
  type ControlServerInfo,
  type ControlServerOptions,
} from '../src/control/server.js';
import { DaemonLockError } from '../src/daemon/daemon-lock.js';
import type { Project } from '../src/project/kernel.js';
import {
  SessionRegistry,
  type SweepSessionsReport,
} from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';

const FIXED_NOW = '2026-11-06T22:00:00.000Z';
const PROMPT_SECRET = 'PROMPT_SECRET_9f3c';
const INPUT_SECRET = 'INPUT_SECRET_7a2e';
const OUTPUT_SECRET = 'OUTPUT_SECRET_4d81';

class FakeClock {
  time: number;

  constructor(time = 1_000) {
    this.time = time;
  }

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

interface TestEnv {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly stateRoot: string;
  readonly daemonDir: string;
}

interface RunningServer {
  readonly server: ControlServer;
  readonly info: ControlServerInfo;
  readonly token: string;
}

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, any> | undefined;
  readonly text: string;
  readonly headers: Headers;
}

let projectSeq = 0;

function makeEnv(adapterOptions: FakeAdapterOptions = {}): TestEnv {
  return makeEnvWithAdapter(new FakeAdapter(adapterOptions));
}

function makeEnvWithAdapter(
  adapter: FakeAdapter,
  registryNow: () => string = () => FIXED_NOW,
): TestEnv {
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `project-${String(projectSeq)}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-control-project-')),
  };
  const registry = new SessionRegistry({
    workspace,
    harness: 'fake-harness',
    now: registryNow,
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-control-state-'));
  return {
    adapter,
    workspace,
    registry,
    project,
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
}

function makeServer(
  env: TestEnv,
  overrides: Partial<ControlServerOptions> = {},
): ControlServer {
  return new ControlServer({
    workspace: env.workspace,
    registry: env.registry,
    harness: 'fake-harness',
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
    ...overrides,
  });
}

async function startServer(
  env: TestEnv,
  overrides: Partial<ControlServerOptions> = {},
): Promise<RunningServer> {
  const server = makeServer(env, overrides);
  const info = await server.start();
  return { server, info, token: readFileSync(info.tokenPath, 'utf8') };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function readResponse(response: Response): Promise<HttpResult> {
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

async function getJson(url: string, token: string, path: string): Promise<HttpResult> {
  const response = await fetch(`${url}${path}`, { headers: authHeader(token) });
  return readResponse(response);
}

async function postJson(
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

function foragerDefinition(id: string, prompt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt } },
    },
    edges: [],
  };
}

function loadBody(
  definition: Record<string, unknown>,
  project: Project,
  bindings: Record<string, unknown>,
  idleTtlMs?: number,
): Record<string, unknown> {
  return {
    definition,
    bindings,
    project,
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
  };
}

interface ManifestFixture {
  readonly root: string;
  readonly compositionPath: string;
  readonly manifestPath: string;
  readonly composition: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
}

interface ManifestFixtureOptions {
  readonly graphId?: string;
  readonly harness?: string;
  readonly bindings?: Record<string, unknown>;
  readonly project?: Project;
  readonly composition?: Record<string, unknown>;
}

/** Writes a real sidecar manifest plus the composition it names. */
function writeManifestFixture(
  env: TestEnv,
  options: ManifestFixtureOptions = {},
): ManifestFixture {
  const root = mkdtempSync(join(tmpdir(), 'wax-control-manifest-'));
  const project = options.project ?? env.project;
  const composition =
    options.composition ??
    foragerDefinition(options.graphId ?? 'manifest-graph', 'manifest {{input}}');
  const compositionPath = join(root, 'composition.json');
  writeFileSync(compositionPath, JSON.stringify(composition));
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    composition: 'composition.json',
    project: { id: project.id, directory: project.directory },
    harness: options.harness ?? 'codex',
    bindings: options.bindings ?? { only: { kind: 'fresh' } },
  };
  const manifestPath = join(root, 'graph.wax.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, compositionPath, manifestPath, composition, manifest };
}

function writeManifestVariant(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

/** A valid composition whose only node kind cannot be triggered manually. */
function untriggerableComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      cond: { kind: 'condition', config: { mode: 'boolean' } },
    },
    edges: [
      { id: 'yes', from: 'cond', to: 'cond', when: 'true' },
      { id: 'no', from: 'cond', to: 'cond', when: 'false' },
    ],
  };
}

/**
 * FakeAdapter whose first conversation creation blocks on a gate, so a second
 * HTTP request provably arrives while the graph is still loading.
 */
class GatedFakeAdapter extends FakeAdapter {
  private releaseGate: (() => void) | undefined;
  private signalStarted: (() => void) | undefined;
  readonly gate: Promise<void> = new Promise<void>((resolveGate) => {
    this.releaseGate = resolveGate;
  });
  readonly createStarted: Promise<void> = new Promise<void>((resolveStarted) => {
    this.signalStarted = resolveStarted;
  });

  override async createConversation(
    project: Project,
    options?: ConversationOptions,
  ): Promise<string> {
    this.signalStarted?.();
    await this.gate;
    return await super.createConversation(project, options);
  }

  release(): void {
    this.releaseGate?.();
  }
}

/** Counts native closes so a retained session is provable, not assumed. */
class TrackingFakeAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
    await super.closeConversation(nativeId);
  }
}

/**
 * A submit that never emits a terminal event. The session stays busy without
 * relying on approval timing, so the busy-state assertions are deterministic.
 */
class HoldingFakeAdapter extends TrackingFakeAdapter {
  override async submit(
    _nativeId: string,
    _executionId: string,
    _text: string,
  ): Promise<void> {}
}

/** A native close that fails with a marker that must never reach a response. */
class FailingCloseFakeAdapter extends FakeAdapter {
  override async closeConversation(_nativeId: string): Promise<void> {
    throw new Error('native close failed: NATIVE_CLOSE_SECRET');
  }
}

/** A registry whose automatic sweep always fails, for daemon-resilience tests. */
class ThrowingSweepRegistry extends SessionRegistry {
  sweepCalls = 0;

  override async sweepIdle(): Promise<SweepSessionsReport> {
    this.sweepCalls += 1;
    throw new Error('SWEEP_SECRET');
  }
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function assertNoSecrets(haystack: string, token: string): void {
  for (const secret of [token, PROMPT_SECRET, INPUT_SECRET, OUTPUT_SECRET]) {
    assert.equal(
      haystack.includes(secret),
      false,
      `leaked secret '${secret.slice(0, 8)}...'`,
    );
  }
}

interface ServerHoverAccess {
  readonly graphHost?: {
    readonly graphs: {
      peek(id: string):
        | {
            readonly value: {
              readonly runtime: {
                snapshot(): {
                  readonly nodes: Readonly<
                    Record<
                      string,
                      { readonly hover?: { readonly token: string; readonly kind: string } }
                    >
                  >;
                };
              };
            };
          }
        | undefined;
    };
  };
}

/** Test-only read of the parked hover token; status deliberately never has it. */
function hoverTokenOf(server: ControlServer, graphId: string, nodeId: string): string {
  const host = (server as unknown as ServerHoverAccess).graphHost;
  assert.ok(host !== undefined, 'control server has no graph host');
  const entry = host.graphs.peek(graphId);
  assert.ok(entry !== undefined, `graph '${graphId}' is not loaded`);
  const hover = entry.value.runtime.snapshot().nodes[nodeId]?.hover;
  assert.ok(hover !== undefined, `node '${nodeId}' has no open hover`);
  return hover.token;
}

function userAnswerComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' } },
    },
    edges: [],
  };
}

function userForagerComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      idle: { kind: 'forager', config: { connection: 'fake', prompt: 'idle {{input}}' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' } },
    },
    edges: [],
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

async function freePort(): Promise<number> {
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
async function rawGet(
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
async function announcedButUnsentBody(
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

test('start returns loopback info, writes a random token and keeps it out of server.json', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });

  const { info, token } = running;
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.url, `http://127.0.0.1:${String(info.port)}`);
  assert.ok(info.port > 0);
  assert.equal(info.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(info.startedAt)));
  assert.equal(info.tokenPath, join(env.daemonDir, 'token'));
  assert.equal(info.infoPath, join(env.daemonDir, 'server.json'));
  assert.equal(existsSync(info.tokenPath), true);
  assert.equal(existsSync(info.infoPath), true);

  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(info.tokenPath, 'utf8'), token);

  const infoFileText = readFileSync(info.infoPath, 'utf8');
  const infoFile = JSON.parse(infoFileText) as Record<string, unknown>;
  assert.deepEqual(Object.keys(infoFile).sort(), [
    'host',
    'pid',
    'port',
    'startedAt',
    'tokenPath',
    'url',
  ]);
  assert.equal(infoFile['url'], info.url);
  assert.equal(infoFile['host'], info.host);
  assert.equal(infoFile['port'], info.port);
  assert.equal(infoFile['pid'], process.pid);
  assert.equal(infoFile['startedAt'], info.startedAt);
  assert.equal(infoFile['tokenPath'], info.tokenPath);
  assert.equal(Object.hasOwn(infoFile, 'token'), false);
  assert.equal(infoFileText.includes(token), false);
  assert.equal(JSON.stringify(info).includes(token), false);

  const bindAddress = (running.server as unknown as { readonly server?: Server }).server?.address();
  assert.ok(bindAddress !== null && typeof bindAddress === 'object');
  assert.equal(bindAddress.address, '127.0.0.1');

  const health = await getJson(info.url, token, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body?.['ok'], true);
  assert.equal(health.body?.['harness'], 'fake-harness');
  assert.equal(health.body?.['pid'], process.pid);
  assert.equal(health.body?.['startedAt'], info.startedAt);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('content-type') ?? '', /^application\/json/);

  assert.deepEqual(running.server.info(), info);
});

test('requests without a valid bearer token are rejected with 401', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const missing = await readResponse(await fetch(`${info.url}/health`));
  assert.equal(missing.status, 401);
  assert.equal(missing.body?.['ok'], false);
  assert.equal(missing.body?.['code'], 'unauthorized');
  assert.equal(missing.text.includes(token), false);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');

  const wrong = await readResponse(
    await fetch(`${info.url}/health`, {
      headers: { authorization: `Bearer ${token}x` },
    }),
  );
  assert.equal(wrong.status, 401);

  const wrongScheme = await readResponse(
    await fetch(`${info.url}/health`, {
      headers: { authorization: `Basic ${token}` },
    }),
  );
  assert.equal(wrongScheme.status, 401);

  const tokenInQuery = await readResponse(
    await fetch(`${info.url}/health?token=${token}`),
  );
  assert.equal(tokenInQuery.status, 401);

  const valid = await readResponse(
    await fetch(`${info.url}/health`, { headers: authHeader(token) }),
  );
  assert.equal(valid.status, 200);
});

test('load, status, trigger, status and unload work over real HTTP without leaking bodies', async (t) => {
  const env = makeEnv({ output: OUTPUT_SECRET });
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const responses: string[] = [];
  const bodies: unknown[] = [];

  const definition = foragerDefinition('main', `run ${PROMPT_SECRET} {{input}}`);
  const load = await postJson(info.url, token, '/graphs/load', {
    ...loadBody(definition, env.project, { only: { kind: 'fresh' } }, 0),
  });
  responses.push(load.text);
  assert.equal(load.status, 200);
  assert.equal(load.body?.['ok'], true);
  assert.equal(load.body?.['status']?.['graphId'], 'main');
  assert.equal(load.body?.['status']?.['rest'], true);
  bodies.push(load.body);

  const list = await getJson(info.url, token, '/status');
  responses.push(list.text);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body?.['status']));
  assert.equal(list.body?.['status']?.[0]?.['graphId'], 'main');
  bodies.push(list.body);

  const one = await getJson(info.url, token, '/status/main');
  responses.push(one.text);
  assert.equal(one.status, 200);
  assert.equal(one.body?.['status']?.['graphId'], 'main');
  bodies.push(one.body);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'main',
    nodeId: 'only',
    value: { kind: 'text', text: INPUT_SECRET },
  });
  responses.push(trigger.text);
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['rest'], true);
  assert.equal(trigger.body?.['result']?.['persisted'], true);
  assert.ok((trigger.body?.['result']?.['pumps'] as number) >= 1);
  bodies.push(trigger.body);

  const after = await getJson(info.url, token, '/status/main');
  responses.push(after.text);
  assert.equal(after.status, 200);
  assert.equal(after.body?.['status']?.['rest'], true);
  assert.equal(after.body?.['status']?.['nodes']?.[0]?.['queue'], 0);
  bodies.push(after.body);

  const unload = await postJson(info.url, token, '/graphs/unload', { graphId: 'main' });
  responses.push(unload.text);
  assert.equal(unload.status, 200);
  assert.equal(unload.body?.['unloaded'], true);
  bodies.push(unload.body);

  // The session outlives the graph: it is still listed, now unbound.
  const sessionsAfterUnload = await getJson(info.url, token, '/sessions');
  responses.push(sessionsAfterUnload.text);
  assert.equal(sessionsAfterUnload.status, 200);
  assert.equal(sessionsAfterUnload.body?.['sessions']?.length, 1);
  assert.equal(sessionsAfterUnload.body?.['sessions']?.[0]?.['bound'], false);
  bodies.push(sessionsAfterUnload.body);

  const gone = await getJson(info.url, token, '/status/main');
  responses.push(gone.text);
  assert.equal(gone.status, 404);
  bodies.push(gone.body);

  assert.equal(env.adapter.prompts.length, 1);
  assert.equal(env.adapter.prompts[0]?.includes(PROMPT_SECRET), true);
  assert.equal(env.adapter.prompts[0]?.includes(INPUT_SECRET), true);

  assertNoSecrets(`${responses.join('\n')}\n${logs.join('\n')}`, token);
  for (const key of collectKeys(bodies)) {
    assert.equal(
      ['prompt', 'output', 'token', 'value', 'pheromones'].includes(key),
      false,
      `response leaked key '${key}'`,
    );
  }
});

test('unknown graphs return 404 and a duplicate load returns 409 with current status', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const unknownStatus = await getJson(info.url, token, '/status/missing');
  assert.equal(unknownStatus.status, 404);
  assert.equal(unknownStatus.body?.['code'], 'not-found');

  const unknownTrigger = await postJson(info.url, token, '/trigger', {
    graphId: 'missing',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
  });
  assert.equal(unknownTrigger.status, 404);

  const unknownUnload = await postJson(info.url, token, '/graphs/unload', {
    graphId: 'missing',
  });
  assert.equal(unknownUnload.status, 404);

  const definition = foragerDefinition('dup', 'dup {{input}}');
  const body = loadBody(definition, env.project, { only: { kind: 'fresh' } });
  const first = await postJson(info.url, token, '/graphs/load', body);
  assert.equal(first.status, 200);
  const created = env.adapter.displayNames.length;
  assert.equal(created, 1);

  const duplicate = await postJson(info.url, token, '/graphs/load', body);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body?.['code'], 'conflict');
  assert.equal(duplicate.body?.['status']?.['graphId'], 'dup');
  assert.equal(env.adapter.displayNames.length, created);
  assert.equal(env.registry.list().length, 1);
});

test('unloading a non-Rest graph returns 409 with its current status', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const definition = {
    schemaVersion: 1,
    id: 'hover',
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' } },
    },
    edges: [],
  };
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 0),
  );
  assert.equal(load.status, 200);
  assert.equal(load.body?.['status']?.['rest'], true);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'hover',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['rest'], false);
  assert.equal(trigger.body?.['result']?.['hovered'], true);

  const unload = await postJson(info.url, token, '/graphs/unload', { graphId: 'hover' });
  assert.equal(unload.status, 409);
  assert.equal(unload.body?.['code'], 'conflict');
  assert.equal(unload.body?.['status']?.['graphId'], 'hover');
  assert.equal(unload.body?.['status']?.['rest'], false);
  assert.equal(unload.body?.['status']?.['hovered'], true);

  const still = await getJson(info.url, token, '/status/hover');
  assert.equal(still.status, 200);
  assert.equal(still.body?.['status']?.['rest'], false);
});

test('sweep reports skips and unloads expired graphs', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { now: clock.now });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const definition = foragerDefinition('sweepme', 'sweep {{input}}');
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }, 100),
  );
  assert.equal(load.status, 200);
  assert.equal(load.body?.['status']?.['residency']?.['idleTtlMs'], 100);
  assert.equal(load.body?.['status']?.['residency']?.['nextEvictionAt'], 1_100);
  assert.equal(env.registry.list().length, 1);

  clock.advance(50);
  const early = await postJson(info.url, token, '/sweep', {});
  assert.equal(early.status, 200);
  assert.deepEqual(early.body?.['report']?.['unloaded'], []);
  assert.deepEqual(early.body?.['report']?.['skipped'], [
    { id: 'sweepme', reason: 'not-expired' },
  ]);
  assert.equal(env.registry.list().length, 1);

  clock.advance(50);
  const expired = await postJson(info.url, token, '/sweep', {});
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.body?.['report']?.['unloaded'], ['sweepme']);
  // A sweep releases the graph but retains the sessions it created.
  assert.equal(env.registry.list().length, 1);

  const gone = await getJson(info.url, token, '/status/sweepme');
  assert.equal(gone.status, 404);
});

test('session list exposes routing metadata and close refuses busy or bound sessions', async (t) => {
  const adapter = new HoldingFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const empty = await getJson(info.url, token, '/sessions');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body?.['sessions'], []);

  const idle = await env.registry.create(env.project, { displayName: 'idle' });
  const busy = await env.registry.create(env.project, { displayName: 'busy' });
  // The holding fake never emits a terminal event, so the execution stays active.
  await env.workspace.submit(busy.sessionId, 'hold');
  assert.equal(env.workspace.isConversationBusy(busy.sessionId), true);

  const definition = foragerDefinition('sessions-graph', 'run {{input}}');
  const loaded = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }),
  );
  assert.equal(loaded.status, 200);
  const boundRecord = env.registry.list().find((record) => record.nativeId === 'native-3');
  assert.ok(boundRecord !== undefined);

  const list = await getJson(info.url, token, '/sessions');
  assert.equal(list.status, 200);
  const sessions = list.body?.['sessions'] as Record<string, unknown>[];
  assert.equal(sessions.length, 3);
  // Registry insertion order is preserved.
  assert.deepEqual(
    sessions.map((session) => session['sessionId']),
    [idle.sessionId, busy.sessionId, boundRecord.sessionId],
  );
  const idleSummary = sessions[0];
  assert.ok(idleSummary !== undefined);
  assert.deepEqual(Object.keys(idleSummary).sort(), [
    'bound',
    'busy',
    'harness',
    'projectId',
    'sessionId',
  ]);
  assert.deepEqual(idleSummary, {
    sessionId: idle.sessionId,
    harness: 'fake-harness',
    projectId: env.project.id,
    busy: false,
    bound: false,
  });
  assert.equal(sessions[1]?.['busy'], true);
  assert.equal(sessions[1]?.['bound'], false);
  assert.equal(sessions[2]?.['busy'], false);
  assert.equal(sessions[2]?.['bound'], true);
  // No native id, project directory or prompt reaches the session list.
  assert.equal(list.text.includes('native-'), false);
  assert.equal(list.text.includes(env.project.directory), false);
  assert.equal(list.text.includes('projectDirectory'), false);
  assertNoSecrets(list.text, token);

  // A busy session is refused and stays registered.
  assert.equal(env.registry.isBusy(busy.sessionId), true, 'busy session lost its state');
  const busyClose = await postJson(info.url, token, '/sessions/close', {
    sessionId: busy.sessionId,
  });
  assert.equal(busyClose.status, 409, 'busy close');
  assert.equal(busyClose.body?.['code'], 'conflict');
  assert.equal(env.registry.get(busy.sessionId)?.sessionId, busy.sessionId);

  // A session bound to a loaded graph is refused and the graph stays routed.
  const boundClose = await postJson(info.url, token, '/sessions/close', {
    sessionId: boundRecord.sessionId,
  });
  assert.equal(boundClose.status, 409, 'bound close');
  assert.equal(boundClose.body?.['code'], 'conflict');
  assert.equal(env.registry.get(boundRecord.sessionId)?.sessionId, boundRecord.sessionId);
  assert.equal((await getJson(info.url, token, '/status/sessions-graph')).status, 200);

  // An idle, unbound session closes for real and disappears from the list.
  const closed = await postJson(info.url, token, '/sessions/close', {
    sessionId: idle.sessionId,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body?.['closed'], true);
  assert.deepEqual(adapter.closedNativeIds, ['native-1']);
  assert.equal(env.registry.get(idle.sessionId), undefined);
  const afterClose = await getJson(info.url, token, '/sessions');
  const remaining = afterClose.body?.['sessions'] as Record<string, unknown>[];
  assert.equal(remaining.length, 2);
  assert.equal(
    remaining.some((session) => session['sessionId'] === idle.sessionId),
    false,
  );

  // Unknown and malformed close requests never touch a session.
  const unknown = await postJson(info.url, token, '/sessions/close', {
    sessionId: 'missing',
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body?.['code'], 'not-found');
  const badBodies: Record<string, unknown>[] = [
    {},
    { sessionId: '' },
    { sessionId: 'bad\u0000id' },
    { sessionId: 'bad\u0007id' },
    { sessionId: 'x'.repeat(513) },
    { sessionId: 7 },
    { sessionId: 'x', extra: true },
  ];
  for (const body of badBodies) {
    const bad = await postJson(info.url, token, '/sessions/close', body);
    assert.equal(bad.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(bad.body?.['code'], 'bad-request');
  }
  assert.equal(env.registry.get(busy.sessionId)?.sessionId, busy.sessionId);
  assert.equal(env.registry.get(boundRecord.sessionId)?.sessionId, boundRecord.sessionId);

  const getClose = await getJson(info.url, token, '/sessions/close');
  assert.equal(getClose.status, 405);
  assert.match(getClose.headers.get('allow') ?? '', /POST/);
  const postSessions = await postJson(info.url, token, '/sessions', {});
  assert.equal(postSessions.status, 405);
  assert.match(postSessions.headers.get('allow') ?? '', /GET/);

  assertNoSecrets(
    `${busyClose.text}\n${boundClose.text}\n${closed.text}\n${unknown.text}`,
    token,
  );
  assert.equal(adapter.closedNativeIds.length, 1);
});

test('a native close failure is a static 500 and keeps the session', async (t) => {
  const adapter = new FailingCloseFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const session = await env.registry.create(env.project);
  const close = await postJson(info.url, token, '/sessions/close', {
    sessionId: session.sessionId,
  });
  assert.equal(close.status, 500);
  assert.equal(close.body?.['code'], 'internal');
  assert.equal(close.text.includes('NATIVE_CLOSE_SECRET'), false);
  assert.equal(close.body?.['error'], 'internal error');
  assert.equal(env.registry.get(session.sessionId)?.sessionId, session.sessionId);
  const list = await getJson(info.url, token, '/sessions');
  assert.equal((list.body?.['sessions'] as unknown[]).length, 1);
});

test('an unloaded graph leaves its session listable and closable', async (t) => {
  const adapter = new TrackingFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const definition = foragerDefinition('retained-session', 'run {{input}}');
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }),
  );
  assert.equal(load.status, 200);
  const session = env.registry.list()[0];
  assert.ok(session !== undefined);
  assert.equal(adapter.closedNativeIds.length, 0);

  const unload = await postJson(info.url, token, '/graphs/unload', {
    graphId: 'retained-session',
  });
  assert.equal(unload.status, 200);
  assert.deepEqual(adapter.closedNativeIds, []);

  const listed = await getJson(info.url, token, '/sessions');
  const summaries = listed.body?.['sessions'] as Record<string, unknown>[];
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.['sessionId'], session.sessionId);
  assert.equal(summaries[0]?.['bound'], false);

  const closed = await postJson(info.url, token, '/sessions/close', {
    sessionId: session.sessionId,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body?.['closed'], true);
  assert.deepEqual(adapter.closedNativeIds, ['native-1']);
  const after = await getJson(info.url, token, '/sessions');
  assert.deepEqual(after.body?.['sessions'], []);
});

test('invalid definitions, bindings and projects are rejected without creating sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const invalidDefinition = {
    schemaVersion: 1,
    id: 'bad-definition',
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake' } },
    },
    edges: [],
  };
  const badDefinition = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(invalidDefinition, env.project, { only: { kind: 'fresh' } }),
  );
  assert.equal(badDefinition.status, 400);
  assert.equal(badDefinition.body?.['code'], 'bad-request');
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);

  const validDefinition = {
    schemaVersion: 1,
    id: 'two-foragers',
    nodes: {
      one: { kind: 'forager', config: { connection: 'fake', prompt: 'one {{input}}' } },
      two: { kind: 'forager', config: { connection: 'fake', prompt: 'two {{input}}' } },
    },
    edges: [],
  };
  const missingBinding = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(validDefinition, env.project, { one: { kind: 'fresh' } }),
  );
  assert.equal(missingBinding.status, 400);
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);

  const invalidKind = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(validDefinition, env.project, {
      one: { kind: 'bogus' },
      two: { kind: 'fresh' },
    }),
  );
  assert.equal(invalidKind.status, 400);
  assert.equal(env.registry.list().length, 0);

  const missingProjectDirectory = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(foragerDefinition('bad-project', 'bad {{input}}'), {
      id: 'missing-project',
      directory: join(env.stateRoot, 'does-not-exist'),
    }, { only: { kind: 'fresh' } }),
  );
  assert.equal(missingProjectDirectory.status, 400);
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('unsupported media types, malformed JSON and unknown fields are rejected', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const wrongType = await readResponse(
    await fetch(`${info.url}/sweep`, {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'text/plain' },
      body: '{}',
    }),
  );
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body?.['code'], 'unsupported-media-type');

  const badJson = await readResponse(
    await fetch(`${info.url}/sweep`, {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      body: '{',
    }),
  );
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body?.['code'], 'bad-request');

  const emptyBody = await readResponse(
    await fetch(`${info.url}/sweep`, {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
    }),
  );
  assert.equal(emptyBody.status, 400);

  const topLevelArray = await readResponse(
    await fetch(`${info.url}/sweep`, {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      body: '[]',
    }),
  );
  assert.equal(topLevelArray.status, 400);

  const unknownSweepField = await postJson(info.url, token, '/sweep', { unexpected: true });
  assert.equal(unknownSweepField.status, 400);

  const unknownTriggerField = await postJson(info.url, token, '/trigger', {
    graphId: 'x',
    nodeId: 'y',
    value: { kind: 'text', text: 'z' },
    extra: true,
  });
  assert.equal(unknownTriggerField.status, 400);

  const definition = foragerDefinition('unknown-fields', 'run {{input}}');
  const unknownProjectField = await postJson(info.url, token, '/graphs/load', {
    definition,
    bindings: { only: { kind: 'fresh' } },
    project: { ...env.project, extra: true },
  });
  assert.equal(unknownProjectField.status, 400);

  const unknownBindingField = await postJson(info.url, token, '/graphs/load', {
    definition,
    bindings: { only: { kind: 'fresh', extra: true } },
    project: env.project,
  });
  assert.equal(unknownBindingField.status, 400);

  const negativeTtl = await postJson(info.url, token, '/graphs/load', {
    ...loadBody(definition, env.project, { only: { kind: 'fresh' } }),
    idleTtlMs: -1,
  });
  assert.equal(negativeTtl.status, 400);

  const fractionalTtl = await postJson(info.url, token, '/graphs/load', {
    ...loadBody(definition, env.project, { only: { kind: 'fresh' } }),
    idleTtlMs: 1.5,
  });
  assert.equal(fractionalTtl.status, 400);

  for (const result of [
    wrongType,
    badJson,
    emptyBody,
    topLevelArray,
    unknownSweepField,
    unknownTriggerField,
    unknownProjectField,
    unknownBindingField,
    negativeTtl,
    fractionalTtl,
  ]) {
    assert.equal(Object.hasOwn(result.body ?? {}, 'stack'), false);
    assert.equal(result.text.includes(token), false);
  }
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('oversized bodies are rejected before the request body is sent or completed', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { maxBodyBytes: 64 });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  // Content-Length alone is enough to reject. The body is never sent at all.
  const announced = await announcedButUnsentBody(info, token, 100);
  assert.equal(announced, 413);

  // A chunked streaming body has no Content-Length. The limit must be enforced
  // while reading, not after `end`.
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      streamController.enqueue(new TextEncoder().encode('x'.repeat(256)));
    },
  });
  const init = {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'content-type': 'application/json',
    },
    body: stream,
    duplex: 'half',
    signal: AbortSignal.timeout(3_000),
  } as unknown as RequestInit & { readonly duplex: 'half' };

  try {
    const response = await fetch(`${info.url}/trigger`, init);
    assert.equal(response.status, 413);
    const result = await readResponse(response);
    assert.equal(result.body?.['code'], 'too-large');
  } finally {
    try {
      controller?.close();
    } catch {
      // The server may already have aborted the request.
    }
  }
});

test('wrong methods return 405 and unknown or traversing paths return 404', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const getTrigger = await getJson(info.url, token, '/trigger');
  assert.equal(getTrigger.status, 405);
  assert.equal(getTrigger.body?.['code'], 'method-not-allowed');
  assert.match(getTrigger.headers.get('allow') ?? '', /POST/);

  const postStatus = await postJson(info.url, token, '/status', {});
  assert.equal(postStatus.status, 405);
  assert.match(postStatus.headers.get('allow') ?? '', /GET/);

  const unknown = await getJson(info.url, token, '/not-a-route');
  assert.equal(unknown.status, 404);

  const nested = await getJson(info.url, token, '/status/a/b');
  assert.equal(nested.status, 404);

  const encodedTraversal = await getJson(
    info.url,
    token,
    '/status/%2e%2e%2fhealth',
  );
  assert.equal(encodedTraversal.status, 404);

  // fetch normalizes literal `..` in a URL, so send this target over the raw
  // HTTP request to prove the server itself does not normalize it.
  const traversal = await rawGet(info, token, '/status/../health');
  assert.equal(traversal.status, 404);
  assert.equal(traversal.text.includes('"harness"'), false);

  const health = await getJson(info.url, token, '/health');
  assert.equal(health.status, 200);
});

test('a second server on the same daemon directory is refused without touching the token', async (t) => {
  const envA = makeEnv();
  const envB = makeEnv();
  t.after(async () => {
    await envA.workspace.stop();
    await envB.workspace.stop();
  });

  const a = await startServer(envA);
  t.after(async () => {
    await a.server.stop();
  });
  const tokenBefore = a.token;
  const infoBefore = readFileSync(a.info.infoPath, 'utf8');

  const b = makeServer(envB, { daemonDir: envA.daemonDir });
  t.after(async () => {
    await b.stop();
  });
  await assert.rejects(
    b.start(),
    (error: unknown) => error instanceof DaemonLockError,
  );
  assert.equal(readFileSync(a.info.tokenPath, 'utf8'), tokenBefore);
  assert.equal(readFileSync(a.info.infoPath, 'utf8'), infoBefore);

  const stillRunning = await getJson(a.info.url, tokenBefore, '/health');
  assert.equal(stillRunning.status, 200);

  await a.server.stop();

  const bInfo = await b.start();
  assert.ok(bInfo.port > 0);
  const bToken = readFileSync(bInfo.tokenPath, 'utf8');
  const started = await getJson(bInfo.url, bToken, '/health');
  assert.equal(started.status, 200);
});

test('stop closes the port, releases the lock and removes token and info; it is idempotent', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const lockPath = join(env.daemonDir, 'daemon.lock');

  assert.equal(existsSync(info.tokenPath), true);
  assert.equal(existsSync(info.infoPath), true);
  assert.equal(existsSync(lockPath), true);

  await running.server.stop();
  assert.equal(existsSync(info.tokenPath), false);
  assert.equal(existsSync(info.infoPath), false);
  assert.equal(existsSync(lockPath), false);
  assert.throws(() => running.server.info(), /not running/);
  await assert.rejects(fetch(`${info.url}/health`, { headers: authHeader(token) }));

  await running.server.stop();

  const env2 = makeEnv();
  t.after(async () => {
    await env2.workspace.stop();
  });
  const replacement = await startServer(env2, { daemonDir: env.daemonDir });
  t.after(async () => {
    await replacement.server.stop();
  });
  const health = await getJson(replacement.info.url, replacement.token, '/health');
  assert.equal(health.status, 200);
});

test('a failed start closes the listener, releases the lock and removes the token', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const port = await freePort();
  const daemonDir = env.daemonDir;
  mkdirSync(daemonDir, { recursive: true });
  const badInfoPath = join(daemonDir, 'info-is-a-directory');
  mkdirSync(badInfoPath);

  const failing = makeServer(env, {
    daemonDir,
    port,
    infoPath: badInfoPath,
  });
  t.after(async () => {
    await failing.stop();
  });
  await assert.rejects(failing.start());
  assert.equal(existsSync(join(daemonDir, 'daemon.lock')), false);
  assert.equal(existsSync(join(daemonDir, 'token')), false);
  assert.equal(statSync(badInfoPath).isDirectory(), true);
  await failing.stop();

  const replacement = await startServer(env, { daemonDir, port });
  t.after(async () => {
    await replacement.server.stop();
  });
  const health = await getJson(replacement.info.url, replacement.token, '/health');
  assert.equal(health.status, 200);
});

test('non-loopback hosts are rejected before any file or socket exists', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });

  for (const host of ['0.0.0.0', 'localhost', '::1', '192.168.1.10']) {
    assert.throws(
      () => makeServer(env, { host: host as unknown as '127.0.0.1' }),
      /loopback|127\.0\.0\.1/i,
    );
  }
  assert.equal(existsSync(env.daemonDir), false);
});

test('the logger records only request metadata', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const health = await getJson(info.url, token, `/health?token=${token}`);
  assert.equal(health.status, 200);

  const missing = await postJson(info.url, token, '/trigger', {
    graphId: 'missing',
    nodeId: 'missing',
    value: { kind: 'text', text: INPUT_SECRET },
  });
  assert.equal(missing.status, 404);

  const unknownPath = await getJson(info.url, token, '/not-a-route');
  assert.equal(unknownPath.status, 404);

  assert.ok(logs.length >= 3);
  for (const line of logs) {
    assert.match(
      line,
      /^control method=(GET|POST) path=\S+ status=\d{3} durationMs=\d+ code=[a-z-]+$/,
    );
  }
  const joined = logs.join('\n');
  assert.equal(joined.includes(token), false);
  assert.equal(joined.includes(INPUT_SECRET), false);
  assert.equal(joined.includes('/health?token='), false);
  assert.match(joined, /method=GET path=\/health status=200/);
  assert.match(joined, /method=POST path=\/trigger status=404/);
});

test('token and info files are 0600 and the daemon directory is 0700 on POSIX', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not meaningful on Windows');
    return;
  }
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info } = running;

  assert.equal(statSync(info.tokenPath).mode & 0o777, 0o600);
  assert.equal(statSync(info.infoPath).mode & 0o777, 0o600);
  assert.equal(statSync(env.daemonDir).mode & 0o777, 0o700);
});

test('trigger with a graphRef lazily loads the manifest graph, then triggers it', async (t) => {
  const env = makeEnv({ output: OUTPUT_SECRET });
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, {
    harness: 'codex',
    logger: (line) => logs.push(line),
  });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'lazy-graph' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'lazy-graph',
    nodeId: 'only',
    value: { kind: 'text', text: INPUT_SECRET },
    graphRef: fixture.manifestPath,
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['graphId'], 'lazy-graph');
  assert.equal(trigger.body?.['result']?.['rest'], true);
  assert.equal(trigger.body?.['result']?.['persisted'], true);

  const status = await getJson(info.url, token, '/status/lazy-graph');
  assert.equal(status.status, 200);
  assert.equal(status.body?.['status']?.['graphId'], 'lazy-graph');
  assert.equal(status.body?.['status']?.['rest'], true);

  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
  assert.equal(env.adapter.prompts.length, 1);
  assert.match(env.adapter.prompts[0] ?? '', /manifest/);
  assert.match(env.adapter.prompts[0] ?? '', new RegExp(INPUT_SECRET));
  assertNoSecrets(`${trigger.text}\n${status.text}\n${logs.join('\n')}`, token);
});

test('a graphRef with a missing or untriggerable node is rejected with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const missingNode = writeManifestFixture(env, { graphId: 'missing-node-graph' });
  const missing = await postJson(info.url, token, '/trigger', {
    graphId: 'missing-node-graph',
    nodeId: 'absent',
    value: { kind: 'text', text: 'x' },
    graphRef: missingNode.manifestPath,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body?.['code'], 'bad-request');

  const condition = writeManifestFixture(env, {
    composition: untriggerableComposition('condition-graph'),
  });
  const untriggerable = await postJson(info.url, token, '/trigger', {
    graphId: 'condition-graph',
    nodeId: 'cond',
    value: { kind: 'text', text: 'x' },
    graphRef: condition.manifestPath,
  });
  assert.equal(untriggerable.status, 400);
  assert.equal(untriggerable.body?.['code'], 'bad-request');

  // A failed lazy load must leave neither a session nor a loaded graph behind.
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
  assert.equal(env.adapter.prompts.length, 0);
  for (const graphId of ['missing-node-graph', 'condition-graph']) {
    const status = await getJson(info.url, token, `/status/${graphId}`);
    assert.equal(status.status, 404);
  }
});

test('a graphRef manifest harness must match the server harness', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'wrong-harness', harness: 'dsh' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'wrong-harness',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.manifestPath,
  });
  assert.equal(trigger.status, 400);
  assert.equal(trigger.body?.['code'], 'bad-request');
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('a broken or missing graphRef manifest is rejected with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'bad-manifest' });

  const cases = [
    join(fixture.root, 'absent.wax.json'),
    writeManifestVariant(fixture.root, 'broken.wax.json', '{"schemaVersion":1,'),
    writeManifestVariant(fixture.root, 'unknown-field.wax.json', {
      ...fixture.manifest,
      typoField: true,
    }),
    writeManifestVariant(fixture.root, 'missing-composition.wax.json', {
      ...fixture.manifest,
      composition: 'absent.json',
    }),
  ];

  for (const manifestPath of cases) {
    const trigger = await postJson(info.url, token, '/trigger', {
      graphId: 'bad-manifest',
      nodeId: 'only',
      value: { kind: 'text', text: 'x' },
      graphRef: manifestPath,
    });
    assert.equal(trigger.status, 400, `manifest should be rejected: ${manifestPath}`);
    assert.equal(trigger.body?.['code'], 'bad-request');
  }

  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('a graphRef with invalid bindings is rejected before any session is created', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const cases: Record<string, unknown>[] = [
    // Schema-level: unknown binding kind.
    { only: { kind: 'bogus' } },
    // Semantic: the forager has no binding at all.
    {},
  ];
  for (const bindings of cases) {
    const fixture = writeManifestFixture(env, {
      graphId: 'bad-bindings',
      bindings,
    });
    const trigger = await postJson(info.url, token, '/trigger', {
      graphId: 'bad-bindings',
      nodeId: 'only',
      value: { kind: 'text', text: 'x' },
      graphRef: fixture.manifestPath,
    });
    assert.equal(trigger.status, 400, JSON.stringify(bindings));
    assert.equal(trigger.body?.['code'], 'bad-request');
    assert.equal(env.registry.list().length, 0);
    assert.equal(env.adapter.displayNames.length, 0);
  }

  // A rejected lazy load leaves nothing behind: the same graph id can be
  // loaded by a corrected manifest and triggered once.
  const retry = writeManifestFixture(env, { graphId: 'bad-bindings' });
  const loaded = await postJson(info.url, token, '/trigger', {
    graphId: 'bad-bindings',
    nodeId: 'only',
    value: { kind: 'text', text: 'retry' },
    graphRef: retry.manifestPath,
  });
  assert.equal(loaded.status, 200);
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
});

test('a graphRef composition whose id differs from graphId is rejected with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'composition-id' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'requested-id',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.manifestPath,
  });
  assert.equal(trigger.status, 400);
  assert.equal(trigger.body?.['code'], 'bad-request');
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('trigger graphRef must be a bounded, non-blank string without control characters', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  for (const graphRef of ['', '   ', `bad\u0000path`, `bad\u0007path`, 'x'.repeat(4_097)]) {
    const trigger = await postJson(info.url, token, '/trigger', {
      graphId: 'graph',
      nodeId: 'only',
      value: { kind: 'text', text: 'x' },
      graphRef,
    });
    assert.equal(trigger.status, 400, JSON.stringify(graphRef.slice(0, 8)));
    assert.equal(trigger.body?.['code'], 'bad-request');
  }
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('trigger graphRef is a manifest path, not a composition path', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'manifest-only' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'manifest-only',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.compositionPath,
  });
  assert.equal(trigger.status, 400);
  assert.equal(trigger.body?.['code'], 'bad-request');
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('an already loaded graph ignores a broken graphRef', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(foragerDefinition('loaded-graph', 'loaded {{input}}'), env.project, {
      only: { kind: 'fresh' },
    }),
  );
  assert.equal(load.status, 200);
  const fixture = writeManifestFixture(env, { graphId: 'loaded-graph' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'loaded-graph',
    nodeId: 'only',
    value: { kind: 'text', text: 'memory wins' },
    graphRef: join(fixture.root, 'absent.wax.json'),
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['graphId'], 'loaded-graph');
  // Memory was used: no second load and no extra session.
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
  assert.equal(env.adapter.prompts.length, 1);
});

test('an already loaded graph is never replaced by a graphRef composition', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  // Harness must match so a replacement bug cannot be masked by the harness
  // check: the only thing that may reject this trigger is the memory-first rule.
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(foragerDefinition('sticky-graph', 'sticky {{input}}'), env.project, {
      only: { kind: 'fresh' },
    }),
  );
  assert.equal(load.status, 200);
  const before = await getJson(info.url, token, '/status/sticky-graph');
  const revision = before.body?.['status']?.['graphRevision'];

  const otherComposition = {
    schemaVersion: 1,
    id: 'sticky-graph',
    nodes: {
      other: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'other {{input}}' },
      },
    },
    edges: [],
  };
  const fixture = writeManifestFixture(env, {
    graphId: 'sticky-graph',
    composition: otherComposition,
    bindings: { other: { kind: 'fresh' } },
  });

  // The node exists in the manifest graph but not in the loaded graph. The
  // trigger must not swap in the manifest composition.
  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'sticky-graph',
    nodeId: 'other',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.manifestPath,
  });
  assert.equal(trigger.status, 400);

  const after = await getJson(info.url, token, '/status/sticky-graph');
  assert.equal(after.status, 200);
  assert.equal(after.body?.['status']?.['graphRevision'], revision);
  assert.deepEqual(
    (after.body?.['status']?.['nodes'] as { nodeId: string }[]).map((node) => node.nodeId),
    ['only'],
  );
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
});

test('a failed graphRef restore rolls back the session it created', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const graphId = 'restore-failure';
  const fixture = writeManifestFixture(env, { graphId });

  // A structurally valid Honey field from a different graph revision restores
  // only after sessions have been created, so it exercises GraphHost rollback.
  const honeyDir = join(
    env.stateRoot,
    'apiaries',
    'apiary',
    'compositions',
    graphId,
    'honey',
  );
  mkdirSync(honeyDir, { recursive: true });
  writeFileSync(
    join(honeyDir, 'field.json'),
    JSON.stringify({
      schemaVersion: 1,
      compositionId: graphId,
      graphRevision: 'stale-revision',
      rest: true,
      nodes: {},
    }),
  );

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId,
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.manifestPath,
  });
  // GraphLoadError maps to 409 in the lazy-load path (see brief M6a §4).
  assert.equal(trigger.status, 409);
  assert.equal(trigger.body?.['code'], 'conflict');
  // A session was created before the restore failed; the rollback closed it.
  assert.equal(env.adapter.displayNames.length, 1);
  assert.equal(env.registry.list().length, 0);
  const status = await getJson(info.url, token, `/status/${graphId}`);
  assert.equal(status.status, 404);
});

test('concurrent triggers with the same graphRef load exactly once', async (t) => {
  const adapter = new GatedFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'racing-graph' });
  const body = {
    graphId: 'racing-graph',
    nodeId: 'only',
    value: { kind: 'text', text: 'race' },
    graphRef: fixture.manifestPath,
  };

  const first = postJson(info.url, token, '/trigger', body);
  // The first request is provably inside loadGraph (creating its session).
  await withTimeout(adapter.createStarted, 5_000, 'first graphRef load');
  const second = postJson(info.url, token, '/trigger', body);
  const secondResult = await withTimeout(second, 5_000, 'second graphRef trigger');
  adapter.release();
  const firstResult = await withTimeout(first, 5_000, 'first graphRef trigger');

  const statuses = [firstResult.status, secondResult.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const conflict = firstResult.status === 409 ? firstResult : secondResult;
  assert.equal(conflict.body?.['code'], 'conflict');
  assert.equal(env.registry.list().length, 1);
  assert.equal(adapter.displayNames.length, 1);
});

test('answer resolves an open user hover over real HTTP and rejects invalid targets and tokens', async (t) => {
  const env = makeEnv({ output: OUTPUT_SECRET });
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const responses: string[] = [];

  const definition = userAnswerComposition('answer-memory');
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 0),
  );
  responses.push(load.text);
  assert.equal(load.status, 200);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
  });
  responses.push(trigger.text);
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['hovered'], true);
  const hoverToken = hoverTokenOf(running.server, 'answer-memory', 'ask');

  const wrongToken = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
    token: 'hv_wrong',
  });
  responses.push(wrongToken.text);
  assert.equal(wrongToken.status, 409);
  assert.equal(wrongToken.body?.['code'], 'conflict');
  assert.match(wrongToken.body?.['error'] ?? '', /hover is not open/);
  assert.equal(wrongToken.text.includes('hv_wrong'), false);
  assert.equal(wrongToken.text.includes(hoverToken), false);

  for (const badToken of ['', `bad\u0000token`, `bad\u0007token`, 'x'.repeat(4_097)]) {
    const rejected = await postJson(info.url, token, '/answer', {
      graphId: 'answer-memory',
      nodeId: 'ask',
      value: { kind: 'text', text: 'x' },
      token: badToken,
    });
    responses.push(rejected.text);
    assert.equal(rejected.status, 400, JSON.stringify(badToken.slice(0, 8)));
    assert.equal(rejected.body?.['code'], 'bad-request');
  }
  for (const badGraphRef of ['', '   ', `bad\u0000path`, `bad\u0007path`, 'x'.repeat(4_097)]) {
    const rejected = await postJson(info.url, token, '/answer', {
      graphId: 'answer-memory',
      nodeId: 'ask',
      value: { kind: 'text', text: 'x' },
      graphRef: badGraphRef,
    });
    responses.push(rejected.text);
    assert.equal(rejected.status, 400, JSON.stringify(badGraphRef.slice(0, 8)));
    assert.equal(rejected.body?.['code'], 'bad-request');
  }

  const answered = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
    token: hoverToken,
  });
  responses.push(answered.text);
  assert.equal(answered.status, 200);
  assert.equal(answered.body?.['result']?.['rest'], true);
  assert.equal(answered.body?.['result']?.['hovered'], false);
  assert.equal(answered.body?.['result']?.['persisted'], true);
  assert.equal(answered.body?.['result']?.['status']?.['rest'], true);

  const again = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: 'again' },
  });
  responses.push(again.text);
  assert.equal(again.status, 409);
  assert.equal(again.body?.['code'], 'conflict');

  const unknownGraph = await postJson(info.url, token, '/answer', {
    graphId: 'missing',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
  });
  responses.push(unknownGraph.text);
  assert.equal(unknownGraph.status, 404);

  const unknownNode = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'absent',
    value: { kind: 'text', text: 'x' },
  });
  responses.push(unknownNode.text);
  assert.equal(unknownNode.status, 400);

  const foragerDefinitionBody = foragerDefinition('answer-forager', 'run {{input}}');
  const foragerLoad = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(foragerDefinitionBody, env.project, { only: { kind: 'fresh' } }, 0),
  );
  responses.push(foragerLoad.text);
  assert.equal(foragerLoad.status, 200);
  const nonUser = await postJson(info.url, token, '/answer', {
    graphId: 'answer-forager',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
  });
  responses.push(nonUser.text);
  assert.equal(nonUser.status, 400);
  assert.equal(nonUser.body?.['code'], 'bad-request');

  const getAnswer = await getJson(info.url, token, '/answer');
  responses.push(getAnswer.text);
  assert.equal(getAnswer.status, 405);
  assert.match(getAnswer.headers.get('allow') ?? '', /POST/);

  assertNoSecrets(`${responses.join('\n')}\n${logs.join('\n')}`, token);
});

test('answer with a graphRef loads the manifest, restores a flushed hover and answers it', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, {
    harness: 'codex',
    allowHoverUnload: true,
    now: clock.now,
  });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const composition = userForagerComposition('answer-lazy');
  const bindings = { idle: { kind: 'fresh' } };
  const fixture = writeManifestFixture(env, {
    graphId: 'answer-lazy',
    composition,
    bindings,
  });

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(composition, env.project, bindings, 0),
  );
  assert.equal(load.status, 200);
  assert.equal(env.adapter.displayNames.length, 1);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting' },
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['hovered'], true);

  // waxd-style hover unload: the hover is flushed to Honey before release.
  const unload = await postJson(info.url, token, '/graphs/unload', {
    graphId: 'answer-lazy',
  });
  assert.equal(unload.status, 200);
  assert.equal(unload.body?.['unloaded'], true);
  // The flushed hover's session is retained by the unload.
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);

  const answered = await postJson(info.url, token, '/answer', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'answered' },
    graphRef: fixture.manifestPath,
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body?.['result']?.['rest'], true);
  assert.equal(answered.body?.['result']?.['hovered'], false);
  assert.equal(answered.body?.['result']?.['persisted'], true);
  // The lazy load created a replacement fresh session; the retained one stays
  // registered and the hover was restored.
  assert.equal(env.adapter.displayNames.length, 2);
  assert.equal(env.adapter.prompts.length, 0);
  assert.equal(env.registry.list().length, 2);

  const status = await getJson(info.url, token, '/status/answer-lazy');
  assert.equal(status.status, 200);
  assert.equal(status.body?.['status']?.['rest'], true);

  // A loaded graph always wins over graphRef, even a broken one.
  // The restored ask node was last activated at the frozen clock time, so let
  // its 1000ms pacing elapse before triggering it again.
  clock.advance(1_000);
  const parkAgain = await postJson(info.url, token, '/trigger', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting again' },
  });
  assert.equal(parkAgain.body?.['result']?.['hovered'], true);
  const memoryWins = await postJson(info.url, token, '/answer', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'answered from memory' },
    graphRef: join(fixture.root, 'absent.wax.json'),
  });
  assert.equal(memoryWins.status, 200);
  assert.equal(memoryWins.body?.['result']?.['rest'], true);
  assert.equal(env.adapter.displayNames.length, 2);
});

test('answer with a graphRef rejects bad manifests, nodes and bindings with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { harness: 'codex' });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const notLoaded = await postJson(info.url, token, '/answer', {
    graphId: 'not-loaded',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
  });
  assert.equal(notLoaded.status, 404);
  assert.equal(notLoaded.body?.['code'], 'not-found');

  const foragerOnly = writeManifestFixture(env, { graphId: 'forager-only' });
  for (const nodeId of ['only', 'absent']) {
    const rejected = await postJson(info.url, token, '/answer', {
      graphId: 'forager-only',
      nodeId,
      value: { kind: 'text', text: 'x' },
      graphRef: foragerOnly.manifestPath,
    });
    assert.equal(rejected.status, 400, nodeId);
    assert.equal(rejected.body?.['code'], 'bad-request');
  }

  const wrongHarness = writeManifestFixture(env, {
    graphId: 'wrong-harness-answer',
    harness: 'dsh',
    composition: userAnswerComposition('wrong-harness-answer'),
    bindings: {},
  });
  const harness = await postJson(info.url, token, '/answer', {
    graphId: 'wrong-harness-answer',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
    graphRef: wrongHarness.manifestPath,
  });
  assert.equal(harness.status, 400);

  const missingManifest = await postJson(info.url, token, '/answer', {
    graphId: 'missing-manifest',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
    graphRef: join(foragerOnly.root, 'absent.wax.json'),
  });
  assert.equal(missingManifest.status, 400);

  // A user+forager composition with no forager binding fails semantic binding
  // validation before any session exists.
  const badBindings = writeManifestFixture(env, {
    graphId: 'bad-bindings-answer',
    composition: userForagerComposition('bad-bindings-answer'),
    bindings: {},
  });
  const bindings = await postJson(info.url, token, '/answer', {
    graphId: 'bad-bindings-answer',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
    graphRef: badBindings.manifestPath,
  });
  assert.equal(bindings.status, 400);
  assert.equal(bindings.body?.['code'], 'bad-request');

  assert.equal(env.adapter.displayNames.length, 0);
  assert.equal(env.adapter.prompts.length, 0);
  assert.equal(env.registry.list().length, 0);
});

test('a hover-only graph is swept only when allowHoverUnload is enabled', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, {
    allowHoverUnload: true,
    now: clock.now,
  });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const definition = userAnswerComposition('hover-sweep');

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 100),
  );
  assert.equal(load.status, 200);
  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'hover-sweep',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting' },
  });
  assert.equal(trigger.body?.['result']?.['hovered'], true);

  clock.advance(100);
  const sweep = await postJson(info.url, token, '/sweep', {});
  assert.equal(sweep.status, 200);
  assert.deepEqual(sweep.body?.['report']?.['unloaded'], ['hover-sweep']);
  assert.deepEqual(sweep.body?.['report']?.['failed'], []);
  const gone = await getJson(info.url, token, '/status/hover-sweep');
  assert.equal(gone.status, 404);

  // The sweep flushed the hover: reloading restores it and it can be answered.
  const reload = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 0),
  );
  assert.equal(reload.status, 200);
  assert.equal(reload.body?.['status']?.['rest'], false);
  assert.equal(reload.body?.['status']?.['hovered'], true);
  const answer = await postJson(info.url, token, '/answer', {
    graphId: 'hover-sweep',
    nodeId: 'ask',
    value: { kind: 'text', text: 'answered' },
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body?.['result']?.['rest'], true);

  // The default (false) still refuses the same graph.
  const clockB = new FakeClock(1_000);
  const envB = makeEnv();
  t.after(async () => {
    await envB.workspace.stop();
  });
  const runningB = await startServer(envB, { now: clockB.now });
  t.after(async () => {
    await runningB.server.stop();
  });
  const loadB = await postJson(
    runningB.info.url,
    runningB.token,
    '/graphs/load',
    loadBody(definition, envB.project, {}, 100),
  );
  assert.equal(loadB.status, 200);
  const triggerB = await postJson(runningB.info.url, runningB.token, '/trigger', {
    graphId: 'hover-sweep',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting' },
  });
  assert.equal(triggerB.body?.['result']?.['hovered'], true);
  clockB.advance(100);
  const sweepB = await postJson(runningB.info.url, runningB.token, '/sweep', {});
  assert.deepEqual(sweepB.body?.['report']?.['unloaded'], []);
  assert.deepEqual(sweepB.body?.['report']?.['skipped'], [
    { id: 'hover-sweep', reason: 'unsafe' },
  ]);
  const unloadB = await postJson(runningB.info.url, runningB.token, '/graphs/unload', {
    graphId: 'hover-sweep',
  });
  assert.equal(unloadB.status, 409);
  assert.equal(unloadB.body?.['code'], 'conflict');
  assert.equal(unloadB.body?.['status']?.['hovered'], true);
});

test('session TTL options are validated and disabled by default', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });

  assert.throws(() => makeServer(env, { sessionIdleTtlMs: -1 }), TypeError);
  assert.throws(() => makeServer(env, { sessionIdleTtlMs: 1.5 }), TypeError);
  assert.throws(() => makeServer(env, { sessionIdleTtlMs: Number.NaN }), TypeError);
  assert.throws(() => makeServer(env, { sessionSweepIntervalMs: -1 }), TypeError);
  assert.throws(
    () => makeServer(env, { sessionIdleTtlMs: 10, sessionSweepIntervalMs: 0 }),
    TypeError,
  );
  // A zero interval is accepted when the TTL itself is disabled.
  const disabled = makeServer(env, { sessionIdleTtlMs: 0, sessionSweepIntervalMs: 0 });
  assert.equal(disabled instanceof ControlServer, true);
});

test('POST /sessions/sweep closes orphan idle sessions but never bound or busy ones', async (t) => {
  const clock = new FakeClock(1_000);
  const adapter = new HoldingFakeAdapter();
  const env = makeEnvWithAdapter(adapter, () => new Date(clock.time).toISOString());
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { sessionIdleTtlMs: 1_000 });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const busy = await env.registry.create(env.project);
  // The holding fake never emits a terminal event, so this stays busy.
  await env.workspace.submit(busy.sessionId, 'hold');
  const idle = await env.registry.create(env.project);

  const definition = foragerDefinition('session-sweep-graph', 'run {{input}}');
  const loaded = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }),
  );
  assert.equal(loaded.status, 200);
  const bound = env.registry.list().find((record) => record.nativeId === 'native-3');
  assert.ok(bound !== undefined);

  // Nothing is idle long enough yet: every session is skipped.
  clock.advance(500);
  const early = await postJson(info.url, token, '/sessions/sweep', {});
  assert.equal(early.status, 200);
  assert.deepEqual(early.body?.['report'], {
    closed: [],
    skipped: [busy.sessionId, idle.sessionId, bound.sessionId],
    failed: [],
  });

  clock.advance(600);
  const expired = await postJson(info.url, token, '/sessions/sweep', {});
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.body?.['report'], {
    closed: [idle.sessionId],
    skipped: [busy.sessionId, bound.sessionId],
    failed: [],
  });
  // The orphan closed; the busy and graph-bound sessions survive.
  assert.equal(env.registry.has(idle.sessionId), false);
  assert.equal(env.registry.has(busy.sessionId), true);
  assert.equal(env.registry.has(bound.sessionId), true);
  assert.deepEqual(adapter.closedNativeIds, ['native-2']);
  // The loaded graph is untouched and its session still bound.
  assert.equal((await getJson(info.url, token, '/status/session-sweep-graph')).status, 200);

  // The explicit session list still exposes only the five documented fields.
  const list = await getJson(info.url, token, '/sessions');
  const summaries = list.body?.['sessions'] as Record<string, unknown>[];
  assert.deepEqual(Object.keys(summaries[0] ?? {}).sort(), [
    'bound',
    'busy',
    'harness',
    'projectId',
    'sessionId',
  ]);
  assert.equal(list.text.includes('lastAccessAt'), false);
  assertNoSecrets(`${early.text}\n${expired.text}`, token);

  // Malformed sweeps never reach the registry.
  const getSweep = await getJson(info.url, token, '/sessions/sweep');
  assert.equal(getSweep.status, 405);
  assert.match(getSweep.headers.get('allow') ?? '', /POST/);
  const unknownField = await postJson(info.url, token, '/sessions/sweep', { extra: true });
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body?.['code'], 'bad-request');
});

test('the automatic session sweep closes idle sessions, is unrefed and stops with the server', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnvWithAdapter(new FakeAdapter(), () => new Date(clock.time).toISOString());
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, {
    sessionIdleTtlMs: 100,
    sessionSweepIntervalMs: 10,
  });
  t.after(async () => {
    await running.server.stop();
  });

  const timer = (running.server as unknown as { sweepTimer?: NodeJS.Timeout }).sweepTimer;
  assert.ok(timer !== undefined, 'enabled TTL must start a sweep timer');
  // Cleanup must never keep the daemon process alive.
  assert.equal(timer.hasRef(), false);

  const idle = await env.registry.create(env.project);
  clock.advance(1_000);
  const deadline = Date.now() + 2_000;
  while (env.registry.has(idle.sessionId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(env.registry.has(idle.sessionId), false);

  await running.server.stop();
  const afterStop = (running.server as unknown as { sweepTimer?: NodeJS.Timeout }).sweepTimer;
  assert.equal(afterStop, undefined, 'stop must clear the sweep timer');
});

test('session sweep is disabled by default: no timer and a no-op manual sweep', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });

  assert.equal(
    (running.server as unknown as { sweepTimer?: NodeJS.Timeout }).sweepTimer,
    undefined,
  );
  const idle = await env.registry.create(env.project);
  const sweep = await postJson(running.info.url, running.token, '/sessions/sweep', {});
  assert.equal(sweep.status, 200);
  assert.deepEqual(sweep.body?.['report'], { closed: [], skipped: [], failed: [] });
  assert.equal(env.registry.has(idle.sessionId), true);
});

test('an automatic sweep failure is metadata-only and does not crash the server', async (t) => {
  const adapter = new FakeAdapter();
  const workspace = new Workspace(adapter);
  const clock = new FakeClock(1_000);
  const registry = new ThrowingSweepRegistry({
    workspace,
    harness: 'fake-harness',
    now: () => new Date(clock.time).toISOString(),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-control-sweep-failure-'));
  const env: TestEnv = {
    adapter,
    workspace,
    registry,
    project: {
      id: 'project-sweep-failure',
      directory: mkdtempSync(join(tmpdir(), 'wax-control-project-')),
    },
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
  t.after(async () => {
    await workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, {
    sessionIdleTtlMs: 100,
    sessionSweepIntervalMs: 10,
    logger: (line) => logs.push(line),
  });
  t.after(async () => {
    await running.server.stop();
  });

  const deadline = Date.now() + 2_000;
  while (registry.sweepCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(registry.sweepCalls > 0, 'the automatic sweep never ran');

  const health = await getJson(running.info.url, running.token, '/health');
  assert.equal(health.status, 200);
  const sweepLog = logs.find((line) => line.includes('event=session-sweep-failed'));
  assert.ok(sweepLog !== undefined, `no failure metadata was logged: ${logs.join(' | ')}`);
  // Only the error name is logged; a message could carry sensitive text.
  assert.equal(sweepLog.includes('SWEEP_SECRET'), false);
  assert.match(sweepLog, /error=Error/);
});
