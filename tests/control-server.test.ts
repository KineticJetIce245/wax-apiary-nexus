import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ControlServer,
  type ControlServerInfo,
  type ControlServerOptions,
} from '../src/control/server.js';
import { DaemonLockError } from '../src/daemon/daemon-lock.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
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
  const adapter = new FakeAdapter(adapterOptions);
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `project-${String(projectSeq)}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-control-project-')),
  };
  const registry = new SessionRegistry({
    workspace,
    harness: 'fake-harness',
    now: () => FIXED_NOW,
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
  assert.equal(env.registry.list().length, 0);

  const gone = await getJson(info.url, token, '/status/sweepme');
  assert.equal(gone.status, 404);
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
