import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions } from '../src/adapters/harness.js';
import {
  EphemeralRunUnsupportedError,
  runEphemeralGraph,
  type EphemeralRunOptions,
} from '../src/daemon/ephemeral-run.js';
import type { GraphBindings } from '../src/graph/binding.js';
import { createKernel, type Project } from '../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type NodeDefinition,
  type NodeId,
} from '../src/runtime/index.js';
import { HoneyStore } from '../src/storage/honey.js';
import { FakeAdapter } from './support/fake-adapter.js';

/**
 * FakeAdapter plus native lifecycle recording. `startCalls`/`stopCalls` come
 * from the base class; the created/closed native ids prove that an ephemeral
 * run closes exactly the sessions it created.
 */
class RecordingAdapter extends FakeAdapter {
  readonly createdNativeIds: string[] = [];
  readonly closedNativeIds: string[] = [];

  override async createConversation(
    project: Project,
    options?: ConversationOptions,
  ): Promise<string> {
    const nativeId = await super.createConversation(project, options);
    this.createdNativeIds.push(nativeId);
    return nativeId;
  }

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
    await super.closeConversation(nativeId);
  }
}

function forager(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'codex', prompt } };
}

/**
 * Validates the graph with parseComposition, then rewrites node pacing to 0 so
 * one trigger reaches Rest without sleeping.
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

function bindingsFor(definition: CompositionDefinition): GraphBindings {
  const bindings: Record<string, { readonly kind: 'fresh' }> = {};
  for (const node of definition.nodes.values()) {
    if (node.kind === 'forager') {
      bindings[node.id] = { kind: 'fresh' };
    }
  }
  return bindings;
}

interface Env {
  readonly options: EphemeralRunOptions;
  readonly stateRoot: string;
  readonly apiary: string;
}

function makeEnv(
  adapter: FakeAdapter,
  definition: CompositionDefinition,
  overrides: Partial<EphemeralRunOptions> = {},
): Env {
  const project = createKernel().registerProject(
    mkdtempSync(join(tmpdir(), 'wax-eph-project-')),
  );
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-eph-state-'));
  const apiary = 'test-apiary';
  return {
    stateRoot,
    apiary,
    options: {
      adapter,
      definition,
      project,
      bindings: bindingsFor(definition),
      input: 'hello',
      stateRoot,
      apiary,
      ...overrides,
    },
  };
}

/** start -> counter(max 1) -> done; the continue branch loops back to count. */
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

test('runs a headless forager graph, persists Honey and closes its session', async () => {
  const adapter = new RecordingAdapter({ output: 'EPHEMERAL-OUT' });
  const definition = fastDefinition('eph-forager', { start: forager('go {{input}}') });
  const env = makeEnv(adapter, definition);

  const result = await runEphemeralGraph({ ...env.options, trigger: 'start' });

  assert.equal(result.status.rest, true);
  assert.equal(result.status.hovered, false);
  assert.equal(result.persisted, true);
  assert.deepEqual([...result.outputs.keys()], ['start']);
  assert.deepEqual(result.outputs.get('start'), { kind: 'text', text: 'EPHEMERAL-OUT' });
  assert.deepEqual(adapter.prompts, ['go hello']);
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(adapter.createdNativeIds.length, 1);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);

  const saved = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id).load();
  assert.ok(saved !== undefined, 'the ephemeral run left a Honey field');
  assert.equal(saved.rest, true);
  assert.deepEqual(
    readdirSync(env.stateRoot),
    ['apiaries'],
    'no session store was created under the state root',
  );
});

test('runs a worker and condition graph without creating a session', async () => {
  const adapter = new RecordingAdapter();
  const definition = fastDefinition(
    'eph-worker',
    {
      start: {
        kind: 'worker',
        config: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("GO")'],
        },
      },
      check: { kind: 'condition', config: { mode: 'text', contains: 'GO' } },
      yes: {
        kind: 'worker',
        config: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("YES")'],
        },
      },
      no: {
        kind: 'worker',
        config: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("NO")'],
        },
      },
    },
    [
      { id: 'e1', from: 'start', to: 'check' },
      { id: 'e2', from: 'check', to: 'yes', when: 'true' },
      { id: 'e3', from: 'check', to: 'no', when: 'false' },
    ],
  );
  const env = makeEnv(adapter, definition);

  const result = await runEphemeralGraph({ ...env.options, trigger: 'start' });

  assert.equal(result.status.rest, true);
  assert.equal(result.outputs.size, 0, 'no forager ran, so there is no output');
  assert.equal(adapter.createdNativeIds.length, 0);
  assert.equal(adapter.closedNativeIds.length, 0);
  assert.equal(adapter.stopCalls, 1);
});

test('cleans up the adapter, workspace and session when the trigger fails', async () => {
  const adapter = new RecordingAdapter({ terminal: 'failed', error: 'native boom' });
  const definition = fastDefinition('eph-fail', { start: forager('go') });
  const env = makeEnv(adapter, definition);

  await assert.rejects(
    runEphemeralGraph({ ...env.options, trigger: 'start' }),
    /native boom/,
  );

  assert.equal(adapter.stopCalls, 1);
  assert.equal(adapter.createdNativeIds.length, 1);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);
  const saved = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id).load();
  assert.ok(saved !== undefined, 'the failed run still flushed its field in cleanup');
  assert.equal(saved.rest, true);
});

test('starts from a fresh field by default and ignores persisted Honey', async () => {
  const adapter = new RecordingAdapter({ output: 'OUT' });
  const definition = counterDefinition('eph-fresh');
  const env = makeEnv(adapter, definition);
  const store = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id);
  store.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: true,
    nodes: { count: { queue: [], state: { count: 7 } } },
  });

  const result = await runEphemeralGraph({ ...env.options, trigger: 'start' });

  assert.equal(result.status.rest, true);
  const saved = store.load();
  assert.ok(saved !== undefined);
  assert.equal(
    saved.nodes['count']?.state?.['count'],
    1,
    'the counter started at 1 instead of resuming the persisted 7',
  );
});

test('stops the adapter when load fails before any session is created', async () => {
  const adapter = new RecordingAdapter();
  const definition = fastDefinition('eph-load-fail', { start: forager('go') });
  const env = makeEnv(adapter, definition, {
    bindings: { start: { kind: 'session', sessionId: 'ghost-session' } },
  });

  await assert.rejects(
    runEphemeralGraph({ ...env.options, trigger: 'start' }),
    /Bindings are invalid/,
  );

  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(adapter.createdNativeIds.length, 0);
});

test('rejects a user node before the adapter starts', async () => {
  const adapter = new RecordingAdapter();
  const definition = fastDefinition('eph-user', {
    ask: { kind: 'user', config: { modality: 'text', prompt: 'Approve?' } },
  });
  const env = makeEnv(adapter, definition);

  await assert.rejects(
    runEphemeralGraph({ ...env.options, trigger: 'ask' }),
    (error: unknown) =>
      error instanceof EphemeralRunUnsupportedError && error.reason === 'user-node',
  );
  assert.equal(adapter.startCalls, 0);
  assert.equal(adapter.createdNativeIds.length, 0);
});

test('rejects non-forager/worker triggers and missing bindings before start', async () => {
  const adapter = new RecordingAdapter();
  const definition = fastDefinition(
    'eph-trigger',
    {
      check: { kind: 'condition', config: { mode: 'text', contains: 'x' } },
      yes: forager('yes'),
      no: forager('no'),
    },
    [
      { id: 'e1', from: 'check', to: 'yes', when: 'true' },
      { id: 'e2', from: 'check', to: 'no', when: 'false' },
    ],
  );
  const triggerEnv = makeEnv(adapter, definition);

  await assert.rejects(
    runEphemeralGraph({ ...triggerEnv.options, trigger: 'check' }),
    (error: unknown) =>
      error instanceof EphemeralRunUnsupportedError && error.reason === 'trigger',
  );
  assert.equal(adapter.startCalls, 0);

  const bindingEnv = makeEnv(adapter, fastDefinition('eph-binding', { start: forager('go') }), {
    bindings: {},
  });
  await assert.rejects(
    runEphemeralGraph({ ...bindingEnv.options, trigger: 'start' }),
    (error: unknown) =>
      error instanceof EphemeralRunUnsupportedError && error.reason === 'missing-binding',
  );
  assert.equal(adapter.startCalls, 0);
});

test('rejects a native approval by default instead of auto-allowing it', async () => {
  const adapter = new RecordingAdapter({ askApproval: true, output: 'GUARD-REJECTED' });
  const definition = fastDefinition('eph-guard', { start: forager('go') });
  const env = makeEnv(adapter, definition);

  const result = await runEphemeralGraph({ ...env.options, trigger: 'start' });

  assert.deepEqual(
    adapter.approvals.map((decision) => decision.kind),
    ['reject_once'],
  );
  assert.equal(result.status.rest, true);
  assert.equal(result.status.hovered, false);
});

test('runs fork and merge nodes through the ephemeral path', async () => {
  const adapter = new RecordingAdapter({ output: 'BR' });
  const definition = fastDefinition(
    'eph-fork',
    {
      start: forager('start'),
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'left' },
            { id: 'b', to: 'right' },
          ],
        },
      },
      left: forager('left {{input}}'),
      right: forager('right {{input}}'),
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: forager('done {{input}}'),
    },
    [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'left', to: 'merge' },
      { id: 'e3', from: 'right', to: 'merge' },
      { id: 'e4', from: 'merge', to: 'done' },
    ],
  );
  const env = makeEnv(adapter, definition);

  const result = await runEphemeralGraph({ ...env.options, trigger: 'start' });

  assert.equal(result.status.rest, true);
  assert.deepEqual([...result.outputs.keys()], ['start', 'left', 'right', 'done']);
  assert.ok(adapter.prompts.includes('done BR\nBR'), 'the merge combined both branches');
  assert.equal(adapter.createdNativeIds.length, 4);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);
});

test('keeps each ephemeral run isolated from the previous one', async () => {
  const adapter = new RecordingAdapter({ output: 'ONCE' });
  const definition = fastDefinition('eph-unload', { start: forager('go') });
  const env = makeEnv(adapter, definition);

  const first = await runEphemeralGraph({ ...env.options, trigger: 'start' });
  assert.equal(first.outputs.size, 1);

  const second = await runEphemeralGraph({ ...env.options, trigger: 'start' });
  assert.equal(second.outputs.size, 1, 'the second run does not inherit the first output');
  assert.deepEqual(adapter.prompts, ['go', 'go']);
});
