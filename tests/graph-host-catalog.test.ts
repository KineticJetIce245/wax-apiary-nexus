import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LiveHiveHost,
  type LiveHiveHostEvent,
} from '../src/daemon/graph-host.js';
import { LiveHiveCatalog } from '../src/daemon/live-hive-catalog.js';
import type { GraphBindings } from '../src/graph/binding.js';
import type { Project } from '../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type NodeDefinition,
  type NodeId,
  type Value,
} from '../src/runtime/index.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { triggerRun } from './support/graph-host-fixtures.js';

interface Env {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
}

function makeEnv(): Env {
  const adapter = new FakeAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: `project-${String(Date.now())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9b-host-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  return { adapter, workspace, registry, project };
}

function definition(id = 'live'): CompositionDefinition {
  const parsed = parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt: 'go {{input}}' } },
    },
    edges: [],
  });
  const nodes = new Map<NodeId, NodeDefinition>();
  for (const [nodeId, node] of parsed.nodes) {
    nodes.set(nodeId, { ...node, minIntervalMs: 0 });
  }
  return { ...parsed, nodes };
}

function bindings(): GraphBindings {
  return { only: { kind: 'fresh' } };
}

function text(value: string): Value {
  return { message: value };
}

function catalogPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wax-m9b-host-catalog-')), 'live-catalog.json');
}

test('load and unload retain catalog identity and persist it', async (t) => {
  const env = makeEnv();
  const path = catalogPath();
  const catalog = new LiveHiveCatalog(path);
  const host = new LiveHiveHost({
    registry: env.registry,
    catalog,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  await host.loadGraph({
    definition: definition(),
    bindings: bindings(),
    project: env.project,
  });

  assert.equal(catalog.get('live')?.state, 'loaded');
  assert.ok(catalog.get('live')?.loadedAt !== undefined);
  assert.deepEqual(host.catalogEntries(), catalog.list());
  assert.equal(existsSync(path), true);

  assert.equal(await host.unload('live'), true);
  assert.equal(catalog.get('live')?.state, 'unloaded');
  assert.equal(catalog.get('live')?.lastUnloadReason, 'unload');

  // A fresh catalog instance sees the same identities after the host stops.
  const reloaded = new LiveHiveCatalog(path);
  assert.equal(reloaded.get('live')?.state, 'unloaded');
  assert.equal(reloaded.get('live')?.lastUnloadReason, 'unload');
});

test('sweep records the sweep unload reason', async (t) => {
  const env = makeEnv();
  const catalog = new LiveHiveCatalog(catalogPath());
  let current = 1_000;
  const host = new LiveHiveHost({
    registry: env.registry,
    catalog,
    now: () => current,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  await host.loadGraph({
    definition: definition(),
    bindings: bindings(),
    project: env.project,
    idleTtlMs: 100,
  });

  current += 1_000;
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, ['live']);
  assert.equal(catalog.get('live')?.state, 'unloaded');
  assert.equal(catalog.get('live')?.lastUnloadReason, 'sweep');
});

test('dispose records the dispose unload reason', async (t) => {
  const env = makeEnv();
  const catalog = new LiveHiveCatalog(catalogPath());
  const host = new LiveHiveHost({
    registry: env.registry,
    catalog,
  });
  t.after(async () => {
    await env.workspace.stop();
  });

  await host.loadGraph({
    definition: definition(),
    bindings: bindings(),
    project: env.project,
  });
  await host.dispose();

  assert.equal(catalog.get('live')?.state, 'unloaded');
  assert.equal(catalog.get('live')?.lastUnloadReason, 'dispose');
});

test('trigger refreshes lastAccessAt', async (t) => {
  const env = makeEnv();
  let current = 1_000;
  const catalog = new LiveHiveCatalog(catalogPath(), {
    now: () => new Date(current).toISOString(),
  });
  const host = new LiveHiveHost({
    registry: env.registry,
    catalog,
    now: () => current,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  await host.loadGraph({
    definition: definition(),
    bindings: bindings(),
    project: env.project,
  });
  const loadedAt = catalog.get('live')?.lastAccessAt;

  current += 5_000;
  const result = await triggerRun(host, 'live', 'only', text('hello'));
  assert.equal(result.rest, true);
  assert.notEqual(catalog.get('live')?.lastAccessAt, loadedAt);
});

test('catalog save failure is metadata-only and never changes load/unload', async (t) => {
  class FailingCatalog extends LiveHiveCatalog {
    override save(): void {
      throw new Error('CATALOG_SECRET');
    }
  }

  const env = makeEnv();
  const catalog = new FailingCatalog(catalogPath());
  const events: LiveHiveHostEvent[] = [];
  const host = new LiveHiveHost({
    registry: env.registry,
    catalog,
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const status = await host.loadGraph({
    definition: definition(),
    bindings: bindings(),
    project: env.project,
  });
  assert.equal(status.graphId, 'live');
  assert.equal(catalog.get('live')?.state, 'loaded');

  assert.equal(await host.unload('live'), true);
  assert.equal(catalog.get('live')?.state, 'unloaded');

  const failed = events.filter((event) => event.type === 'graph.catalog-failed');
  assert.deepEqual(
    failed.map((event) => (event.type === 'graph.catalog-failed' ? event.phase : '')),
    ['load', 'unload'],
  );
  assert.equal(
    failed.every(
      (event) => event.type === 'graph.catalog-failed' && event.error.includes('CATALOG_SECRET'),
    ),
    true,
  );
});

test('catalogEntries is empty when no catalog is configured', async () => {
  const env = makeEnv();
  const host = new LiveHiveHost({
    registry: env.registry,
  });
  try {
    assert.deepEqual(host.catalogEntries(), []);
  } finally {
    await env.workspace.stop();
  }
});
