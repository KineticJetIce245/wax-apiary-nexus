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
  type GuardDecision,
  type HoverSpec,
  type NodeDefinition,
  type NodeId,
  type UserNode,
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

/** start -> ask (user) -> done. The answer is the `done` prompt input. */
function askDefinition(id: string): CompositionDefinition {
  return fastDefinition(
    id,
    {
      start: forager('start {{input}}'),
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Approve?' } },
      done: forager('done {{input}}'),
    },
    [
      { id: 'e1', from: 'start', to: 'ask' },
      { id: 'e2', from: 'ask', to: 'done' },
    ],
  );
}

/** start -> ask1 -> ask2 -> done: two consecutive user hovers. */
function twoHoverDefinition(id: string): CompositionDefinition {
  return fastDefinition(
    id,
    {
      start: forager('start {{input}}'),
      ask1: { kind: 'user', config: { modality: 'text', prompt: 'First?' } },
      ask2: { kind: 'user', config: { modality: 'text', prompt: 'Second?' } },
      done: forager('done {{input}}'),
    },
    [
      { id: 'e1', from: 'start', to: 'ask1' },
      { id: 'e2', from: 'ask1', to: 'ask2' },
      { id: 'e3', from: 'ask2', to: 'done' },
    ],
  );
}

/** ask loops through a counter `max` times, producing one user hover each round. */
function hoverLoopDefinition(id: string, max: number): CompositionDefinition {
  return fastDefinition(
    id,
    {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Again?' } },
      count: { kind: 'counter', config: { max, step: 1 } },
      done: forager('done {{input}}'),
    },
    [
      { id: 'e1', from: 'ask', to: 'count' },
      { id: 'e2', from: 'count', to: 'ask', when: 'continue' },
      { id: 'e3', from: 'count', to: 'done', when: 'done' },
    ],
  );
}

test('answers a user hover through askUser and reaches Rest', async () => {
  const adapter = new RecordingAdapter({ output: 'OUT' });
  const definition = askDefinition('eph-user-answer');
  const env = makeEnv(adapter, definition);
  const asked: { readonly node: UserNode; readonly hover: HoverSpec }[] = [];

  const result = await runEphemeralGraph({
    ...env.options,
    trigger: 'start',
    askUser: async (node, hover) => {
      asked.push({ node, hover });
      return { kind: 'text', text: 'HUMAN' };
    },
  });

  assert.equal(result.status.rest, true);
  assert.equal(result.status.hovered, false);
  assert.equal(result.persisted, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.node.id, 'ask');
  assert.equal(asked[0]?.node.config.prompt, 'Approve?');
  assert.equal(asked[0]?.hover.kind, 'user');
  assert.equal(asked[0]?.hover.nodeId, 'ask');
  assert.match(asked[0]?.hover.token ?? '', /^hv_/);
  assert.deepEqual(adapter.prompts, ['start hello', 'done HUMAN']);
  assert.equal(adapter.approvals.length, 0);
  assert.equal(adapter.createdNativeIds.length, 2);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);

  const saved = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id).load();
  assert.ok(saved !== undefined);
  assert.equal(saved.rest, true);
  assert.equal(saved.nodes['ask']?.hover, undefined);
});

test('answers consecutive user hovers one at a time', async () => {
  const adapter = new RecordingAdapter({ output: 'OUT' });
  const definition = twoHoverDefinition('eph-two-hovers');
  const env = makeEnv(adapter, definition);
  const askedNodeIds: string[] = [];

  const result = await runEphemeralGraph({
    ...env.options,
    trigger: 'start',
    askUser: async (node) => {
      askedNodeIds.push(node.id);
      return { kind: 'text', text: node.id === 'ask1' ? 'ONE' : 'TWO' };
    },
  });

  assert.equal(result.status.rest, true);
  assert.equal(result.status.hovered, false);
  assert.deepEqual(askedNodeIds, ['ask1', 'ask2']);
  assert.deepEqual(adapter.prompts, ['start hello', 'done TWO']);
});

test('fails instead of auto-answering a user hover when askUser is missing', async () => {
  const adapter = new RecordingAdapter({ output: 'OUT' });
  const definition = askDefinition('eph-user-no-handler');
  const env = makeEnv(adapter, definition);

  await assert.rejects(
    runEphemeralGraph({ ...env.options, trigger: 'start' }),
    (error: unknown) => {
      assert.ok(error instanceof EphemeralRunUnsupportedError);
      assert.equal(error.reason, 'user-node');
      assert.match(error.message, /'ask'/);
      assert.equal(error.message.includes('Approve?'), false, 'no prompt in the error');
      assert.equal(error.message.includes('hello'), false, 'no input value in the error');
      return true;
    },
  );

  // The run started, could not answer, and cleaned up without guessing a value.
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
  assert.deepEqual(adapter.prompts, ['start hello']);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);
  const saved = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id).load();
  assert.ok(saved !== undefined);
  assert.equal(saved.nodes['ask']?.hover?.kind, 'user', 'the hover is preserved, not answered');
  assert.equal(saved.rest, false);
});

test('decides a Guard through onGuard instead of rejecting it', async () => {
  const adapter = new RecordingAdapter({ askApproval: true, output: 'GUARDED' });
  const definition = fastDefinition('eph-guard-handler', { start: forager('go') });
  const env = makeEnv(adapter, definition);
  const decisions: GuardDecision[] = ['allow_once', 'reject_once'];

  const runOnce = async (): Promise<void> => {
    const result = await runEphemeralGraph({
      ...env.options,
      trigger: 'start',
      onGuard: async () => decisions.shift() ?? 'cancelled',
    });
    assert.equal(result.status.rest, true);
    assert.equal(result.status.hovered, false);
  };

  await runOnce();
  await runOnce();

  assert.deepEqual(
    adapter.approvals.map((decision) => decision.kind),
    ['allow_once', 'reject_once'],
  );
});

test('stops a graph that keeps re-hovering after the user-hover limit', async () => {
  const adapter = new RecordingAdapter({ output: 'OUT' });
  const definition = hoverLoopDefinition('eph-hover-loop', 20);
  const env = makeEnv(adapter, definition);
  let asked = 0;

  await assert.rejects(
    runEphemeralGraph({
      ...env.options,
      trigger: 'ask',
      askUser: async () => {
        asked += 1;
        return { kind: 'text', text: 'again' };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /did not settle after 16 user hovers/);
      assert.equal(error.message.includes('Again?'), false, 'no prompt in the error');
      assert.equal(error.message.includes('again'), false, 'no answer value in the error');
      return true;
    },
  );

  assert.equal(asked, 16, 'the limit is checked before asking a 17th time');
});

test('rejects a condition trigger and missing bindings before start', async () => {
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

test('resume drains the restored field instead of replaying a trigger', async () => {
  const adapter = new RecordingAdapter({ output: 'RESUMED-OUT' });
  const definition = fastDefinition('eph-resume-drain', { start: forager('go {{input}}') });
  const env = makeEnv(adapter, definition);
  const store = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id);
  store.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      start: {
        queue: [
          {
            id: 'ph_resume',
            traceId: 'tr_resume',
            value: { kind: 'text', text: 'queued' },
            at: new Date().toISOString(),
          },
        ],
      },
    },
  });

  const result = await runEphemeralGraph({ ...env.options, resume: true });

  assert.equal(result.status.rest, true);
  assert.equal(result.status.hovered, false);
  assert.deepEqual(adapter.prompts, ['go queued'], 'the restored work ran, no trigger');
  assert.deepEqual(result.outputs.get('start'), {
    kind: 'text',
    text: 'RESUMED-OUT',
  });
  assert.equal(result.persisted, true);
  assert.deepEqual(result.recovery, {
    resumedHovers: [],
    unknownActive: [],
    stuckActive: [],
  });
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(adapter.createdNativeIds.length, 1);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);

  const saved = store.load();
  assert.ok(saved !== undefined);
  assert.equal(saved.rest, true);
  assert.deepEqual(saved.nodes['start']?.queue, [], 'the queued work was drained');
});

test('resume without a Honey field fails before the adapter starts', async () => {
  const adapter = new RecordingAdapter();
  const definition = fastDefinition('eph-resume-missing', { start: forager('go') });
  const env = makeEnv(adapter, definition);

  await assert.rejects(
    runEphemeralGraph({ ...env.options, resume: true }),
    (error: unknown) => {
      assert.ok(error instanceof EphemeralRunUnsupportedError);
      assert.equal(error.reason, 'resume');
      assert.match(error.message, /nothing to resume/);
      assert.equal(error.message.includes('go'), false, 'no prompt in the error');
      return true;
    },
  );

  assert.equal(adapter.startCalls, 0);
  assert.equal(adapter.stopCalls, 0);
  assert.equal(adapter.createdNativeIds.length, 0);
});

test('resume answers a persisted user hover and reaches Rest', async () => {
  const adapter = new RecordingAdapter({ output: 'OUT' });
  const definition = askDefinition('eph-resume-hover');
  const env = makeEnv(adapter, definition);

  // Leave a parked user hover in Honey: the run starts and fails only when
  // the interactive answer is missing, and cleanup flushes the hover.
  await assert.rejects(
    runEphemeralGraph({
      ...env.options,
      trigger: 'start',
      askUser: async () => {
        throw new Error('no tty');
      },
    }),
    /no tty/,
  );
  const store = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id);
  const parked = store.load();
  assert.ok(parked !== undefined);
  assert.equal(parked.nodes['ask']?.hover?.kind, 'user');
  assert.deepEqual(adapter.prompts, ['start hello']);

  const asked: NodeId[] = [];
  const result = await runEphemeralGraph({
    ...env.options,
    resume: true,
    askUser: async (node) => {
      asked.push(node.id);
      return { kind: 'text', text: 'HUMAN' };
    },
  });

  assert.deepEqual(asked, ['ask']);
  assert.equal(result.status.rest, true);
  assert.equal(result.status.hovered, false);
  assert.deepEqual(result.recovery?.resumedHovers, ['ask']);
  assert.deepEqual(adapter.prompts, ['start hello', 'done HUMAN']);
  assert.equal(adapter.startCalls, 2);
  assert.equal(adapter.stopCalls, 2);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);
});

test('resume with a trigger restores the field and then triggers', async () => {
  const adapter = new RecordingAdapter({ output: 'OUT' });
  const definition = counterDefinition('eph-resume-trigger');
  const env = makeEnv(adapter, definition);
  const store = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id);
  store.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: true,
    nodes: { count: { queue: [], state: { count: 7 } } },
  });

  const result = await runEphemeralGraph({
    ...env.options,
    resume: true,
    trigger: 'start',
  });

  assert.equal(result.status.rest, true);
  assert.deepEqual(result.recovery, {
    resumedHovers: [],
    unknownActive: [],
    stuckActive: [],
  });
  assert.deepEqual(adapter.prompts, ['start hello', 'done OUT']);
  const saved = store.load();
  assert.ok(saved !== undefined);
  assert.equal(
    saved.nodes['count']?.state?.['count'],
    8,
    'the counter resumed at 7 and the explicit trigger advanced it',
  );
});

test('resume reports an unknown active forager and never replays it', async () => {
  const adapter = new RecordingAdapter({ output: 'REPLAYED' });
  const definition = fastDefinition('eph-resume-unknown', {
    only: forager('secret {{input}}'),
  });
  const env = makeEnv(adapter, definition);
  const store = HoneyStore.forComposition(env.stateRoot, env.apiary, definition.id);
  store.save({
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

  const result = await runEphemeralGraph({ ...env.options, resume: true });

  assert.deepEqual(result.recovery, {
    resumedHovers: [],
    unknownActive: ['only'],
    stuckActive: [],
  });
  assert.equal(result.status.rest, true);
  assert.deepEqual(adapter.prompts, [], 'the active execution was never replayed');
  assert.equal(result.outputs.size, 0);
  const serialized = JSON.stringify(result);
  for (const secret of ['SECRET-BODY', 'ph_live', 'tr_live']) {
    assert.equal(serialized.includes(secret), false, `result leaked '${secret}'`);
  }
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
  assert.deepEqual(adapter.closedNativeIds, adapter.createdNativeIds);
});
