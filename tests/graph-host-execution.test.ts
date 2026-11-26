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
  pacedSpreadGatherDefinition,
  triggerRun,
  waitUntil,
} from './support/graph-host-fixtures.js';

class ThrowingTouchRegistry extends SessionRegistry {
  override touch(): void {
    throw new Error('touch failed');
  }
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

test('a spread/gather graph runs to Rest and status never contains bodies or tokens', async (t) => {
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

  const definition = fastDefinition(
    'main',
    {
      start: forager('start {{message}}'),
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'branch-a' },
            { id: 'b', to: 'branch-b' },
          ],
        },
      },
      'branch-a': forager('branch-a {{message}}'),
      'branch-b': forager('branch-b {{message}}'),
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
    },
    [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'branch-a', to: 'gather' },
      { id: 'e3', from: 'branch-b', to: 'gather' },
    ],
  );
  const bindings = allFresh(definition);

  const loaded = await host.loadGraph({
    definition,
    bindings,
    project: env.project,
  });
  assert.equal(loaded.graphId, 'main');
  assert.equal(loaded.rest, true);
  assert.equal(loaded.hovered, false);
  assert.equal(loaded.residency.idleTtlMs, 0);
  assert.equal(loaded.residency.refCount, 0);

  const result = await triggerRun(host, 'main', 'start', text('seed'));
  assert.equal(result.graphId, 'main');
  assert.equal(result.rest, true);
  assert.equal(result.hovered, false);
  assert.equal(result.status.rest, true);
  assert.deepEqual(result.status, host.statusOf('main'));

  // Three fresh sessions in definition order; each branch got its own prompt
  // and the start session's output.
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2', 'native-3']);
  assert.deepEqual(promptsFor(env.adapter, 'native-1'), ['start seed']);
  assert.deepEqual(promptsFor(env.adapter, 'native-2'), [
    'branch-a reply(native-1):start seed',
  ]);
  assert.deepEqual(promptsFor(env.adapter, 'native-3'), [
    'branch-b reply(native-1):start seed',
  ]);
  assert.equal(env.adapter.promptsByNative.size, 3);

  const status = host.statusOf('main');
  assert.ok(status !== undefined);
  assert.equal(status.rest, true);
  assert.equal(status.hovered, false);
  for (const node of status.nodes) {
    assert.equal(node.receptor, 0);
    assert.equal(node.pending, false);
    assert.equal(node.active, false);
    assert.equal(node.hovered, false);
  }
  // Closed gather tombstones are counted, matching `wax inspect status`.
  assert.equal(nodeStatus(status, 'gather').gathers, 1);

  const serialized = JSON.stringify(host.status());
  for (const secret of ['start seed', 'reply(', 'hv_', 'gd_']) {
    assert.equal(
      serialized.includes(secret),
      false,
      `status leaked runtime body/token fragment '${secret}'`,
    );
  }
  for (const key of collectKeys(host.status())) {
    assert.equal(
      ['prompt', 'output', 'token', 'hover', 'value', 'pheromones'].includes(key),
      false,
      `status leaked key '${key}'`,
    );
  }
});

test('two loaded graphs stay independent through trigger and unload', async (t) => {
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

  const graphA = runnableForagerGraph('graph-a', 'A {{message}}');
  const graphB = runnableForagerGraph('graph-b', 'B {{message}}');
  await host.loadGraph({ definition: graphA, bindings: allFresh(graphA), project: env.project });
  await host.loadGraph({ definition: graphB, bindings: allFresh(graphB), project: env.project });

  assert.deepEqual(
    host.status().map((status) => status.graphId),
    ['graph-a', 'graph-b'],
  );
  assert.equal(host.statusOf('graph-a')?.rest, true);
  assert.equal(host.statusOf('graph-b')?.rest, true);

  const first = await triggerRun(host, 'graph-a', 'only', text('one'));
  assert.equal(first.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-1'), ['A one']);
  assert.equal(env.adapter.promptsByNative.has('native-2'), false);
  assert.equal(host.statusOf('graph-b')?.rest, true);
  assert.equal(env.adapter.allPrompts.length, 1);

  clock.advance(100);
  const lastAccessA = host.statusOf('graph-a')?.residency.lastAccessAt;
  const lastAccessB = host.statusOf('graph-b')?.residency.lastAccessAt;
  // Plain status reads are not accesses.
  host.status();
  host.statusOf('graph-a');
  assert.equal(host.statusOf('graph-a')?.residency.lastAccessAt, lastAccessA);
  assert.equal(host.statusOf('graph-b')?.residency.lastAccessAt, lastAccessB);

  const second = await triggerRun(host, 'graph-b', 'only', text('two'));
  assert.equal(second.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-2'), ['B two']);
  assert.equal(host.statusOf('graph-a')?.residency.lastAccessAt, lastAccessA);
  assert.equal(host.statusOf('graph-b')?.residency.lastAccessAt, clock.time);

  assert.equal(await host.unload('graph-a'), true);
  assert.equal(host.statusOf('graph-a'), undefined);
  // Unload releases routing only: graph-a's session is retained.
  assert.deepEqual(env.adapter.closedNativeIds, []);
  assert.equal(env.registry.list().length, 2);
  assert.equal(host.statusOf('graph-b')?.rest, true);

  const third = await triggerRun(host, 'graph-b', 'only', text('three'));
  assert.equal(third.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-2'), ['B two', 'B three']);
});

test('an unknown trigger node rethrows the runtime error and releases the lease', async (t) => {
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

  const definition = runnableForagerGraph('lease', 'run {{message}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  await assert.rejects(
    triggerRun(host, 'lease', 'does-not-exist', text('x')),
    /unknown node 'does-not-exist'/,
  );

  const status = host.statusOf('lease');
  assert.ok(status !== undefined);
  assert.equal(status.rest, true);
  assert.equal(status.residency.state, 'loaded');
  assert.equal(status.residency.refCount, 0);
  assert.equal(env.adapter.allPrompts.length, 0);

  const result = await triggerRun(host, 'lease', 'only', text('works'));
  assert.equal(result.rest, true);
  assert.deepEqual(env.adapter.allPrompts, ['run works']);
});

test('trigger waits out minInterval pacing and reaches Rest', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const waits: number[] = [];
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    sleep: async (ms) => {
      waits.push(ms);
      clock.advance(ms);
    },
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = pacedSpreadGatherDefinition('paced-rest');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const result = await triggerRun(host, 'paced-rest', 'start', text('seed'));
  assert.equal(result.rest, true);
  assert.equal(result.hovered, false);
  assert.deepEqual(waits, [1_000]);
  assert.equal(clock.time, 2_000);

  const status = host.statusOf('paced-rest');
  assert.ok(status !== undefined);
  assert.equal(status.rest, true);
  const gather = nodeStatus(status, 'gather');
  assert.equal(gather.pending, false);
  assert.equal(gather.receptor, 0);
  assert.equal(gather.gathers, 1);
  assert.deepEqual(env.adapter.closedNativeIds, []);
});

test('wake admission does not hold the live lease during pacing waits', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const sleepStarted = deferred();
  const releaseSleep = deferred();
  const waits: number[] = [];
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    sleep: async (ms) => {
      waits.push(ms);
      sleepStarted.resolve();
      await releaseSleep.promise;
      clock.advance(ms);
    },
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = pacedSpreadGatherDefinition('paced-lease');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const run = triggerRun(host, 'paced-lease', 'start', text('seed'));
  await sleepStarted.promise;
  assert.deepEqual(waits, [1_000]);
  const during = host.statusOf('paced-lease');
  assert.ok(during !== undefined);
  assert.equal(during.rest, false);
  // The admission lock is short: no lease is held while the native work paces.
  assert.equal(during.residency.refCount, 0);
  assert.equal(await host.unload('paced-lease'), false);
  const report = await host.sweep();
  assert.deepEqual(report.skipped, [{ id: 'paced-lease', reason: 'disabled' }]);
  assert.deepEqual(env.adapter.closedNativeIds, []);

  releaseSleep.resolve();
  const result = await run;
  assert.equal(result.rest, true);
  assert.equal(result.status.residency.refCount, 0);
  assert.equal(await host.unload('paced-lease'), true);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

async function assertPacingBounds(
  env: ReturnType<typeof makeEnv>,
  zeroHost: LiveHiveHost,
  shortHost: LiveHiveHost,
  zeroWaits: readonly number[],
  shortWaits: readonly number[],
): Promise<void> {
  const noWaitDefinition = pacedSpreadGatherDefinition('no-wait');
  await zeroHost.loadGraph({
    definition: noWaitDefinition,
    bindings: allFresh(noWaitDefinition),
    project: env.project,
  });
  await zeroHost.trigger('no-wait', 'start', text('seed'));
  await waitUntil(
    () => zeroHost.statusOf('no-wait') !== undefined && !zeroHost.statusOf('no-wait')!.rest,
    'the no-wait driver to stop',
  );
  assert.deepEqual(zeroWaits, []);
  assert.equal(zeroHost.statusOf('no-wait')?.rest, false);
  assert.ok(zeroHost.statusOf('no-wait') !== undefined);
  const shortDefinition = pacedSpreadGatherDefinition('short-wait');
  await shortHost.loadGraph({
    definition: shortDefinition,
    bindings: allFresh(shortDefinition),
    project: env.project,
  });
  await shortHost.trigger('short-wait', 'start', text('seed'));
  await waitUntil(() => shortWaits.length === 1, 'the bounded pacing wait');
  await waitUntil(
    () =>
      shortHost.statusOf('short-wait')?.nodes.some(
        (node) => node.nodeId === 'gather' && node.pending,
      ) === true,
    'the gather to stay pending',
  );
  assert.deepEqual(shortWaits, [250]);
  assert.equal(shortWaits.reduce((sum, wait) => sum + wait, 0), 250);
  assert.equal(shortHost.statusOf('short-wait')?.rest, false);
  const shortStatus = shortHost.statusOf('short-wait');
  assert.ok(shortStatus !== undefined);
  assert.equal(shortStatus.rest, false);
  const gather = nodeStatus(shortStatus, 'gather');
  assert.equal(gather.pending, true);
  assert.equal(gather.gathers, 1);
  assert.deepEqual(env.adapter.closedNativeIds, []);
}

test('maxWaitMs bounds pacing waits and leaves non-Rest graphs loaded', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const zeroWaits: number[] = [];
  const zeroHost = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    maxWaitMs: 0,
    sleep: async (ms) => {
      zeroWaits.push(ms);
      clock.advance(ms);
    },
  });
  const shortWaits: number[] = [];
  const shortHost = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    maxWaitMs: 250,
    sleep: async (ms) => {
      shortWaits.push(ms);
      clock.advance(ms);
    },
  });
  t.after(async () => {
    await zeroHost.dispose();
    await shortHost.dispose();
    await env.workspace.stop();
  });

  await assertPacingBounds(env, zeroHost, shortHost, zeroWaits, shortWaits);
});

test('maxPumps exhaustion reports rest=false without pretending success or losing the graph', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    maxPumps: 1,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  // This graph keeps the default 1000ms pacing: the gather must wait for its
  // second activation, so one pump cannot reach Rest.
  const definition = pacedSpreadGatherDefinition('paced');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  await host.trigger('paced', 'start', text('seed'));
  await waitUntil(
    () => host.statusOf('paced')?.nodes.some((node) => node.nodeId === 'gather' && node.pending) === true,
    'one maximum pump to leave the gather pending',
  );
  assert.equal(host.statusOf('paced')?.rest, false);
  assert.equal(host.statusOf('paced')?.residency.refCount, 0);

  const status = host.statusOf('paced');
  assert.ok(status !== undefined);
  assert.equal(status.rest, false);
  const gather = nodeStatus(status, 'gather');
  assert.equal(gather.pending, true);
  assert.equal(gather.receptor, 0);
  assert.equal(gather.gathers, 1);

  assert.equal(host.status().length, 1);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  // The graph is still loaded and can accept another delivery.
  await host.trigger('paced', 'start', text('again'));
  assert.equal(host.statusOf('paced') !== undefined, true);
});

test('answer resolves an open user hover and rejects invalid targets and tokens', async (t) => {
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

  const definition = userAndForagerGraph('answer');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  await assert.rejects(
    host.answer('answer', 'ask', text('early')),
    isAnswerError('no-hover'),
  );
  const triggered = await triggerRun(host, 'answer', 'ask', text('waiting'));
  assert.equal(triggered.hovered, true);
  const token = hoverTokenOf(host, 'answer', 'ask');

  await assert.rejects(
    host.answer('answer', 'absent', text('x')),
    isAnswerError('unknown-node'),
  );
  await assert.rejects(
    host.answer('answer', 'idle', text('x')),
    isAnswerError('not-user-node'),
  );
  await assert.rejects(
    host.answer('answer', 'ask', text('x'), 'hv_wrong'),
    (error: unknown) => {
      assert.equal(isAnswerError('token-mismatch')(error), true);
      assert.equal(messageOfTest(error).includes('hv_wrong'), false);
      assert.equal(messageOfTest(error).includes(token), false);
      return true;
    },
  );

  await host.answer('answer', 'ask', text('answered'), token);
  await waitUntil(
    () => host.statusOf('answer')?.rest === true,
    'the answered field to settle',
  );
  const answered = host.statusOf('answer');
  assert.ok(answered !== undefined);
  assert.equal(answered.rest, true);
  assert.equal(answered.hovered, false);
  assert.equal(nodeStatus(answered, 'ask').hovered, false);
  assert.deepEqual(host.outputsOf('answer').get('ask'), text('answered'));

  // The hover is gone after one answer; a second answer is not queued early.
  await assert.rejects(
    host.answer('answer', 'ask', text('again')),
    isAnswerError('no-hover'),
  );
  await assert.rejects(
    host.answer('missing', 'ask', text('x')),
    LiveHiveHostNotFoundError,
  );
  assert.equal(env.adapter.promptsByNative.size, 0);
});

test('answer only binds the hover; the field completes in the background', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    maxPumps: 0,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = fastDefinition(
    'answer-nonrest',
    {
      ask: userNode(),
      idle: forager('idle {{message}}'),
    },
    [{ id: 'e', from: 'ask', to: 'idle' }],
  );
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  // Park a hover without the host pump (host trigger honors maxPumps: 0).
  const runtime = runtimeOf(host, 'answer-nonrest');
  await runtime.admit('ask', text('waiting'));
  await runtime.pump();
  assert.equal(host.statusOf('answer-nonrest')?.hovered, true);

  // The answer call resolves once the hover is bound, not when the bee runs.
  await host.answer('answer-nonrest', 'ask', text('answered'));
  await waitUntil(
    () => host.statusOf('answer-nonrest')?.rest === true,
    'the answered field to settle',
  );
  const idle = host.outputsOf('answer-nonrest').get('idle');
  assert.deepEqual(idle, { message: 'reply(native-1):idle answered' });
  assert.equal(host.statusOf('answer-nonrest') !== undefined, true);
});

test('trigger refreshes the lastAccessAt of every bound session', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv(new RecordingAdapter(), () => new Date(clock.time).toISOString());
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = fastDefinition('touch-trigger', {
    first: forager('first {{message}}'),
    second: forager('second {{message}}'),
  });
  await host.loadGraph({ definition, bindings: allFresh(definition), project: env.project });
  const sessions = env.registry.list();
  assert.equal(sessions.length, 2);
  for (const record of sessions) {
    assert.equal(record.lastAccessAt, new Date(1_000).toISOString());
  }

  clock.advance(5_000);
  const result = await triggerRun(host, 'touch-trigger', 'first', text('go'));
  assert.equal(result.rest, true);
  // Only one node ran, but every session the loaded graph is bound to was used
  // by that run, so all of them must be protected from the next idle sweep.
  for (const record of sessions) {
    assert.equal(
      env.registry.get(record.sessionId)?.lastAccessAt,
      new Date(6_000).toISOString(),
    );
  }
});

test('answer refreshes the lastAccessAt of every bound session', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv(new RecordingAdapter(), () => new Date(clock.time).toISOString());
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = userAndForagerGraph('touch-answer');
  await host.loadGraph({ definition, bindings: allFresh(definition), project: env.project });
  const sessions = env.registry.list();

  clock.advance(1_000);
  const triggered = await triggerRun(host, 'touch-answer', 'ask', text('waiting'));
  assert.equal(triggered.hovered, true);

  clock.advance(2_000);
  const token = hoverTokenOf(host, 'touch-answer', 'ask');
  await host.answer('touch-answer', 'ask', text('yes'), token);
  await waitUntil(
    () => host.statusOf('touch-answer')?.rest === true,
    'the answered field to settle',
  );
  for (const record of sessions) {
    assert.equal(
      env.registry.get(record.sessionId)?.lastAccessAt,
      new Date(4_000).toISOString(),
    );
  }
});

test('a failing touch does not change a trigger or answer result', async (t) => {
  const adapter = new RecordingAdapter();
  const workspace = new Workspace(adapter);
  const registry = new ThrowingTouchRegistry({
    workspaces: new Map([['fake-harness', workspace]]),
    now: () => FIXED_NOW,
  });
  const project: Project = {
    id: 'project-touch-failure',
    directory: process.cwd(),
  };
  const host = new LiveHiveHost({ registry, now: () => 1_000 });
  t.after(async () => {
    await host.dispose();
    await workspace.stop();
  });

  const definition = fastDefinition(
    'touch-failure',
    { ask: userNode(), run: forager('run {{message}}') },
    [{ id: 'e', from: 'ask', to: 'run' }],
  );
  await host.loadGraph({ definition, bindings: allFresh(definition), project });

  const triggered = await triggerRun(host, 'touch-failure', 'ask', text('waiting'));
  assert.equal(triggered.hovered, true);
  const token = hoverTokenOf(host, 'touch-failure', 'ask');
  await host.answer('touch-failure', 'ask', text('answered'), token);
  await waitUntil(
    () => host.statusOf('touch-failure')?.rest === true,
    'the answered field to settle',
  );
  // The answer still reached the downstream forager despite every touch failing.
  assert.deepEqual(adapter.allPrompts, ['run answered']);
});

function messageOfTest(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

test('onGuard is passed to the runtime and decides native approvals', async (t) => {
  const adapter = new RecordingAdapter({ askApproval: true });
  const env = makeEnv(adapter);
  const seen: GuardRequest[] = [];
  const decisions: readonly GuardDecision[] = ['allow_once', 'reject_once'];
  const host = new LiveHiveHost({
    registry: env.registry,
    onGuard: async (request) => {
      seen.push(request);
      return decisions[seen.length - 1] ?? 'cancelled';
    },
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('guard-decisions');
  await host.loadGraph({ definition, bindings: allFresh(definition), project: env.project });

  const allowed = await triggerRun(host, 'guard-decisions', 'only', text('one'));
  await waitUntil(
    () => host.statusOf('guard-decisions')?.rest === true,
    'the allowed guard to settle',
  );
  const rejected = await triggerRun(host, 'guard-decisions', 'only', text('two'));
  await waitUntil(
    () => host.statusOf('guard-decisions')?.rest === true,
    'the rejected guard to settle',
  );

  assert.equal(host.statusOf('guard-decisions')?.rest, true);
  assert.equal(seen.length, 2, 'every native approval went through onGuard');
  assert.deepEqual(
    adapter.approvals.map((decision) => decision.kind),
    ['allow_once', 'reject_once'],
    'both decisions reached the native adapter',
  );
  assert.equal(seen[0]?.summary, 'run a command');
});

test('a native approval is rejected when no onGuard handler is configured', async (t) => {
  const adapter = new RecordingAdapter({ askApproval: true });
  const env = makeEnv(adapter);
  const host = new LiveHiveHost({ registry: env.registry });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('guard-default');
  await host.loadGraph({ definition, bindings: allFresh(definition), project: env.project });

  const result = await triggerRun(host, 'guard-default', 'only', text('go'));
  await waitUntil(
    () => host.statusOf('guard-default')?.rest === true,
    'the default-rejected guard to settle',
  );

  assert.equal(host.statusOf('guard-default')?.rest, true);
  assert.equal(host.statusOf('guard-default')?.hovered, false);
  assert.deepEqual(
    adapter.approvals.map((decision) => decision.kind),
    ['reject_once'],
    'the runtime rejected instead of auto-allowing the guard',
  );
});
