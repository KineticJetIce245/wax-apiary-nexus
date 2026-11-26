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
  LiveHiveHostAnswerError,
  LiveHiveHost,
  LiveHiveHostDisposedError,
  LiveHiveHostLoadError,
  LiveHiveHostNotFoundError,
  type LiveHiveHostEvent,
  type LiveHiveNodeStatus,
  type LiveHiveStatus,
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
  triggerRun,
} from './support/graph-host-fixtures.js';


test('loadedSessionIds reports only sessions bound to currently loaded graphs', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
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
  const stranger = await env.registry.create(env.project, {
    displayName: 'unbound-session',
  });
  const definition = fastDefinition('ids', {
    fresh: forager('fresh {{input}}'),
    reuse: forager('reuse {{input}}'),
  });
  const bindings: GraphBindings = {
    fresh: { kind: 'fresh' },
    reuse: { kind: 'session', sessionId: borrowed.sessionId },
  };
  await host.loadGraph({ definition, bindings, project: env.project });

  const freshSession = env.registry
    .list()
    .find(
      (record) =>
        record.sessionId !== borrowed.sessionId && record.sessionId !== stranger.sessionId,
    );
  assert.ok(freshSession !== undefined);
  assert.deepEqual(
    [...host.loadedSessionIds()].sort(),
    [borrowed.sessionId, freshSession.sessionId].sort(),
  );
  assert.equal(host.loadedSessionIds().has(stranger.sessionId), false);

  assert.equal(await host.unload('ids'), true);
  assert.equal(host.loadedSessionIds().size, 0);
  // All three sessions are still registered after the graph is unloaded.
  assert.equal(env.registry.list().length, 3);
});

test('status and statusOf are pure reads and M4a defaults idle TTL to 0', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  assert.deepEqual(host.status(), []);
  assert.equal(host.statusOf('missing'), undefined);
  assert.equal(env.adapter.createdNativeIds.length, 0);

  const definition = runnableForagerGraph('graph');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  const initial = host.statusOf('graph');
  assert.ok(initial !== undefined);
  assert.equal(initial.residency.idleTtlMs, 0);
  assert.equal(initial.residency.lastAccessAt, 1_000);
  assert.equal(initial.residency.refCount, 0);
  assert.equal(Object.hasOwn(initial.residency, 'nextEvictionAt'), false);

  clock.advance(10_000);
  const listed = host.status();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.residency.lastAccessAt, 1_000);
  assert.equal(host.statusOf('graph')?.residency.lastAccessAt, 1_000);
  assert.equal(host.statusOf('graph')?.residency.refCount, 0);

  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'graph', reason: 'disabled' }]);
  assert.equal(host.statusOf('graph') !== undefined, true);
});

test('outputsOf snapshots one graph without touching residency or taking a lease', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = fastDefinition('output-graph', {
    zeta: forager('zeta {{input}}'),
    alpha: forager('alpha {{input}}'),
  });
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 10_000,
  });

  // A loaded graph with no completed execution yet has an empty snapshot.
  assert.deepEqual([...host.outputsOf('output-graph')], []);

  const triggered = await triggerRun(host, 'output-graph', 'zeta', text('z'));
  assert.equal(triggered.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-1'), ['zeta z']);
  assert.equal(env.adapter.promptsByNative.has('native-2'), false);

  // Spy on the internal registry: outputsOf must call neither acquire nor
  // touch. Only a peek-based read leaves both counters at zero.
  const graphRegistry = (
    host as unknown as {
      readonly context: {
        readonly graphs: {
          acquire(id: string): unknown;
          touch(id: string): void;
        };
      };
    }
  ).context.graphs;
  let leases = 0;
  let touches = 0;
  const originalAcquire = graphRegistry.acquire.bind(graphRegistry);
  const originalTouch = graphRegistry.touch.bind(graphRegistry);
  graphRegistry.acquire = (id: string) => {
    leases += 1;
    return originalAcquire(id);
  };
  graphRegistry.touch = (id: string) => {
    touches += 1;
    originalTouch(id);
  };

  const outputs = host.outputsOf('output-graph');
  assert.equal(leases, 0, 'reading output must not take a residency lease');
  assert.equal(touches, 0, 'reading output must not refresh the idle clock');
  assert.deepEqual(
    [...outputs.entries()],
    [['zeta', { message: 'reply(native-1):zeta z' }]],
  );
  // It is a snapshot: mutating the returned Map cannot touch the host.
  (outputs as Map<NodeId, Value>).clear();
  assert.equal(host.outputsOf('output-graph').size, 1);

  const before = host.statusOf('output-graph');
  assert.ok(before !== undefined);
  assert.equal(before.residency.lastAccessAt, 1_000);
  assert.equal(before.residency.refCount, 0);

  // Exactly at the deadline, an output read must still leave the graph
  // evictable. A TTL refresh here would make the sweep skip it.
  clock.advance(10_000);
  assert.equal(host.outputsOf('output-graph').size, 1);
  assert.equal(host.statusOf('output-graph')?.residency.lastAccessAt, 1_000);
  const sweep = await host.sweep();
  assert.deepEqual(sweep.unloaded, ['output-graph']);
  assert.deepEqual(sweep.skipped, []);
  assert.throws(() => host.outputsOf('output-graph'), LiveHiveHostNotFoundError);

  await host.dispose();
  assert.throws(() => host.outputsOf('output-graph'), LiveHiveHostDisposedError);
});
