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
import { bList, bLoad, bUnload } from './support/control-server-http.js';

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
    liveProject: env.project,
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

test('GET /lives exposes loaded and unloaded identities from the durable catalog', async (t) => {
  const env = makeEnv();
  const catalogPath = join(env.daemonDir, 'live-catalog.json');
  const catalog = new LiveHiveCatalog(catalogPath);
  const running = await startServer(env, { catalog });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const empty = await bList(running.url, running.token);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body?.['lives'], []);

  const loaded = await bLoad(running.url, running.token, loadBody(env));
  assert.equal(loaded.status, 200);

  const second = await bLoad(running.url, running.token, {
    definition: definition('second'),
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  assert.equal(second.status, 200);

  const listResponse = await bList(running.url, running.token);
  assert.equal(listResponse.status, 200);
  const entries = listResponse.body?.['lives'] as Record<string, unknown>[];
  assert.equal(entries.length, 2);
  const loadedById = new Map(entries.map((entry) => [entry['liveId'], entry]));
  assert.equal(loadedById.get('live')?.['state'], 'loaded');
  assert.equal(loadedById.get('second')?.['state'], 'loaded');
  assert.deepEqual(Object.keys(loadedById.get('live') ?? {}).sort(), [
    'catalog',
    'liveId',
    'state',
    'status',
  ]);

  const unloaded = await bUnload(running.url, running.token, 'live');
  assert.equal(unloaded.status, 200);
  const after = await bList(running.url, running.token);
  const afterEntries = after.body?.['lives'] as Record<string, unknown>[];
  const afterById = new Map(afterEntries.map((entry) => [entry['liveId'], entry]));
  assert.equal(afterEntries.length, 2);
  assert.equal(afterById.get('live')?.['state'], 'unloaded');
  assert.equal(afterById.get('second')?.['state'], 'loaded');
  assert.equal(
    (afterById.get('live')?.['catalog'] as Record<string, unknown>)?.['lastUnloadReason'],
    'unload',
  );

  const onDisk = new LiveHiveCatalog(catalogPath);
  assert.equal(onDisk.get('live')?.state, 'unloaded');
});
