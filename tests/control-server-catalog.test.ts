import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ControlServer, type ControlServerOptions } from '../src/control/server.js';
import { LiveHiveCatalog } from '../src/daemon/live-hive-catalog.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';

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
  readonly url: string;
  readonly token: string;
}

function makeEnv(): TestEnv {
  const adapter = new FakeAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: `project-${String(Date.now())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9b-control-project-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['codex', workspace]]),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9b-control-state-'));
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
    registry: env.registry,
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
    sessionIdleTtlMs: 0,
    ...overrides,
  });
}

async function startServer(
  env: TestEnv,
  overrides: Partial<ControlServerOptions> = {},
): Promise<RunningServer> {
  const server = makeServer(env, overrides);
  const info = await server.start();
  return { server, url: info.url, token: readFileSync(info.tokenPath, 'utf8').trim() };
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function getJson(
  running: RunningServer,
  path: string,
): Promise<{ status: number; body: Record<string, any> | undefined }> {
  const response = await fetch(`${running.url}${path}`, { headers: headers(running.token) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function postJson(
  running: RunningServer,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, any> | undefined }> {
  const response = await fetch(`${running.url}${path}`, {
    method: 'POST',
    headers: { ...headers(running.token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function definition(id = 'live'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt: 'go {{input}}' } },
    },
    edges: [],
  };
}

function loadBody(env: TestEnv, idleTtlMs?: number): Record<string, unknown> {
  return {
    definition: definition(),
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('GET /catalog exposes loaded and unloaded identities from the durable catalog', async (t) => {
  const env = makeEnv();
  const catalogPath = join(env.daemonDir, 'live-catalog.json');
  const catalog = new LiveHiveCatalog(catalogPath);
  const running = await startServer(env, { catalog });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const empty = await getJson(running, '/catalog');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body?.['entries'], []);

  const loaded = await postJson(running, '/graphs/load', loadBody(env));
  assert.equal(loaded.status, 200);

  const catalogResponse = await getJson(running, '/catalog');
  assert.equal(catalogResponse.status, 200);
  const entries = catalogResponse.body?.['entries'] as Record<string, unknown>[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.['liveId'], 'live');
  assert.equal(entries[0]?.['state'], 'loaded');
  assert.deepEqual(Object.keys(entries[0] ?? {}).sort(), [
    'lastAccessAt',
    'liveId',
    'loadedAt',
    'state',
  ]);

  const unloaded = await postJson(running, '/graphs/unload', { graphId: 'live' });
  assert.equal(unloaded.status, 200);
  const after = await getJson(running, '/catalog');
  const afterEntries = after.body?.['entries'] as Record<string, unknown>[];
  assert.equal(afterEntries[0]?.['state'], 'unloaded');
  assert.equal(afterEntries[0]?.['lastUnloadReason'], 'unload');

  const onDisk = new LiveHiveCatalog(catalogPath);
  assert.equal(onDisk.get('live')?.state, 'unloaded');
});

test('the graph sweep timer unloads an expired graph and records the reason', async (t) => {
  const env = makeEnv();
  let now = 1_000;
  const catalog = new LiveHiveCatalog(join(env.daemonDir, 'live-catalog.json'), {
    now: () => new Date(now).toISOString(),
  });
  const running = await startServer(env, {
    catalog,
    now: () => now,
    graphSweepIntervalMs: 10,
  });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const loaded = await postJson(running, '/graphs/load', loadBody(env, 100));
  assert.equal(loaded.status, 200);
  now += 1_000;

  await waitFor('automatic graph sweep', async () => {
    const response = await getJson(running, '/catalog');
    const entries = response.body?.['entries'] as Record<string, unknown>[];
    return entries[0]?.['state'] === 'unloaded';
  });
  const catalogResponse = await getJson(running, '/catalog');
  const entries = catalogResponse.body?.['entries'] as Record<string, unknown>[];
  assert.equal(entries[0]?.['lastUnloadReason'], 'sweep');
  assert.equal((await getJson(running, '/status/live')).status, 404);
});

test('graphSweepIntervalMs 0 disables the timer but keeps manual sweep', async (t) => {
  const env = makeEnv();
  let now = 1_000;
  const running = await startServer(env, {
    now: () => now,
    graphSweepIntervalMs: 0,
  });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const loaded = await postJson(running, '/graphs/load', loadBody(env, 100));
  assert.equal(loaded.status, 200);
  now += 1_000;
  await assert.rejects(
    waitFor(
      'disabled automatic graph sweep',
      async () => (await getJson(running, '/status/live')).status === 404,
      150,
    ),
    /timed out waiting for disabled automatic graph sweep/,
  );
  assert.equal((await getJson(running, '/status/live')).status, 200);

  const manual = await postJson(running, '/sweep', {});
  assert.equal(manual.status, 200);
  assert.deepEqual(manual.body?.['report']?.['unloaded'], ['live']);
  assert.equal((await getJson(running, '/status/live')).status, 404);

  assert.throws(
    () => makeServer(env, { graphSweepIntervalMs: -1 }),
    TypeError,
  );
});

test('a slow failing graph sweep does not overlap and is logged without crashing', { timeout: 10_000 }, async (t) => {
  const env = makeEnv();
  const logs: string[] = [];
  const running = await startServer(env, {
    graphSweepIntervalMs: 10,
    logger: (line) => logs.push(line),
  });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const host = (running.server as unknown as {
    graphHost?: { sweep(): Promise<unknown> };
  }).graphHost;
  assert.ok(host !== undefined);

  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.sweep = async () => {
    calls += 1;
    await gate;
    throw new Error('SWEEP_SECRET');
  };

  await waitFor('first graph sweep tick', () => calls === 1);
  await assert.rejects(
    waitFor('overlapping graph sweep tick', () => calls >= 2, 250),
    /timed out waiting for overlapping graph sweep tick/,
  );
  assert.equal(calls, 1, 'overlapping timer ticks must be skipped');
  release();

  await waitFor(
    'graph sweep failure log',
    () => logs.some((line) => line.includes('event=graph-sweep-failed')),
  );
  // The guard clears after the failure, so the timer keeps running.
  await waitFor('graph sweep retry', () => calls >= 2);
  assert.equal((await getJson(running, '/health')).status, 200);
});
