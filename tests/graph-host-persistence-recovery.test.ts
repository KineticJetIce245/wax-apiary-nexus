import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import { GraphHost, GraphLoadError } from '../src/daemon/graph-host.js';
import type { GraphBindings } from '../src/graph/binding.js';
import { GraphBindingStore } from '../src/graph/binding-store.js';
import type { Project } from '../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type NodeDefinition,
  type NodeId,
  type PersistedField,
  type Value,
} from '../src/runtime/index.js';
import type { AttachmentDraft } from '../src/shared/content.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { HoneyStore, honeyPaths } from '../src/storage/honey.js';
import {
  FIXED_NOW,
  SAVE_ERROR,
  FakeClock,
  RecordingAdapter,
  FailingHoneyStore,
  makeEnv,
  text,
  forager,
  fastDefinition,
  allFresh,
  runnableForagerGraph,
  counterDefinition,
  promptsFor,
  workspaceListenerCount,
  collectKeys,
  runtimeOf,
  counterCount,
  userNode,
  userAndForagerDefinition,
} from './support/graph-host-persistence-fixtures.js';
import { triggerRun } from './support/graph-host-fixtures.js';

test('a corrupt or unsupported Honey field fails load before creating a session', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-corrupt-'));
  const storeFor = (graphId: string): HoneyStore =>
    HoneyStore.forComposition(root, 'apiary', graphId);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: storeFor,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const corrupt = storeFor('corrupt');
  mkdirSync(dirname(corrupt.paths.field), { recursive: true });
  writeFileSync(corrupt.paths.field, '{not valid json', 'utf8');

  const corruptDefinition = runnableForagerGraph('corrupt', 'corrupt {{input}}');
  await assert.rejects(
    host.loadGraph({
      definition: corruptDefinition,
      bindings: allFresh(corruptDefinition),
      project: env.project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GraphLoadError);
      assert.equal(error.graphId, 'corrupt');
      assert.match(error.message, /not valid JSON/);
      return true;
    },
  );
  assert.equal(host.statusOf('corrupt'), undefined);
  assert.deepEqual(env.adapter.createdNativeIds, []);
  assert.deepEqual(env.registry.list(), []);
  assert.equal(workspaceListenerCount(env.workspace), 0);

  const unsupported = storeFor('old-schema');
  mkdirSync(dirname(unsupported.paths.field), { recursive: true });
  writeFileSync(
    unsupported.paths.field,
    JSON.stringify({
      schemaVersion: 2,
      compositionId: 'old-schema',
      graphRevision: 'rev',
      rest: true,
      nodes: {},
    }),
    'utf8',
  );
  const oldDefinition = runnableForagerGraph('old-schema', 'old {{input}}');
  await assert.rejects(
    host.loadGraph({
      definition: oldDefinition,
      bindings: allFresh(oldDefinition),
      project: env.project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GraphLoadError);
      assert.equal(error.graphId, 'old-schema');
      assert.match(error.message, /schemaVersion/);
      return true;
    },
  );
  assert.equal(host.statusOf('old-schema'), undefined);
  assert.deepEqual(env.adapter.createdNativeIds, []);
  assert.deepEqual(env.registry.list(), []);
});

test('a revision mismatch fails restore, releases only the session it created and is not registered', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-revision-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'revision');
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const firstDefinition = runnableForagerGraph('revision', 'old {{input}}');
  await host.loadGraph({
    definition: firstDefinition,
    bindings: allFresh(firstDefinition),
    project: env.project,
  });
  const triggered = await triggerRun(host, 'revision', 'only', text('one'));
  assert.equal(triggered.persisted, true);
  assert.equal(await host.unload('revision'), true);
  // The first load's session is retained by the unload; the failed reload must
  // leave it alone.
  const retainedSessionIds = env.registry.list().map((record) => record.sessionId);
  assert.equal(retainedSessionIds.length, 1);

  const nextDefinition = runnableForagerGraph('revision', 'new {{input}}');
  assert.notEqual(nextDefinition.graphRevision, firstDefinition.graphRevision);
  const createdBefore = env.adapter.createdNativeIds.length;

  await assert.rejects(
    host.loadGraph({
      definition: nextDefinition,
      bindings: allFresh(nextDefinition),
      project: env.project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GraphLoadError);
      assert.equal(error.graphId, 'revision');
      assert.match(error.message, /graph revision/);
      return true;
    },
  );

  assert.equal(host.statusOf('revision'), undefined);
  assert.deepEqual(host.status(), []);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  assert.deepEqual(
    env.registry.list().map((record) => record.sessionId),
    retainedSessionIds,
  );
  // Only the fresh session created for the failed attempt was released again.
  assert.deepEqual(
    env.adapter.closedNativeIds,
    env.adapter.createdNativeIds.slice(createdBefore),
  );
  // The rejected load never overwrote the persisted field.
  assert.equal(honey.load()?.graphRevision, firstDefinition.graphRevision);
});

test('status exposes only recovery node ids, never a persisted body', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-recovery-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'recovery');
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('recovery', 'secret {{input}}');
  // A forager was mid-execution when the process stopped: restore must flag it
  // as unknown and never replay it.
  honey.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      only: {
        queue: [],
        active: {
          id: 'ph_live',
          traceId: 'tr_live',
          at: '2026-11-06T22:00:00.000Z',
          value: { kind: 'text', text: 'SECRET-BODY' },
        },
      },
    },
  });

  const status = await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  assert.deepEqual(status.recovery, {
    resumedHovers: [],
    unknownActive: ['only'],
    stuckActive: [],
  });
  assert.equal(status.rest, true);
  assert.equal(status.nodes.find((node) => node.nodeId === 'only')?.active, false);
  assert.deepEqual(host.status()[0]?.recovery, status.recovery);
  // No replay: the persisted active execution never reached a session.
  assert.deepEqual(env.adapter.allPrompts, []);
  assert.equal(env.adapter.createdNativeIds.length, 1);

  const serialized = JSON.stringify(status);
  for (const secret of ['SECRET-BODY', 'ph_live', 'tr_live']) {
    assert.equal(serialized.includes(secret), false, `status leaked '${secret}'`);
  }
  for (const key of collectKeys(status)) {
    assert.equal(
      ['prompt', 'output', 'token', 'hover', 'value', 'pheromones', 'pheromone'].includes(key),
      false,
      `status leaked key '${key}'`,
    );
  }
});

test('a failed restore closes created fresh_once sessions and removes their mappings', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m5b-rollback-once-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'rollback-once');
  const bindingStore = new GraphBindingStore(join(root, 'graph-bindings.json'), {
    now: () => FIXED_NOW,
  });
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
    bindingStore,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('rollback-once', 'go {{input}}');
  // The field is valid JSON but belongs to another revision, so instantiation
  // succeeds and restore fails afterwards. That is the rollback window.
  honey.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: 'stale-revision',
    rest: true,
    nodes: {},
  });

  await assert.rejects(
    host.loadGraph({
      definition,
      bindings: { only: { kind: 'fresh', mode: 'once' } },
      project: env.project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GraphLoadError);
      assert.equal(error.graphId, 'rollback-once');
      assert.match(error.message, /graph revision/);
      return true;
    },
  );

  assert.equal(host.statusOf('rollback-once'), undefined);
  assert.deepEqual(host.status(), []);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  // The session created for the failed load was closed and its mapping removed.
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1']);
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
  assert.deepEqual(env.registry.list(), []);
  assert.equal(bindingStore.get('rollback-once', 'only'), undefined);
  assert.deepEqual(bindingStore.snapshot(), []);
});

test('a failed reload never closes a reused fresh_once session or removes its mapping', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m5b-rollback-reused-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'keep-once');
  const bindingStore = new GraphBindingStore(join(root, 'graph-bindings.json'), {
    now: () => FIXED_NOW,
  });
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
    bindingStore,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('keep-once', 'go {{input}}');
  const bindings: GraphBindings = { only: { kind: 'fresh', mode: 'once' } };
  await host.loadGraph({ definition, bindings, project: env.project });
  const session = env.registry.list()[0];
  assert.ok(session !== undefined);
  const triggered = await triggerRun(host, 'keep-once', 'only', text('one'));
  assert.equal(triggered.rest, true);
  assert.equal(await host.unload('keep-once'), true);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.get(session.sessionId)?.sessionId, session.sessionId);
  assert.equal(bindingStore.get('keep-once', 'only')?.sessionId, session.sessionId);

  // Make the next restore fail after instantiation has reused the once session.
  honey.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: 'other-revision',
    rest: true,
    nodes: {},
  });

  await assert.rejects(
    host.loadGraph({ definition, bindings, project: env.project }),
    (error: unknown) => {
      assert.ok(error instanceof GraphLoadError);
      assert.match(error.message, /graph revision/);
      return true;
    },
  );

  assert.equal(host.statusOf('keep-once'), undefined);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  // No replacement session was created, and the reused one stayed open.
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1']);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.get(session.sessionId)?.sessionId, session.sessionId);
  assert.ok(env.workspace.getConversation(session.sessionId) !== undefined);
  assert.equal(bindingStore.get('keep-once', 'only')?.sessionId, session.sessionId);
});

test('a quiescent hover flushes to Honey, survives unload and is answered after reload', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m6b-hover-reload-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'hover-reload');
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
    allowHoverUnload: true,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = userAndForagerDefinition('hover-reload');
  const bindings = allFresh(definition);
  await host.loadGraph({ definition, bindings, project: env.project });
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1']);
  const triggered = await triggerRun(host, 'hover-reload', 'ask', text('waiting'));
  assert.equal(triggered.rest, false);
  assert.equal(triggered.hovered, true);
  assert.equal(triggered.persisted, true);

  // The hover-only unload flushes the parked hover before releasing routing.
  assert.equal(await host.unload('hover-reload'), true);
  assert.equal(host.statusOf('hover-reload'), undefined);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 1);
  const saved = honey.load();
  assert.ok(saved !== undefined);
  assert.equal(saved.rest, false);
  assert.equal(saved.nodes['ask']?.hover?.kind, 'user');
  assert.equal(typeof saved.nodes['ask']?.hover?.token, 'string');

  const reloaded = await host.loadGraph({ definition, bindings, project: env.project });
  assert.equal(reloaded.rest, false);
  assert.equal(reloaded.hovered, true);
  assert.deepEqual(reloaded.recovery?.resumedHovers, ['ask']);
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2']);
  assert.equal(env.registry.list().length, 2);

  const answered = await host.answer('hover-reload', 'ask', text('answered'));
  assert.equal(answered.rest, true);
  assert.equal(answered.hovered, false);
  assert.equal(answered.persisted, true);
  const after = honey.load();
  assert.ok(after !== undefined);
  assert.equal(after.rest, true);
  assert.equal(after.nodes['ask']?.hover, undefined);

  assert.equal(await host.unload('hover-reload'), true);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 2);
});

test('a failed Honey flush blocks a hover-only unload and keeps it loaded', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m6b-hover-flush-'));
  const honey = new FailingHoneyStore(honeyPaths(root, 'apiary', 'hover-flush'));
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
    allowHoverUnload: true,
  });
  t.after(async () => {
    honey.failSave = false;
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = fastDefinition('hover-flush', { ask: userNode() });
  await host.loadGraph({
    definition,
    bindings: {},
    project: env.project,
  });

  honey.failSave = true;
  const triggered = await triggerRun(host, 'hover-flush', 'ask', text('waiting'));
  assert.equal(triggered.hovered, true);
  assert.equal(triggered.persisted, false);
  assert.equal(triggered.persistError, SAVE_ERROR);

  assert.equal(await host.unload('hover-flush'), false);
  const retained = host.statusOf('hover-flush');
  assert.ok(retained !== undefined);
  assert.equal(retained.rest, false);
  assert.equal(retained.hovered, true);
  assert.equal(retained.residency.state, 'loaded');

  clock.advance(30 * 60_000);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.failed, [{ id: 'hover-flush', error: SAVE_ERROR }]);
  assert.notEqual(host.statusOf('hover-flush'), undefined);

  honey.failSave = false;
  assert.equal(await host.unload('hover-flush'), true);
  assert.equal(host.statusOf('hover-flush'), undefined);
  assert.equal(honey.load()?.nodes['ask']?.hover?.kind, 'user');
});
