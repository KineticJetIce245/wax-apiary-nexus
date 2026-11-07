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

const FIXED_NOW = '2026-11-06T22:00:00.000Z';
const SAVE_ERROR = 'honey save failed: disk full';

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
 * Event-driven fake adapter. `submit` emits its terminal events synchronously,
 * so a trigger settles without timers or sleeps. It records prompts per native
 * session as well as every close, which lets a test prove that a fresh session
 * was replaced and that a failed flush never replays a trigger.
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

  private readonly listeners = new Set<(event: HarnessEvent) => void>();
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
    this.emit({
      type: 'execution/output',
      executionId,
      channel: 'assistant',
      text: `reply(${nativeId}):${text}`,
    });
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
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

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** Honey wrapper whose save can be made to fail without touching the disk. */
class FailingHoneyStore extends HoneyStore {
  failSave = false;

  override save(field: PersistedField): void {
    if (this.failSave) {
      throw new Error(SAVE_ERROR);
    }
    super.save(field);
  }
}

interface TestEnv {
  readonly adapter: RecordingAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
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

function forager(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'fake', prompt } };
}

/**
 * Validates the graph with parseComposition, then rewrites node pacing to 0 so
 * one trigger can reach Rest without sleeping.
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

function runnableForagerGraph(id: string, prompt = 'run {{input}}'): CompositionDefinition {
  return fastDefinition(id, { only: forager(prompt) });
}

/**
 * start -> counter -> done, with the unused `continue` branch required by the
 * counter definition shape. One trigger increments the counter to 1.
 */
function counterDefinition(id: string): CompositionDefinition {
  return fastDefinition(
    id,
    {
      start: forager('start {{input}}'),
      count: { kind: 'counter', config: { max: 1, step: 1 } },
      again: forager('again {{input}}'),
      done: forager('done {{input}}'),
    },
    [
      { id: 'e1', from: 'start', to: 'count' },
      { id: 'e2', from: 'count', to: 'again', when: 'continue' },
      { id: 'e3', from: 'count', to: 'done', when: 'done' },
      { id: 'e4', from: 'again', to: 'count' },
    ],
  );
}

function promptsFor(adapter: RecordingAdapter, nativeId: string): readonly string[] {
  const prompts = adapter.promptsByNative.get(nativeId);
  assert.ok(prompts !== undefined, `no prompt reached native session '${nativeId}'`);
  return prompts;
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

/** Test-only access to the live runtime for field comparison. */
interface RuntimeTestAccess {
  exportField(): PersistedField;
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

function counterCount(field: PersistedField | undefined): unknown {
  assert.ok(field !== undefined, 'expected a persisted field');
  return field.nodes['count']?.state?.['count'];
}

test('trigger flushes the field to Honey and reports persisted', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-flush-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'flush');
  const host = new GraphHost({
    workspace: env.workspace,
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
    workspace: env.workspace,
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1', 'native-2', 'native-3']);
  assert.deepEqual(env.registry.list(), []);
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
  assert.equal(secondSessionIds.length, 3);
  assert.equal(workspaceListenerCount(env.workspace), 3);
  for (const sessionId of firstSessionIds) {
    assert.equal(secondSessionIds.includes(sessionId), false);
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

test('unload closes fresh sessions and reload creates replacements', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-fresh-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'fresh');
  const host = new GraphHost({
    workspace: env.workspace,
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
  assert.deepEqual(env.registry.list(), []);
  assert.equal(workspaceListenerCount(env.workspace), 0);

  await host.loadGraph({ definition, bindings, project: env.project });
  const second = env.registry.list()[0];
  assert.ok(second !== undefined);
  assert.notEqual(second.sessionId, first.sessionId);
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
    workspace: env.workspace,
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1']);
  assert.deepEqual(env.registry.list(), []);
  assert.equal(workspaceListenerCount(env.workspace), 0);
});

test('a failed trigger flush is reported without replaying the trigger', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-trigger-fail-'));
  const honey = new FailingHoneyStore(honeyPaths(root, 'apiary', 'trigger-fail'));
  const host = new GraphHost({
    workspace: env.workspace,
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
    workspace: env.workspace,
    registry: env.registry,
    now: clock.now,
    honeyForGraph: storeFor,
  });
  const plainHost = new GraphHost({
    workspace: env.workspace,
    registry: env.registry,
    now: clock.now,
  });
  const overrideHoney = HoneyStore.forComposition(root, 'apiary', 'override-ttl');
  const overrideHost = new GraphHost({
    workspace: env.workspace,
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
    workspace: env.workspace,
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
  assert.deepEqual(env.adapter.closedNativeIds, ['native-1', 'native-2', 'native-3']);
  assert.deepEqual(env.registry.list(), []);
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

test('a corrupt or unsupported Honey field fails load before creating a session', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-corrupt-'));
  const storeFor = (graphId: string): HoneyStore =>
    HoneyStore.forComposition(root, 'apiary', graphId);
  const host = new GraphHost({
    workspace: env.workspace,
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

test('a revision mismatch fails restore, releases fresh sessions and is not registered', async (t) => {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const root = mkdtempSync(join(tmpdir(), 'wax-m4b-revision-'));
  const honey = HoneyStore.forComposition(root, 'apiary', 'revision');
  const host = new GraphHost({
    workspace: env.workspace,
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
  const triggered = await host.trigger('revision', 'only', text('one'));
  assert.equal(triggered.persisted, true);
  assert.equal(await host.unload('revision'), true);

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
  assert.deepEqual(env.registry.list(), []);
  // Any fresh session created for the failed attempt was released again.
  assert.deepEqual(
    env.adapter.closedNativeIds,
    env.adapter.createdNativeIds.slice(0, createdBefore + 1),
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
    workspace: env.workspace,
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
    workspace: env.workspace,
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
    workspace: env.workspace,
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
  const triggered = await host.trigger('keep-once', 'only', text('one'));
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
