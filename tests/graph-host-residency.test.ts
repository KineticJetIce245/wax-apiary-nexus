import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  LiveHiveHost,
  type LiveHiveHostOptions,
} from '../src/daemon/graph-host.js';
import { HoneyStore } from '../src/storage/honey.js';
import {
  FakeClock,
  RecordingAdapter,
  makeEnv,
  text,
  fastDefinition,
  allFresh,
  nodeStatus,
  workspaceListenerCount,
  runnableForagerGraph,
  triggerRun,
  waitUntil,
  userNode,
} from './support/graph-host-fixtures.js';

function honeyStore(id: string): HoneyStore {
  const root = mkdtempSync(join(tmpdir(), `wax-m19d-${id}-`));
  return HoneyStore.forComposition(root, 'apiary', id);
}

interface HoneyHarness {
  readonly env: ReturnType<typeof makeEnv>;
  readonly clock: FakeClock;
  readonly honey: HoneyStore;
  readonly host: LiveHiveHost;
}

/** A host with a real Honey snapshot and a fake clock, cleaned up after `t`. */
function honeyHost(
  t: TestContext,
  id: string,
  options: Partial<LiveHiveHostOptions> = {},
  adapter: RecordingAdapter = new RecordingAdapter(),
): HoneyHarness {
  const env = makeEnv(adapter);
  const clock = new FakeClock(1_000);
  const honey = honeyStore(id);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
    ...options,
  });
  t.after(async () => {
    adapter.releaseHeld();
    await host.dispose();
    await env.workspace.stop();
  });
  return { env, clock, honey, host };
}

test('idle unload snapshots a user hover; reload resumes and answers it', async (t) => {
  const { env, clock, honey, host } = honeyHost(t, 'hover-idle');
  const definition = fastDefinition('hover-idle', { ask: userNode() });
  await host.loadGraph({
    definition,
    bindings: {},
    project: env.project,
    idleTtlMs: 100,
  });

  const triggered = await triggerRun(host, 'hover-idle', 'ask', text('waiting'));
  assert.equal(triggered.hovered, true);
  assert.equal(workspaceListenerCount(env.workspace), 0);

  // A user hover no longer keeps the field loaded: after the idle TTL the
  // host snapshots it and releases the runtime. Only a pending Guard blocks.
  clock.advance(100);
  assert.deepEqual((await host.sweep()).unloaded, ['hover-idle']);
  assert.equal(host.statusOf('hover-idle'), undefined);
  const saved = honey.load();
  assert.ok(saved !== undefined);
  assert.equal(saved.rest, false);
  assert.equal(saved.nodes['ask']?.hover?.kind, 'user');
  assert.equal(typeof saved.nodes['ask']?.hover?.token, 'string');

  const reloaded = await host.loadGraph({
    definition,
    bindings: {},
    project: env.project,
    idleTtlMs: 100,
  });
  assert.equal(reloaded.rest, false);
  assert.equal(reloaded.hovered, true);
  assert.deepEqual(reloaded.recovery?.resumedHovers, ['ask']);

  await host.answer('hover-idle', 'ask', text('answered'));
  await waitUntil(
    () => host.statusOf('hover-idle')?.rest === true,
    'the answered field to settle',
  );
  const answered = host.statusOf('hover-idle');
  assert.ok(answered !== undefined);
  assert.equal(answered.hovered, false);
  assert.equal(nodeStatus(answered, 'ask').hovered, false);
});

test('a change resets the idle clock that the sweep uses', async (t) => {
  const { env, clock, host } = honeyHost(t, 'field-idle');
  const definition = runnableForagerGraph('field-idle', 'run {{message}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 100,
  });

  clock.advance(60);
  assert.equal((await triggerRun(host, 'field-idle', 'only', text('one'))).rest, true);
  // The field's own mutation time renews the idle deadline; a read does not.
  const changedAt = host.statusOf('field-idle')?.residency.lastAccessAt;
  assert.equal(changedAt, 1_060);
  clock.advance(60);
  host.status();
  assert.equal(host.statusOf('field-idle')?.residency.lastAccessAt, changedAt);

  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'field-idle', reason: 'not-expired' }]);

  clock.advance(40);
  assert.deepEqual((await host.sweep()).unloaded, ['field-idle']);
  assert.equal(host.statusOf('field-idle'), undefined);
});

interface DetachedActive {
  readonly harness: HoneyHarness;
  readonly sessionId: string;
  readonly saved: NonNullable<ReturnType<HoneyStore['load']>>;
}

/** Idle-unloads one active forager; returns the snapshot and retained session. */
async function detachActiveForager(t: TestContext, id: string): Promise<DetachedActive> {
  const harness = honeyHost(t, id, { maxWaitMs: 0 });
  harness.env.adapter.holdSubmissions = true;
  const definition = runnableForagerGraph(id, 'run {{message}}');
  await harness.host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: harness.env.project,
    idleTtlMs: 100,
  });
  const sessionId = harness.env.registry.list()[0]?.sessionId;
  assert.ok(sessionId !== undefined);
  await harness.host.trigger(id, 'only', text('hello'));
  await harness.env.adapter.waitForSubmit(1);
  await waitUntil(
    () =>
      harness.host
        .statusOf(id)
        ?.nodes.some((node) => node.nodeId === 'only' && node.active) === true,
    'the only bee to become active',
  );
  harness.clock.advance(100);
  assert.deepEqual((await harness.host.sweep()).unloaded, [id]);
  const saved = harness.honey.load();
  assert.ok(saved !== undefined);
  return { harness, sessionId, saved };
}

test('idle unload detaches an active native execution and snapshots it', async (t) => {
  const { harness, sessionId, saved } = await detachActiveForager(t, 'late-active');
  const { env, host } = harness;
  assert.equal(host.statusOf('late-active'), undefined);
  // The field was released but the in-flight execution keeps its executor and
  // session alive; no replacement session is created.
  assert.equal(workspaceListenerCount(env.workspace), 1);
  assert.equal(env.registry.get(sessionId)?.sessionId, sessionId);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(saved.rest, false);
  assert.equal(saved.nodes['only']?.active !== undefined, true);
});

test('the late native result reloads the field and completes the activation once', async (t) => {
  const { harness } = await detachActiveForager(t, 'late-result');
  const { env, host } = harness;
  env.adapter.releaseHeld();
  await waitUntil(
    () => host.statusOf('late-result')?.rest === true,
    'the late result to reload and complete the restored active',
  );
  const status = host.statusOf('late-result');
  assert.ok(status !== undefined);
  assert.equal(status.rest, true);
  assert.equal(status.nodes.find((node) => node.nodeId === 'only')?.active, false);
  // The Bee executed exactly once: the late result is the completion of the
  // same activation, never a replay.
  assert.deepEqual(env.adapter.allPrompts, ['run hello']);
  assert.deepEqual(
    host.outputsOf('late-result').get('only'),
    { message: 'reply(native-1):run hello' },
  );
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 1);
  assert.equal(workspaceListenerCount(env.workspace), 1);
  assert.equal(await host.unload('late-result'), true);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('a pending Guard blocks idle unload and explicit unload', async (t) => {
  const { env, clock, host } = honeyHost(
    t,
    'guard-idle',
    {
      guardTimeoutMs: 500,
      onGuard: () => new Promise(() => undefined),
      maxWaitMs: 0,
    },
    new RecordingAdapter({ askApproval: true }),
  );
  const definition = runnableForagerGraph('guard-idle', 'run {{message}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 100,
  });

  await host.trigger('guard-idle', 'only', text('approval'));
  await waitUntil(
    () => host.statusOf('guard-idle')?.nodes.some((node) => node.nodeId === 'only' && node.hovered) === true,
    'a pending guard hover',
  );

  clock.advance(100);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'guard-idle', reason: 'unsafe' }]);
  assert.equal(await host.unload('guard-idle'), false);
  assert.notEqual(host.statusOf('guard-idle'), undefined);

  // The guard times out by itself; a cancelled approval is never auto-allowed
  // and the field becomes idle again.
  await waitUntil(
    () => host.statusOf('guard-idle')?.rest === true,
    'the guard timeout to end the activation',
  );
  assert.equal(await host.unload('guard-idle'), true);
});

test('explicit unload snapshots immediately and detaches the active execution', async (t) => {
  const { env, honey, host } = honeyHost(t, 'immediate-unload');
  env.adapter.holdSubmissions = true;

  const definition = runnableForagerGraph('immediate-unload', 'run {{message}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  await host.trigger('immediate-unload', 'only', text('work'));
  await env.adapter.waitForSubmit(1);

  // The default maxWaitMs (30s) does not apply to unload: the active field is
  // snapshotted and detached immediately instead of waiting for the native turn.
  const startedAt = Date.now();
  assert.equal(await host.unload('immediate-unload'), true);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs < 1_000,
    `explicit unload waited ${String(elapsedMs)}ms for the active execution`,
  );
  assert.equal(host.statusOf('immediate-unload'), undefined);
  const saved = honey.load();
  assert.ok(saved !== undefined);
  assert.equal(saved.nodes['only']?.active !== undefined, true);

  // The detached activation still completes later and reloads the same field.
  env.adapter.releaseHeld();
  await waitUntil(
    () => host.statusOf('immediate-unload')?.rest === true,
    'the late result to finish the reloaded field',
  );
  assert.deepEqual(
    host.outputsOf('immediate-unload').get('only'),
    { message: 'reply(native-1):run work' },
  );
});

test('load starts each restored receptor drain by itself', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const honey = honeyStore('restored-drain');
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('restored-drain', 'run {{message}}');
  const saved = {
    schemaVersion: 2 as const,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      only: {
        receptor: [
          { value: { message: 'queued' }, enqueuedAt: new Date(1_000).toISOString() },
        ],
      },
    },
  };
  honey.save(saved);

  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  await waitUntil(
    () => host.statusOf('restored-drain')?.rest === true,
    'the restored receptor to drain without a host driver',
  );
  assert.deepEqual(env.adapter.allPrompts, ['run queued']);
});

test('a dispatch graph is released when its field reaches Rest', async (t) => {
  const env = makeEnv();
  const host = new LiveHiveHost({
    registry: env.registry,
    now: () => 1_000,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = fastDefinition('ephemeral', {
    only: { kind: 'forager', config: { connection: 'fake', prompt: '{{message}}' } },
  });
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 0,
    ephemeral: true,
  });
  assert.equal(host.status().length, 0);
  await host.trigger('ephemeral', 'only', text('go'));
  await waitUntil(
    () => host.statusOf('ephemeral') === undefined,
    'the ephemeral graph to be released at Rest',
  );
});
