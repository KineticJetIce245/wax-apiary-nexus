import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import {
  GraphAnswerError,
  GraphHost,
  GraphHostDisposedError,
  GraphLoadError,
  GraphNotFoundError,
  type GraphHostEvent,
  type GraphNodeStatus,
  type GraphStatus,
} from '../src/daemon/graph-host.js';
import type { GraphBindings } from '../src/graph/binding.js';
import { GraphBindingStore } from '../src/graph/binding-store.js';
import type { Project } from '../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type GuardDecision,
  type GuardRequest,
  type NodeDefinition,
  type NodeId,
  type PersistedField,
  type PheromoneFieldSnapshot,
  type Value,
} from '../src/runtime/index.js';
import type { AttachmentDraft } from '../src/shared/content.js';
import {
  BindingValidationError,
} from '../src/session/instantiate-foragers.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import {
  FIXED_NOW,
  FakeClock,
  RecordingAdapter,
  deferred,
  makeEnv,
  text,
  forager,
  fastDefinition,
  allFresh,
  promptsFor,
  nodeStatus,
  workspaceListenerCount,
  runtimeOf,
  hoverTokenOf,
  isAnswerError,
  userNode,
  userAndForagerGraph,
  runnableForagerGraph,
  pacedForkMergeDefinition,
} from './support/graph-host-fixtures.js';

class FailingCloseAdapter extends RecordingAdapter {
  failClose = false;

  override async closeConversation(nativeId: string): Promise<void> {
    await super.closeConversation(nativeId);
    if (this.failClose) {
      throw new Error(`close failed for ${nativeId}`);
    }
  }
}

/**
 * A create that can be parked, so a dispose can race an in-flight load and
 * force the load-rollback path. Close failures are driven by `failClose`.
 */
class GatedCloseFailureAdapter extends FailingCloseAdapter {
  private readonly created = deferred();
  private readonly gate = deferred();
  readonly createStarted = this.created.promise;

  override async createConversation(project: Project): Promise<string> {
    this.created.resolve();
    await this.gate.promise;
    return super.createConversation(project);
  }

  release(): void {
    this.gate.resolve();
  }
}

function makeBindingStore(): GraphBindingStore {
  return new GraphBindingStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m5b-host-bindings-')), 'graph-bindings.json'),
    { now: () => FIXED_NOW },
  );
}

test('duplicate load, invalid bindings and an unknown graph are rejected explicitly', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('reject');
  const bindings = allFresh(definition);
  await host.loadGraph({ definition, bindings, project: env.project });
  const createdBefore = env.adapter.createdNativeIds.length;
  assert.equal(createdBefore, 1);

  await assert.rejects(
    host.loadGraph({ definition, bindings, project: env.project }),
    (error: unknown) => {
      assert.ok(error instanceof GraphLoadError);
      assert.equal(error.graphId, 'reject');
      assert.match(error.message, /already loaded/);
      return true;
    },
  );
  assert.equal(env.adapter.createdNativeIds.length, createdBefore);
  assert.equal(env.registry.list().length, 1);

  const invalid = fastDefinition('invalid', {
    one: forager('one'),
    two: forager('two'),
  });
  const invalidBindings: GraphBindings = { one: { kind: 'fresh' } };
  await assert.rejects(
    host.loadGraph({ definition: invalid, bindings: invalidBindings, project: env.project }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['missing-binding'],
      );
      return true;
    },
  );
  assert.equal(host.statusOf('invalid'), undefined);
  assert.equal(env.adapter.createdNativeIds.length, createdBefore);
  assert.equal(env.registry.list().length, 1);

  await assert.rejects(
    host.trigger('missing', 'only', text('x')),
    (error: unknown) => {
      assert.ok(error instanceof GraphNotFoundError);
      assert.equal(error.graphId, 'missing');
      return true;
    },
  );
});

test('unload retains fresh and borrowed sessions and disposes routing', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const borrowed = await env.registry.create(env.project, {
    displayName: 'borrowed-session',
  });
  const definition = fastDefinition('mixed', {
    fresh: forager('fresh {{input}}'),
    reuse: forager('reuse {{input}}'),
  });
  const bindings: GraphBindings = {
    fresh: { kind: 'fresh' },
    reuse: { kind: 'session', sessionId: borrowed.sessionId },
  };

  await host.loadGraph({ definition, bindings, project: env.project });
  // The borrowed session is native-1; the graph's fresh session is native-2.
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2']);
  assert.equal(workspaceListenerCount(env.workspace), 2);

  const reused = await host.trigger('mixed', 'reuse', text('keep'));
  assert.equal(reused.rest, true);
  const fresh = await host.trigger('mixed', 'fresh', text('close'));
  assert.equal(fresh.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-1'), ['reuse keep']);
  assert.deepEqual(promptsFor(env.adapter, 'native-2'), ['fresh close']);

  assert.equal(await host.unload('mixed'), true);
  assert.equal(host.statusOf('mixed'), undefined);
  // Sessions are decoupled from graphs: the created fresh session and the
  // borrowed one both survive, while every executor subscription is gone.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 2);
  assert.equal(env.registry.get(borrowed.sessionId)?.sessionId, borrowed.sessionId);
  assert.ok(env.workspace.getConversation(borrowed.sessionId) !== undefined);
  assert.equal(workspaceListenerCount(env.workspace), 0);

  const promptsBefore = env.adapter.allPrompts.length;
  await assert.rejects(
    host.trigger('mixed', 'reuse', text('after')),
    GraphNotFoundError,
  );
  assert.equal(env.adapter.allPrompts.length, promptsBefore);
});

test('a failed close during load rollback is reported and the load is not registered', async (t) => {
  const adapter = new GatedCloseFailureAdapter();
  adapter.failClose = true;
  const env = makeEnv(adapter);
  const events: GraphHostEvent[] = [];
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    adapter.release();
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('rollback-close', 'rollback {{input}}');
  const load = host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  await adapter.createStarted;
  // Dispose while instantiation is in flight: the load must not become visible,
  // and the session it created must be rolled back.
  const disposal = host.dispose();
  adapter.release();
  await assert.rejects(load, GraphHostDisposedError);
  await disposal;

  assert.equal(host.statusOf('rollback-close'), undefined);
  const sessionId = env.registry.list()[0]?.sessionId;
  assert.ok(sessionId !== undefined);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  assert.deepEqual(events, [
    {
      type: 'graph.cleanup-failed',
      graphId: 'rollback-close',
      phase: 'session',
      sessionId,
      error: 'close failed for native-1',
    },
  ]);
  // The close failed, so the record survives: rollback does not pretend it
  // succeeded, and no graph is loaded that would hide the session.
  assert.ok(env.registry.get(sessionId) !== undefined);
});

test('idle sweep follows TTL, and a trigger renews the deadline', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const idle = runnableForagerGraph('idle', 'idle {{input}}');
  await host.loadGraph({
    definition: idle,
    bindings: allFresh(idle),
    project: env.project,
    idleTtlMs: 100,
  });
  const loaded = host.statusOf('idle');
  assert.ok(loaded !== undefined);
  assert.equal(loaded.residency.idleTtlMs, 100);
  assert.equal(loaded.residency.nextEvictionAt, 1_100);

  clock.advance(99);
  let report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'idle', reason: 'not-expired' }]);

  clock.advance(1);
  report = await host.sweep();
  assert.deepEqual(report.unloaded, ['idle']);
  assert.equal(host.statusOf('idle'), undefined);
  // A TTL sweep is a normal release: the session is retained.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 1);

  const renew = runnableForagerGraph('renew', 'renew {{input}}');
  await host.loadGraph({
    definition: renew,
    bindings: allFresh(renew),
    project: env.project,
    idleTtlMs: 100,
  });
  const first = await host.trigger('renew', 'only', text('one'));
  assert.equal(first.rest, true);
  assert.equal(first.status.residency.lastAccessAt, 1_100);

  clock.advance(60);
  const second = await host.trigger('renew', 'only', text('two'));
  assert.equal(second.rest, true);
  assert.equal(second.status.residency.lastAccessAt, 1_160);

  clock.advance(60); // 1220: only 60ms since the renewed access
  report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'renew', reason: 'not-expired' }]);

  clock.advance(40); // 1260: exactly the renewed deadline
  report = await host.sweep();
  assert.deepEqual(report.unloaded, ['renew']);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 2);
});

test('a busy graph is neither unloaded nor swept while its trigger is in flight', async (t) => {
  const env = makeEnv();
  env.adapter.holdSubmissions = true;
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    env.adapter.releaseHeld();
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('busy', 'hold {{input}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 100,
  });

  const run = host.trigger('busy', 'only', text('hold'));
  await env.adapter.waitForSubmit(1);

  // The lease must span the whole trigger, not just the initial enqueue.
  clock.advance(1_000);
  assert.equal(await host.unload('busy'), false);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.skipped, [{ id: 'busy', reason: 'busy' }]);

  const busy = host.statusOf('busy');
  assert.ok(busy !== undefined);
  assert.equal(busy.rest, false);
  assert.equal(busy.residency.refCount, 1);
  assert.equal(nodeStatus(busy, 'only').active, true);
  assert.deepEqual(env.adapter.closedNativeIds, []);

  env.adapter.releaseHeld();
  const result = await run;
  assert.equal(result.rest, true);
  assert.equal(result.status.residency.refCount, 0);
  assert.equal(host.statusOf('busy')?.rest, true);

  // Once the active execution settles, the graph is Rest and unload succeeds.
  assert.equal(await host.unload('busy'), true);
  assert.equal(host.statusOf('busy'), undefined);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 1);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('a non-Rest field refuses unload, sweep and best-effort dispose', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    maxPumps: 1,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = pacedForkMergeDefinition('queued');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 100,
  });
  assert.equal(env.adapter.createdNativeIds.length, 3);
  assert.equal(workspaceListenerCount(env.workspace), 3);

  const result = await host.trigger('queued', 'start', text('seed'));
  assert.equal(result.rest, false);
  assert.equal(result.pumps, 1);
  const loaded = host.statusOf('queued');
  assert.ok(loaded !== undefined);
  assert.equal(loaded.rest, false);
  assert.equal(nodeStatus(loaded, 'merge').pending, true);
  assert.equal(nodeStatus(loaded, 'merge').joins, 1);

  clock.advance(1_000);
  assert.equal(await host.unload('queued'), false);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'queued', reason: 'unsafe' }]);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 3);
  assert.equal(workspaceListenerCount(env.workspace), 3);

  const retained = host.statusOf('queued');
  assert.ok(retained !== undefined);
  assert.equal(retained.rest, false);
  assert.equal(retained.residency.refCount, 0);
  assert.equal(nodeStatus(retained, 'merge').pending, true);
  assert.equal(nodeStatus(retained, 'merge').joins, 1);

  // dispose is best-effort: it must not bypass Rest-only safety. The non-Rest
  // graph is still visible to the caller, with its field and sessions intact.
  await host.dispose();
  assert.equal(host.statusOf('queued') !== undefined, true);
  assert.equal(host.status().length, 1);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 3);
  assert.equal(workspaceListenerCount(env.workspace), 3);
});

test('dispose unloads every Rest graph, is idempotent and refuses later work', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const graphA = runnableForagerGraph('graph-a', 'A {{input}}');
  const graphB = runnableForagerGraph('graph-b', 'B {{input}}');
  await host.loadGraph({ definition: graphA, bindings: allFresh(graphA), project: env.project });
  await host.loadGraph({ definition: graphB, bindings: allFresh(graphB), project: env.project });

  const result = await host.trigger('graph-a', 'only', text('one'));
  assert.equal(result.rest, true);
  assert.equal(workspaceListenerCount(env.workspace), 2);

  await host.dispose();
  assert.deepEqual(host.status(), []);
  assert.equal(host.statusOf('graph-a'), undefined);
  // dispose unloads both graphs but closes neither session.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  assert.equal(env.registry.list().length, 2);
  for (const record of env.registry.list()) {
    assert.ok(env.workspace.getConversation(record.sessionId) !== undefined);
  }

  await host.dispose();
  assert.deepEqual(env.adapter.closedNativeIds, []);

  await assert.rejects(
    host.trigger('graph-a', 'only', text('after')),
    GraphHostDisposedError,
  );
  await assert.rejects(
    host.loadGraph({ definition: graphA, bindings: allFresh(graphA), project: env.project }),
    GraphHostDisposedError,
  );

  // dispose must not stop the Workspace; the caller still owns it.
  const survivor = await env.registry.create(env.project);
  const execution = await env.workspace.submit(survivor.sessionId, 'alive');
  assert.equal(execution.state, 'completed');
  assert.equal(env.adapter.allPrompts.at(-1), 'alive');
});

test('fresh_once keeps its session and mapping across unload and reuses it on reload', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const bindingStore = makeBindingStore();
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    bindingStore,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('once', 'run {{input}}');
  const bindings: GraphBindings = { only: { kind: 'fresh', mode: 'once' } };
  await host.loadGraph({ definition, bindings, project: env.project });
  const session = env.registry.list()[0];
  assert.ok(session !== undefined);
  assert.equal(bindingStore.get('once', 'only')?.sessionId, session.sessionId);

  const first = await host.trigger('once', 'only', text('one'));
  assert.equal(first.rest, true);
  assert.equal(await host.unload('once'), true);
  assert.equal(host.statusOf('once'), undefined);

  // A normal unload retains both the WAX session and the resolved mapping.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.get(session.sessionId)?.sessionId, session.sessionId);
  assert.ok(env.workspace.getConversation(session.sessionId) !== undefined);
  assert.equal(bindingStore.get('once', 'only')?.sessionId, session.sessionId);
  assert.equal(workspaceListenerCount(env.workspace), 0);

  await host.loadGraph({ definition, bindings, project: env.project });
  // Reload reused the existing session: no native conversation was created.
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1']);
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.registry.list()[0]?.sessionId, session.sessionId);
  assert.equal(workspaceListenerCount(env.workspace), 1);

  const second = await host.trigger('once', 'only', text('two'));
  assert.equal(second.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-1'), ['run one', 'run two']);

  // dispose follows the same retention rule: a fresh_once session is not closed.
  await host.dispose();
  assert.deepEqual(host.status(), []);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.get(session.sessionId)?.sessionId, session.sessionId);
  assert.equal(bindingStore.get('once', 'only')?.sessionId, session.sessionId);
});

test('fresh_always is retained on unload and a reload creates a new session', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const bindingStore = makeBindingStore();
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    bindingStore,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('always', 'run {{input}}');
  const bindings: GraphBindings = { only: { kind: 'fresh', mode: 'always' } };
  await host.loadGraph({ definition, bindings, project: env.project });
  const first = env.registry.list()[0];
  assert.ok(first !== undefined);
  assert.equal(await host.unload('always'), true);

  // fresh_always is no longer graph-owned: the session outlives the graph.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.deepEqual(
    env.registry.list().map((record) => record.sessionId),
    [first.sessionId],
  );
  assert.equal(env.registry.get(first.sessionId)?.sessionId, first.sessionId);
  assert.deepEqual(bindingStore.snapshot(), []);

  await host.loadGraph({ definition, bindings, project: env.project });
  const sessionIds = env.registry.list().map((record) => record.sessionId);
  assert.equal(sessionIds.length, 2);
  assert.ok(sessionIds.includes(first.sessionId));
  const secondSessionId = sessionIds.find((id) => id !== first.sessionId);
  assert.ok(secondSessionId !== undefined);
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2']);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.deepEqual(bindingStore.snapshot(), []);

  const result = await host.trigger('always', 'only', text('go'));
  assert.equal(result.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-2'), ['run go']);
});

test('an idle sweep retains a fresh_once session and the reload still reuses it', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const bindingStore = makeBindingStore();
  const host = new GraphHost({
    registry: env.registry,
    now: clock.now,
    bindingStore,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('once-sweep', 'run {{input}}');
  const bindings: GraphBindings = { only: { kind: 'fresh', mode: 'once' } };
  await host.loadGraph({
    definition,
    bindings,
    project: env.project,
    idleTtlMs: 100,
  });
  const session = env.registry.list()[0];
  assert.ok(session !== undefined);
  const triggered = await host.trigger('once-sweep', 'only', text('one'));
  assert.equal(triggered.rest, true);

  clock.advance(100);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, ['once-sweep']);
  assert.equal(host.statusOf('once-sweep'), undefined);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.get(session.sessionId)?.sessionId, session.sessionId);
  assert.equal(bindingStore.get('once-sweep', 'only')?.sessionId, session.sessionId);

  await host.loadGraph({ definition, bindings, project: env.project });
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1']);
  assert.equal(env.registry.list()[0]?.sessionId, session.sessionId);
  const second = await host.trigger('once-sweep', 'only', text('two'));
  assert.equal(second.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-1'), ['run one', 'run two']);
});
