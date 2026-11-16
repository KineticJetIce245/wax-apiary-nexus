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

test('trigger flushes the field to Honey and reports persisted', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-flush-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'flush');
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('flush', 'run {{input}}');
  const loaded = await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  // With Honey the default idle TTL is 30 minutes, not 0.
  assert.equal(loaded.residency.idleTtlMs, 30 * 60_000);
  assert.equal(loaded.residency.nextEvictionAt, 1_000 + 30 * 60_000);
  assert.equal(Object.hasOwn(loaded, 'recovery'), false);

  const result = await host.trigger('flush', 'only', text('one'));
  assert.equal(result.rest, true);
  assert.equal(result.persisted, true);
  assert.equal(Object.hasOwn(result, 'persistError'), false);
  assert.equal(result.status.rest, true);

  const saved = honey.load();
  assert.ok(saved !== undefined);
  assert.equal(saved.rest, true);
  assert.deepEqual(saved, runtimeOf(host, 'flush').exportField());
  assert.deepEqual(env.adapter.allPrompts, ['run one']);
});

test('unload and reload restore the field and continue the counter', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-reload-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'counter');
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = counterDefinition('counter');
  const bindings = allFresh(definition);
  await host.loadGraph({ definition, bindings, project: env.project });
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2', 'native-3']);

  const firstTrigger = await host.trigger('counter', 'start', text('first'));
  assert.equal(firstTrigger.rest, true);
  assert.equal(firstTrigger.persisted, true);
  assert.equal(counterCount(honey.load()), 1);
  const firstSessionIds = env.registry.list().map((record) => record.sessionId);
  assert.equal(workspaceListenerCount(env.workspace), 3);

  assert.equal(await host.unload('counter'), true);
  assert.equal(host.statusOf('counter'), undefined);
  // Unload releases routing only; the three fresh sessions are retained.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 3);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  assert.equal(counterCount(honey.load()), 1);

  const reloaded = await host.loadGraph({ definition, bindings, project: env.project });
  assert.equal(reloaded.rest, true);
  assert.deepEqual(reloaded.recovery, {
    resumedHovers: [],
    unknownActive: [],
    stuckActive: [],
  });
  assert.deepEqual(env.adapter.createdNativeIds, [
    'native-1',
    'native-2',
    'native-3',
    'native-4',
    'native-5',
    'native-6',
  ]);
  const secondSessionIds = env.registry.list().map((record) => record.sessionId);
  // The three retained sessions from the first load are still registered; the
  // reload added three replacements.
  assert.equal(secondSessionIds.length, 6);
  assert.equal(workspaceListenerCount(env.workspace), 3);
  for (const sessionId of firstSessionIds) {
    assert.equal(secondSessionIds.includes(sessionId), true);
  }
  // The restored field carries the counter state; a fresh runtime was not used.
  assert.equal(counterCount(runtimeOf(host, 'counter').exportField()), 1);

  const secondTrigger = await host.trigger('counter', 'start', text('second'));
  assert.equal(secondTrigger.rest, true);
  assert.equal(secondTrigger.persisted, true);
  assert.equal(counterCount(honey.load()), 2);

  // start runs on the first reloaded fresh session; the counter goes straight
  // to done, so the `again` session sees no prompt and `done` runs.
  assert.deepEqual(promptsFor(env.adapter, 'native-4'), ['start second']);
  assert.equal(env.adapter.promptsByNative.has('native-5'), false);
  assert.deepEqual(promptsFor(env.adapter, 'native-6'), [
    'done reply(native-4):start second',
  ]);
});

test('unload retains fresh sessions and reload creates replacements', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-fresh-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'fresh');
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('fresh', 'go {{input}}');
  const bindings = allFresh(definition);
  await host.loadGraph({ definition, bindings, project: env.project });
  const first = env.registry.list()[0];
  assert.ok(first !== undefined);
  assert.equal(workspaceListenerCount(env.workspace), 1);

  const result = await host.trigger('fresh', 'only', text('go'));
  assert.equal(result.rest, true);
  assert.equal(await host.unload('fresh'), true);
  // The first session is retained; the graph no longer routes to it.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.deepEqual(
    env.registry.list().map((record) => record.sessionId),
    [first.sessionId],
  );
  assert.equal(workspaceListenerCount(env.workspace), 0);

  await host.loadGraph({ definition, bindings, project: env.project });
  const sessionIds = env.registry.list().map((record) => record.sessionId);
  assert.equal(sessionIds.length, 2);
  assert.ok(sessionIds.includes(first.sessionId));
  const replacementId = sessionIds.find((id) => id !== first.sessionId);
  assert.ok(replacementId !== undefined);
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2']);
  assert.equal(workspaceListenerCount(env.workspace), 1);
  assert.equal(host.statusOf('fresh')?.rest, true);
  assert.ok(honey.load() !== undefined);
});

test('a failed flush blocks unload and keeps sessions and routing open', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-block-'));
  const honey = new FailingHoneyStore(honeyPaths(root, 'apiary', 'blocked'));
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    honey.failSave = false;
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('blocked', 'keep {{input}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  const sessionId = env.registry.list()[0]?.sessionId;
  assert.ok(sessionId !== undefined);
  const triggered = await host.trigger('blocked', 'only', text('keep'));
  assert.equal(triggered.persisted, true);
  assert.equal(workspaceListenerCount(env.workspace), 1);

  honey.failSave = true;
  assert.equal(await host.unload('blocked'), false);
  const retained = host.statusOf('blocked');
  assert.ok(retained !== undefined);
  assert.equal(retained.rest, true);
  assert.equal(retained.residency.state, 'loaded');
  assert.equal(retained.residency.refCount, 0);
  assert.equal(env.registry.get(sessionId)?.sessionId, sessionId);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(workspaceListenerCount(env.workspace), 1);

  // A TTL sweep hits the same flush failure: it reports the graph as failed
  // and keeps it loaded instead of forgetting it.
  clock.advance(30 * 60_000);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.failed, [{ id: 'blocked', error: SAVE_ERROR }]);
  assert.notEqual(host.statusOf('blocked'), undefined);
  assert.equal(env.registry.get(sessionId)?.sessionId, sessionId);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(workspaceListenerCount(env.workspace), 1);

  honey.failSave = false;
  assert.equal(await host.unload('blocked'), true);
  assert.equal(host.statusOf('blocked'), undefined);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 1);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('a failed trigger flush is reported without replaying the trigger', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-trigger-fail-'));
  const honey = new FailingHoneyStore(honeyPaths(root, 'apiary', 'trigger-fail'));
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    honey.failSave = false;
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('trigger-fail', 'run {{input}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const first = await host.trigger('trigger-fail', 'only', text('one'));
  assert.equal(first.persisted, true);
  const firstSaved = honey.load();
  assert.equal(
    firstSaved?.nodes['only']?.lastActivatedAt,
    new Date(1_000).toISOString(),
  );

  clock.advance(1_000);
  honey.failSave = true;
  const failed = await host.trigger('trigger-fail', 'only', text('two'));
  assert.equal(failed.rest, true);
  assert.equal(failed.persisted, false);
  assert.equal(failed.persistError, SAVE_ERROR);
  assert.equal(Object.hasOwn(failed, 'persistError'), true);
  assert.equal(failed.persistError?.includes('two'), false);
  assert.equal(failed.status.rest, true);
  assert.equal(failed.status.residency.state, 'loaded');
  // The trigger ran exactly once and was not replayed after the save failure.
  assert.deepEqual(env.adapter.allPrompts, ['run one', 'run two']);
  assert.equal(host.statusOf('trigger-fail')?.rest, true);
  // The failed save never rewrote the previous field.
  assert.equal(
    honey.load()?.nodes['only']?.lastActivatedAt,
    new Date(1_000).toISOString(),
  );

  honey.failSave = false;
  clock.advance(100);
  const third = await host.trigger('trigger-fail', 'only', text('three'));
  assert.equal(third.persisted, true);
  assert.equal(Object.hasOwn(third, 'persistError'), false);
  assert.deepEqual(env.adapter.allPrompts, ['run one', 'run two', 'run three']);
  assert.equal(
    honey.load()?.nodes['only']?.lastActivatedAt,
    new Date(2_100).toISOString(),
  );
});

test('idle TTL defaults to 0 without Honey and 30 minutes with it', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-ttl-'));
  const storeFor = (graphId: string): HoneyStore =>
    HoneyStore.forComposition(root, 'apiary', graphId);
  const honeyHost = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: storeFor,
  });
  const plainHost = new GraphHost({
    registry: env.registry,
    now: clock.now,
  });
  const overrideHoney = HoneyStore.forComposition(root, 'apiary', 'override-ttl');
  const overrideHost = new GraphHost({
    registry: env.registry,
    now: clock.now,
    defaultIdleTtlMs: 500,
    honeyForGraph: () => overrideHoney,
  });
  t.after(async () => {
    await plainHost.dispose();
    await honeyHost.dispose();
    await overrideHost.dispose();
    await env.workspace.stop();
  });

  // No Honey: TTL 0 disables automatic eviction, matching M4a.
  const plainDefinition = runnableForagerGraph('plain-ttl', 'plain {{input}}');
  await plainHost.loadGraph({
    definition: plainDefinition,
    bindings: allFresh(plainDefinition),
    project: env.project,
  });
  const plain = plainHost.statusOf('plain-ttl');
  assert.ok(plain !== undefined);
  assert.equal(plain.residency.idleTtlMs, 0);
  assert.equal(Object.hasOwn(plain.residency, 'nextEvictionAt'), false);
  clock.advance(24 * 60 * 60_000);
  let report = await plainHost.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'plain-ttl', reason: 'disabled' }]);
  assert.notEqual(plainHost.statusOf('plain-ttl'), undefined);

  // Honey: default 30 minutes from the last access.
  const defaultDefinition = runnableForagerGraph('default-ttl', 'default {{input}}');
  const loadedAt = clock.time;
  await honeyHost.loadGraph({
    definition: defaultDefinition,
    bindings: allFresh(defaultDefinition),
    project: env.project,
  });
  const withHoney = honeyHost.statusOf('default-ttl');
  assert.ok(withHoney !== undefined);
  assert.equal(withHoney.residency.idleTtlMs, 30 * 60_000);
  assert.equal(withHoney.residency.lastAccessAt, loadedAt);
  assert.equal(withHoney.residency.nextEvictionAt, loadedAt + 30 * 60_000);

  clock.advance(30 * 60_000 - 1);
  report = await honeyHost.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'default-ttl', reason: 'not-expired' }]);

  clock.advance(1);
  report = await honeyHost.sweep();
  assert.deepEqual(report.unloaded, ['default-ttl']);
  assert.equal(honeyHost.statusOf('default-ttl'), undefined);

  // A per-load TTL still overrides the Honey default.
  const shortDefinition = runnableForagerGraph('short-ttl', 'short {{input}}');
  await honeyHost.loadGraph({
    definition: shortDefinition,
    bindings: allFresh(shortDefinition),
    project: env.project,
    idleTtlMs: 100,
  });
  assert.equal(honeyHost.statusOf('short-ttl')?.residency.idleTtlMs, 100);
  clock.advance(100);
  report = await honeyHost.sweep();
  assert.deepEqual(report.unloaded, ['short-ttl']);

  // An explicit defaultIdleTtlMs still overrides the 30-minute Honey default.
  const overrideDefinition = runnableForagerGraph('override-ttl', 'override {{input}}');
  await overrideHost.loadGraph({
    definition: overrideDefinition,
    bindings: allFresh(overrideDefinition),
    project: env.project,
  });
  assert.equal(overrideHost.statusOf('override-ttl')?.residency.idleTtlMs, 500);
  clock.advance(500);
  report = await overrideHost.sweep();
  assert.deepEqual(report.unloaded, ['override-ttl']);
});

test('an idle sweep flushes, unloads and reloads the field', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-sweep-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'sweep-counter');
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    honeyForGraph: () => honey,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = counterDefinition('sweep-counter');
  const bindings = allFresh(definition);
  await host.loadGraph({
    definition,
    bindings,
    project: env.project,
    idleTtlMs: 100,
  });
  const triggered = await host.trigger('sweep-counter', 'start', text('seed'));
  assert.equal(triggered.rest, true);
  assert.equal(triggered.persisted, true);
  assert.equal(counterCount(honey.load()), 1);

  clock.advance(100);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, ['sweep-counter']);
  assert.deepEqual(report.failed, []);
  assert.equal(host.statusOf('sweep-counter'), undefined);
  // A sweep releases the graph but retains every session it created.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 3);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  // Sweep flushed before releasing: the counter state is durable.
  assert.equal(counterCount(honey.load()), 1);

  const reloaded = await host.loadGraph({
    definition,
    bindings,
    project: env.project,
    idleTtlMs: 100,
  });
  assert.equal(reloaded.rest, true);
  assert.deepEqual(reloaded.recovery, {
    resumedHovers: [],
    unknownActive: [],
    stuckActive: [],
  });
  assert.equal(counterCount(runtimeOf(host, 'sweep-counter').exportField()), 1);

  const again = await host.trigger('sweep-counter', 'start', text('again'));
  assert.equal(again.rest, true);
  assert.equal(again.persisted, true);
  assert.equal(counterCount(honey.load()), 2);
});
