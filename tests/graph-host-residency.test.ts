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
  waitUntil,
} from './support/graph-host-fixtures.js';


test('a user hover is not unloaded or swept until it reaches Rest', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const cleanupEvents: LiveHiveHostEvent[] = [];
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    onEvent: (event) => cleanupEvents.push(event),
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = fastDefinition('hover', {
    idle: forager('never {{input}}'),
    ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' } },
  });
  const bindings = allFresh(definition);
  await host.loadGraph({
    definition,
    bindings,
    project: env.project,
    idleTtlMs: 100,
  });
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1']);
  const sessionId = env.registry.list()[0]?.sessionId;
  assert.ok(sessionId !== undefined);
  assert.equal(workspaceListenerCount(env.workspace), 1);

  const result = await triggerRun(host, 'hover', 'ask', text('hello'));
  assert.equal(result.rest, false);
  assert.equal(result.hovered, true);
  assert.equal(result.status.hovered, true);

  const status = host.statusOf('hover');
  assert.ok(status !== undefined);
  assert.equal(status.rest, false);
  assert.equal(status.hovered, true);
  const ask = nodeStatus(status, 'ask');
  assert.equal(ask.hovered, true);
  assert.equal(ask.active, false);
  assert.equal(ask.queue, 0);
  assert.equal(ask.pending, false);

  const serialized = JSON.stringify(status);
  for (const secret of ['hv_', 'hello', 'say something']) {
    assert.equal(
      serialized.includes(secret),
      false,
      `hover status leaked '${secret}'`,
    );
  }

  // A non-Rest graph must not be unloaded or swept: no session close, no
  // routing dispose and no cleanup event. The hover is still visible in status.
  clock.advance(1_000);
  assert.equal(await host.unload('hover'), false);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'hover', reason: 'unsafe' }]);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.get(sessionId)?.sessionId, sessionId);
  assert.equal(workspaceListenerCount(env.workspace), 1);
  assert.deepEqual(cleanupEvents, []);
  const retained = host.statusOf('hover');
  assert.ok(retained !== undefined);
  assert.equal(retained.rest, false);
  assert.equal(nodeStatus(retained, 'ask').hovered, true);

  // Resolve the hover through the live runtime (test-only introspection; the
  // M4a host intentionally has no answer API yet). A pump refreshes Rest.
  const runtime = runtimeOf(host, 'hover');
  runtime.answerHover('ask', text('answered'));
  await runtime.pump();
  assert.equal(host.statusOf('hover')?.rest, true);
  const answered = host.statusOf('hover');
  assert.ok(answered !== undefined);
  assert.equal(nodeStatus(answered, 'ask').hovered, false);

  assert.equal(await host.unload('hover'), true);
  assert.equal(host.statusOf('hover'), undefined);
  // A normal unload retains the session and closes nothing.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.get(sessionId)?.sessionId, sessionId);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('allowHoverUnload unloads a quiescent hover and retains its fresh session', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    allowHoverUnload: true,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = userAndForagerGraph('hover-unload');
  const bindings = allFresh(definition);
  await host.loadGraph({ definition, bindings, project: env.project });
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1']);
  assert.equal(workspaceListenerCount(env.workspace), 1);

  const triggered = await triggerRun(host, 'hover-unload', 'ask', text('waiting'));
  assert.equal(triggered.rest, false);
  assert.equal(triggered.hovered, true);
  const ask = nodeStatus(triggered.status, 'ask');
  assert.equal(ask.hovered, true);
  assert.equal(ask.active, false);
  assert.equal(ask.pending, false);
  assert.equal(ask.queue, 0);
  assert.equal(nodeStatus(triggered.status, 'idle').queue, 0);

  assert.equal(await host.unload('hover-unload'), true);
  assert.equal(host.statusOf('hover-unload'), undefined);
  // A hover-only unload is still a normal release: the session is retained.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 1);
  assert.equal(workspaceListenerCount(env.workspace), 0);

  // A reload creates a fresh forager session; the hover itself is in-memory
  // only here (no Honey), which is why this no-Honey case simply starts empty.
  await host.loadGraph({ definition, bindings, project: env.project });
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2']);
  assert.equal(env.registry.list().length, 2);
  assert.equal(workspaceListenerCount(env.workspace), 1);
  assert.equal(host.statusOf('hover-unload')?.rest, true);
});

test('allowHoverUnload still refuses a hover while another node has queued work', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    allowHoverUnload: true,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = userAndForagerGraph('hover-queue');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 100,
  });
  const triggered = await triggerRun(host, 'hover-queue', 'ask', text('waiting'));
  assert.equal(triggered.hovered, true);

  // A queue entry that no host pump has drained yet. The field is therefore
  // not quiescent even though the only active wait is a user hover.
  runtimeOf(host, 'hover-queue').trigger('idle', text('queued'));
  const queued = host.statusOf('hover-queue');
  assert.ok(queued !== undefined);
  assert.equal(nodeStatus(queued, 'idle').queue, 1);
  assert.equal(nodeStatus(queued, 'ask').hovered, true);

  clock.advance(100);
  assert.equal(await host.unload('hover-queue'), false);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'hover-queue', reason: 'unsafe' }]);
  assert.deepEqual(env.adapter.closedNativeIds, []);

  // Draining the queue returns the field to hover-only, which is unloadable.
  await runtimeOf(host, 'hover-queue').pump();
  assert.equal(host.statusOf('hover-queue')?.rest, false);
  assert.equal(await host.unload('hover-queue'), true);
});

async function assertSecondInputPending(host: LiveHiveHost): Promise<void> {
  const first = await triggerRun(host, 'hover-pending', 'idle', text('one'));
  assert.equal(first.rest, true);
  const secondAdmission = await host.trigger('hover-pending', 'idle', text('two'));
  await waitUntil(
    () =>
      host.statusOf('hover-pending')?.nodes.some(
        (node) => node.nodeId === 'idle' && node.pending,
      ) === true,
    'the second input to stay pending',
  );
  const secondStatus = host.statusOf('hover-pending');
  assert.ok(secondStatus !== undefined);
  assert.equal(secondStatus.rest, false);
  assert.equal(nodeStatus(secondStatus, 'idle').pending, true);
  assert.equal(host.runs.get('hover-pending', secondAdmission.runId)?.state, 'accepted');
}

test('allowHoverUnload still refuses a hover while a node has a pending Pheromone', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    allowHoverUnload: true,
    maxWaitMs: 0,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  // The default 1000ms minInterval leaves the second input pending: the pump
  // discovers it is not due yet and must not activate it.
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'hover-pending',
    nodes: {
      idle: forager('idle {{input}}'),
      ask: userNode(),
    },
    edges: [],
  });
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 100,
  });

  await assertSecondInputPending(host);

  const triggered = await triggerRun(host, 'hover-pending', 'ask', text('waiting'));
  assert.equal(triggered.hovered, true);
  const parked = host.statusOf('hover-pending');
  assert.ok(parked !== undefined);
  assert.equal(nodeStatus(parked, 'idle').pending, true);
  assert.equal(nodeStatus(parked, 'ask').hovered, true);

  clock.advance(100);
  assert.equal(await host.unload('hover-pending'), false);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'hover-pending', reason: 'unsafe' }]);

  // Once the pending input is due and drains, the hover is unloadable.
  clock.advance(1_000);
  await runtimeOf(host, 'hover-pending').pump();
  assert.equal(host.statusOf('hover-pending')?.rest, false);
  assert.equal(await host.unload('hover-pending'), true);
});

test('allowHoverUnload still refuses a hover while another node is active', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    allowHoverUnload: true,
  });
  t.after(async () => {
    env.adapter.releaseHeld();
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = userAndForagerGraph('hover-active');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
    idleTtlMs: 100,
  });

  // Drive the runtime directly so the active execution has no LiveHiveHost lease:
  // the only thing that may keep this graph loaded is the `active` guard itself.
  const runtime = runtimeOf(host, 'hover-active');
  runtime.trigger('ask', text('waiting'));
  await runtime.pump();
  assert.equal(host.statusOf('hover-active')?.hovered, true);

  env.adapter.holdSubmissions = true;
  runtime.trigger('idle', text('hold'));
  const pumping = runtime.pump();
  await env.adapter.waitForSubmit(1);

  const during = host.statusOf('hover-active');
  assert.ok(during !== undefined);
  assert.equal(nodeStatus(during, 'idle').active, true);
  assert.equal(nodeStatus(during, 'ask').hovered, true);
  assert.equal(during.residency.refCount, 0);

  clock.advance(100);
  assert.equal(await host.unload('hover-active'), false);
  const report = await host.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, [{ id: 'hover-active', reason: 'unsafe' }]);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(host.statusOf('hover-active') !== undefined, true);

  env.adapter.releaseHeld();
  await pumping;
  // The execution is gone and only the hover remains: now it is unloadable.
  assert.equal(await host.unload('hover-active'), true);
  assert.deepEqual(env.adapter.closedNativeIds, []);
});
