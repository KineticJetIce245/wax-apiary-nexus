import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import {
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
  type NodeDefinition,
  type NodeId,
  type Value,
} from '../src/runtime/index.js';
import type { AttachmentDraft } from '../src/shared/content.js';
import {
  BindingValidationError,
} from '../src/session/instantiate-foragers.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';

const FIXED_NOW = '2026-11-06T22:00:00.000Z';

class FakeClock {
  time: number;

  constructor(time = 1_000) {
    this.time = time;
  }

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

/**
 * Event-driven fake adapter. A submit emits its terminal events synchronously,
 * or parks the execution until `releaseHeld()` when `holdSubmissions` is set.
 * It never uses timers, and records prompts per native session as well as every
 * close, so tests can prove which session actually ran or was closed.
 */
class RecordingAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    rename: false,
    resume: false,
  };

  readonly allPrompts: string[] = [];
  readonly promptsByNative = new Map<string, string[]>();
  readonly createdNativeIds: string[] = [];
  readonly closedNativeIds: string[] = [];
  holdSubmissions = false;

  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly held = new Map<
    string,
    { readonly nativeId: string; readonly prompt: string; readonly executionId: string }
  >();
  private readonly submitWaiters: Array<() => void> = [];
  private nativeSeq = 0;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createConversation(_project: Project): Promise<string> {
    this.nativeSeq += 1;
    const nativeId = `native-${String(this.nativeSeq)}`;
    this.createdNativeIds.push(nativeId);
    return nativeId;
  }

  async submit(
    nativeId: string,
    executionId: string,
    text: string,
    _attachments?: readonly AttachmentDraft[],
  ): Promise<void> {
    this.allPrompts.push(text);
    const prompts = this.promptsByNative.get(nativeId) ?? [];
    prompts.push(text);
    this.promptsByNative.set(nativeId, prompts);

    for (const resolve of this.submitWaiters.splice(0)) {
      resolve();
    }

    if (this.holdSubmissions) {
      this.held.set(executionId, { nativeId, prompt: text, executionId });
      return;
    }
    this.finish(nativeId, executionId, text);
  }

  async cancel(_nativeId: string): Promise<void> {}

  async respondToApproval(): Promise<void> {}

  async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
  }

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** Resolve once at least `count` submits have been recorded. */
  async waitForSubmit(count: number): Promise<void> {
    while (this.allPrompts.length < count) {
      await new Promise<void>((resolve) => {
        this.submitWaiters.push(resolve);
      });
    }
  }

  releaseHeld(): void {
    const pending = [...this.held.values()];
    this.held.clear();
    for (const execution of pending) {
      this.finish(execution.nativeId, execution.executionId, execution.prompt);
    }
  }

  private finish(nativeId: string, executionId: string, prompt: string): void {
    this.emit({
      type: 'execution/output',
      executionId,
      channel: 'assistant',
      text: `reply(${nativeId}):${prompt}`,
    });
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

interface TestEnv {
  readonly adapter: RecordingAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
}

class FailingCloseAdapter extends RecordingAdapter {
  failClose = false;

  override async closeConversation(nativeId: string): Promise<void> {
    await super.closeConversation(nativeId);
    if (this.failClose) {
      throw new Error(`close failed for ${nativeId}`);
    }
  }
}

let projectSeq = 0;

function makeEnv(adapter: RecordingAdapter = new RecordingAdapter()): TestEnv {
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `project-${String(projectSeq)}`,
    // A real, existing directory is required by Workspace; no test writes here.
    directory: process.cwd(),
  };
  const registry = new SessionRegistry({
    workspace,
    harness: 'fake-harness',
    now: () => FIXED_NOW,
  });
  return { adapter, workspace, registry, project };
}

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => {
      settle?.();
    },
  };
}

function forager(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'fake', prompt } };
}

/**
 * Validates the graph with parseComposition, then rewrites node pacing to 0 so
 * one trigger can reach Rest without sleeping. GraphHost must not sleep between
 * pumps; a production graph that is deliberately paced just stops at maxPumps.
 */
function fastDefinition(
  id: string,
  nodes: Record<string, unknown>,
  edges: readonly Record<string, unknown>[] = [],
): CompositionDefinition {
  const parsed = parseComposition({ schemaVersion: 1, id, nodes, edges });
  const fastNodes = new Map<NodeId, NodeDefinition>();
  for (const [nodeId, node] of parsed.nodes) {
    fastNodes.set(nodeId, { ...node, minIntervalMs: 0 });
  }
  return { ...parsed, nodes: fastNodes };
}

function allFresh(definition: CompositionDefinition): GraphBindings {
  const bindings: Record<string, { readonly kind: 'fresh' }> = {};
  for (const node of definition.nodes.values()) {
    if (node.kind === 'forager') {
      bindings[node.id] = { kind: 'fresh' };
    }
  }
  return bindings;
}

function makeBindingStore(): GraphBindingStore {
  return new GraphBindingStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m5b-host-bindings-')), 'graph-bindings.json'),
    { now: () => FIXED_NOW },
  );
}

function promptsFor(adapter: RecordingAdapter, nativeId: string): readonly string[] {
  const prompts = adapter.promptsByNative.get(nativeId);
  assert.ok(prompts !== undefined, `no prompt reached native session '${nativeId}'`);
  return prompts;
}

function nodeStatus(status: GraphStatus, nodeId: NodeId): GraphNodeStatus {
  const node = status.nodes.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(node !== undefined, `status has no node '${nodeId}'`);
  return node;
}

/**
 * White-box read of the Workspace event subscriptions. Each forager executor
 * subscribes once; a disposed routing table unsubscribes every child. This is
 * the observable proof that unload actually disposed the executors.
 */
function workspaceListenerCount(workspace: Workspace): number {
  return (workspace as unknown as { readonly listeners: ReadonlySet<unknown> }).listeners.size;
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

/**
 * Test-only access to the live runtime so a user hover can be answered. M4a's
 * public host has no answer surface yet; this keeps production scope unchanged
 * while still proving that a graph becomes unloadable once it reaches Rest.
 */
interface RuntimeTestAccess {
  answerHover(nodeId: string, value: Value, token?: string): void;
  pump(): Promise<void>;
}

function runtimeOf(host: GraphHost, graphId: string): RuntimeTestAccess {
  const graphs = (host as unknown as {
    graphs: {
      peek(id: string): { readonly value: { readonly runtime: RuntimeTestAccess } } | undefined;
    };
  }).graphs;
  const entry = graphs.peek(graphId);
  assert.ok(entry !== undefined, `graph '${graphId}' is not loaded`);
  return entry.value.runtime;
}

function runnableForagerGraph(id: string, prompt = 'run {{input}}'): CompositionDefinition {
  return fastDefinition(id, { only: forager(prompt) });
}

/**
 * A fork/merge graph that keeps the production 1000ms node pacing. One pump
 * cannot reach Rest because the merge waits for its second activation.
 */
function pacedForkMergeDefinition(id: string): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      start: forager('start {{input}}'),
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'branch-a' },
            { id: 'b', to: 'branch-b' },
          ],
        },
      },
      'branch-a': forager('branch-a {{input}}'),
      'branch-b': forager('branch-b {{input}}'),
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'branch-a', to: 'merge' },
      { id: 'e3', from: 'branch-b', to: 'merge' },
    ],
  });
}

test('a fork/merge graph runs to Rest and status never contains bodies or tokens', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
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
      start: forager('start {{input}}'),
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'branch-a' },
            { id: 'b', to: 'branch-b' },
          ],
        },
      },
      'branch-a': forager('branch-a {{input}}'),
      'branch-b': forager('branch-b {{input}}'),
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'branch-a', to: 'merge' },
      { id: 'e3', from: 'branch-b', to: 'merge' },
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

  const result = await host.trigger('main', 'start', text('seed'));
  assert.equal(result.graphId, 'main');
  assert.equal(result.rest, true);
  assert.equal(result.hovered, false);
  assert.ok(result.pumps >= 1, 'trigger must actually pump');
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
    assert.equal(node.queue, 0);
    assert.equal(node.pending, false);
    assert.equal(node.active, false);
    assert.equal(node.hovered, false);
  }
  // Closed merge tombstones are counted, matching `wax inspect status`.
  assert.equal(nodeStatus(status, 'merge').joins, 1);

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
  const host = new GraphHost({
    workspace: env.workspace,
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

  assert.deepEqual(
    host.status().map((status) => status.graphId),
    ['graph-a', 'graph-b'],
  );
  assert.equal(host.statusOf('graph-a')?.rest, true);
  assert.equal(host.statusOf('graph-b')?.rest, true);

  const first = await host.trigger('graph-a', 'only', text('one'));
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

  const second = await host.trigger('graph-b', 'only', text('two'));
  assert.equal(second.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-2'), ['B two']);
  assert.equal(host.statusOf('graph-a')?.residency.lastAccessAt, lastAccessA);
  assert.equal(host.statusOf('graph-b')?.residency.lastAccessAt, clock.time);

  assert.equal(await host.unload('graph-a'), true);
  assert.equal(host.statusOf('graph-a'), undefined);
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
  assert.equal(host.statusOf('graph-b')?.rest, true);

  const third = await host.trigger('graph-b', 'only', text('three'));
  assert.equal(third.rest, true);
  assert.deepEqual(promptsFor(env.adapter, 'native-2'), ['B two', 'B three']);
});

test('a user hover is not unloaded or swept until it reaches Rest', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const cleanupEvents: GraphHostEvent[] = [];
  const host = new GraphHost({
    workspace: env.workspace,
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

  const result = await host.trigger('hover', 'ask', text('hello'));
  assert.equal(result.rest, false);
  assert.equal(result.hovered, true);
  assert.equal(result.pumps, 1);
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('duplicate load, invalid bindings and an unknown graph are rejected explicitly', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
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

test('unload closes fresh sessions, keeps borrowed sessions and disposes routing', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
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
  // Only the created session is closed; the borrowed one stays registered and
  // usable, and every executor subscription is gone.
  assert.deepEqual(env.adapter.closedNativeIds, ['native-2']);
  assert.equal(env.registry.list().length, 1);
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

test('a failed fresh-session close is reported but does not block unload', async (t) => {
  const adapter = new FailingCloseAdapter();
  const env = makeEnv(adapter);
  const events: GraphHostEvent[] = [];
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
    registry: env.registry,
    now: clock.now,
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('cleanup', 'cleanup {{input}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  const sessionId = env.registry.list()[0]?.sessionId;
  assert.ok(sessionId !== undefined);

  adapter.failClose = true;
  // A failed close is best effort: the graph must still be forgotten, and the
  // failure is surfaced as metadata instead of breaking residency.
  assert.equal(await host.unload('cleanup'), true);
  assert.equal(host.statusOf('cleanup'), undefined);
  assert.equal(workspaceListenerCount(env.workspace), 0);
  assert.deepEqual(events, [
    {
      type: 'graph.cleanup-failed',
      graphId: 'cleanup',
      phase: 'session',
      sessionId,
      error: 'close failed for native-1',
    },
  ]);
  // The WAX record survives because the native close failed; this test records
  // the leak rather than pretending cleanup succeeded.
  assert.ok(env.registry.get(sessionId) !== undefined);
});

test('idle sweep follows TTL, and a trigger renews the deadline', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);

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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1', 'native-2']);
});

test('a busy graph is neither unloaded nor swept while its trigger is in flight', async (t) => {
  const env = makeEnv();
  env.adapter.holdSubmissions = true;
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('a non-Rest field refuses unload, sweep and best-effort dispose', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
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
    workspace: env.workspace,
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1', 'native-2']);
  assert.equal(workspaceListenerCount(env.workspace), 0);

  await host.dispose();
  assert.equal(env.adapter.closedNativeIds.length, 2);

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

test('status and statusOf are pure reads and M4a defaults idle TTL to 0', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
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

test('an unknown trigger node rethrows the runtime error and releases the lease', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
    registry: env.registry,
    now: clock.now,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = runnableForagerGraph('lease', 'run {{input}}');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  await assert.rejects(
    host.trigger('lease', 'does-not-exist', text('x')),
    /unknown node 'does-not-exist'/,
  );

  const status = host.statusOf('lease');
  assert.ok(status !== undefined);
  assert.equal(status.rest, true);
  assert.equal(status.residency.state, 'loaded');
  assert.equal(status.residency.refCount, 0);
  assert.equal(env.adapter.allPrompts.length, 0);

  const result = await host.trigger('lease', 'only', text('works'));
  assert.equal(result.rest, true);
  assert.deepEqual(env.adapter.allPrompts, ['run works']);
});

test('trigger waits out minInterval pacing and reaches Rest', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const waits: number[] = [];
  const host = new GraphHost({
    workspace: env.workspace,
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

  const definition = pacedForkMergeDefinition('paced-rest');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const result = await host.trigger('paced-rest', 'start', text('seed'));
  assert.equal(result.rest, true);
  assert.equal(result.hovered, false);
  assert.deepEqual(waits, [1_000]);
  assert.equal(result.pumps, 2);
  assert.equal(clock.time, 2_000);

  const status = host.statusOf('paced-rest');
  assert.ok(status !== undefined);
  assert.equal(status.rest, true);
  const merge = nodeStatus(status, 'merge');
  assert.equal(merge.pending, false);
  assert.equal(merge.queue, 0);
  assert.equal(merge.joins, 1);
  assert.deepEqual(env.adapter.closedNativeIds, []);
});

test('the trigger lease covers pacing waits, not only pump calls', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const sleepStarted = deferred();
  const releaseSleep = deferred();
  const waits: number[] = [];
  const host = new GraphHost({
    workspace: env.workspace,
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

  const definition = pacedForkMergeDefinition('paced-lease');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const run = host.trigger('paced-lease', 'start', text('seed'));
  await sleepStarted.promise;
  assert.deepEqual(waits, [1_000]);
  const during = host.statusOf('paced-lease');
  assert.ok(during !== undefined);
  assert.equal(during.rest, false);
  assert.equal(during.residency.refCount, 1);
  assert.equal(await host.unload('paced-lease'), false);
  const report = await host.sweep();
  assert.deepEqual(report.skipped, [{ id: 'paced-lease', reason: 'busy' }]);
  assert.deepEqual(env.adapter.closedNativeIds, []);

  releaseSleep.resolve();
  const result = await run;
  assert.equal(result.rest, true);
  assert.equal(result.status.residency.refCount, 0);
  assert.equal(await host.unload('paced-lease'), true);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('maxWaitMs bounds pacing waits and leaves non-Rest graphs loaded', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const zeroWaits: number[] = [];
  const zeroHost = new GraphHost({
    workspace: env.workspace,
    registry: env.registry,
    now: clock.now,
    maxWaitMs: 0,
    sleep: async (ms) => {
      zeroWaits.push(ms);
      clock.advance(ms);
    },
  });
  const shortWaits: number[] = [];
  const shortHost = new GraphHost({
    workspace: env.workspace,
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

  const noWaitDefinition = pacedForkMergeDefinition('no-wait');
  await zeroHost.loadGraph({
    definition: noWaitDefinition,
    bindings: allFresh(noWaitDefinition),
    project: env.project,
  });
  const noWait = await zeroHost.trigger('no-wait', 'start', text('seed'));
  assert.equal(noWait.rest, false);
  assert.equal(noWait.pumps, 1);
  assert.deepEqual(zeroWaits, []);
  assert.ok(zeroHost.statusOf('no-wait') !== undefined);

  const shortDefinition = pacedForkMergeDefinition('short-wait');
  await shortHost.loadGraph({
    definition: shortDefinition,
    bindings: allFresh(shortDefinition),
    project: env.project,
  });
  const short = await shortHost.trigger('short-wait', 'start', text('seed'));
  assert.equal(short.rest, false);
  assert.equal(short.pumps, 2);
  assert.deepEqual(shortWaits, [250]);
  assert.equal(
    shortWaits.reduce((sum, wait) => sum + wait, 0),
    250,
  );
  const shortStatus = shortHost.statusOf('short-wait');
  assert.ok(shortStatus !== undefined);
  assert.equal(shortStatus.rest, false);
  const merge = nodeStatus(shortStatus, 'merge');
  assert.equal(merge.pending, true);
  assert.equal(merge.joins, 1);
  assert.deepEqual(env.adapter.closedNativeIds, []);
});

test('maxPumps exhaustion reports rest=false without pretending success or losing the graph', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new GraphHost({
    workspace: env.workspace,
    registry: env.registry,
    now: clock.now,
    maxPumps: 1,
  });
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  // This graph keeps the default 1000ms pacing: the merge must wait for its
  // second activation, so one pump cannot reach Rest.
  const definition = pacedForkMergeDefinition('paced');
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const result = await host.trigger('paced', 'start', text('seed'));
  assert.equal(result.rest, false);
  assert.equal(result.hovered, false);
  assert.equal(result.pumps, 1);
  assert.equal(result.status.rest, false);
  assert.equal(result.status.residency.refCount, 0);

  const status = host.statusOf('paced');
  assert.ok(status !== undefined);
  assert.equal(status.rest, false);
  const merge = nodeStatus(status, 'merge');
  assert.equal(merge.pending, true);
  assert.equal(merge.queue, 0);
  assert.equal(merge.joins, 1);

  assert.equal(host.status().length, 1);
  assert.deepEqual(env.adapter.closedNativeIds, []);
  // The graph is still loaded and can accept another trigger.
  const again = await host.trigger('paced', 'start', text('again'));
  assert.equal(again.graphId, 'paced');
  assert.equal(host.statusOf('paced') !== undefined, true);
});

test('fresh_once keeps its session and mapping across unload and reuses it on reload', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const bindingStore = makeBindingStore();
  const host = new GraphHost({
    workspace: env.workspace,
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

test('fresh_always closes on unload and creates a new session on reload', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const bindingStore = makeBindingStore();
  const host = new GraphHost({
    workspace: env.workspace,
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

  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
  assert.deepEqual(env.registry.list(), []);
  assert.deepEqual(bindingStore.snapshot(), []);

  await host.loadGraph({ definition, bindings, project: env.project });
  const second = env.registry.list()[0];
  assert.ok(second !== undefined);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.deepEqual(env.adapter.createdNativeIds, ['native-1', 'native-2']);
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
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
    workspace: env.workspace,
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
