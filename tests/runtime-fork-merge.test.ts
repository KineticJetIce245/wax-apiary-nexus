import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  type NodeExecutor,
  type PersistedField,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-04-01T00:00:00.000Z');

function text(value: string): Value {
  return { kind: 'text', text: value };
}

interface Recorder {
  readonly executor: NodeExecutor;
  readonly calls: { nodeId: string; input: Value }[];
}

function recorder(output?: (nodeId: string, input: Value) => Value): Recorder {
  const calls: { nodeId: string; input: Value }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push({ nodeId: node.id, input });
      if (output !== undefined) {
        return output(node.id, input);
      }
      return input;
    },
  };
  return { executor, calls };
}

function branchPheromone(
  forkId: string,
  branchId: string,
  value: Value = text('x'),
): Pheromone {
  return {
    id: `ph_${forkId}_${branchId}`,
    traceId: `tr_${forkId}`,
    forkId,
    branchId,
    value,
    at: new Date(START).toISOString(),
  };
}

/** start -> fork (a->merge, b->ask, c->ask-c) */
function fanoutComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'fanout',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'ask-a' },
            { id: 'b', to: 'ask-b' },
            { id: 'c', to: 'ask-c' },
          ],
        },
      },
      'ask-a': { kind: 'user', config: { modality: 'text', prompt: 'A?' } },
      'ask-b': { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      'ask-c': { kind: 'user', config: { modality: 'text', prompt: 'C?' } },
    },
    edges: [{ id: 'e1', from: 'start', to: 'fork' }],
  });
}

/** start -> fork (a->merge, b->ask); ask -> merge; merge -> done */
function humanMergeComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'human-merge',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (x->make-x, y->make-y); both -> merge (required y,x); merge -> done */
function combineOrderComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'combine-order',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'x', to: 'make-x' },
            { id: 'y', to: 'make-y' },
          ],
        },
      },
      'make-x': { kind: 'forager', config: { connection: 'codex', prompt: 'x' } },
      'make-y': { kind: 'forager', config: { connection: 'codex', prompt: 'y' } },
      merge: { kind: 'merge', config: { required: ['y', 'x'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make-x', to: 'merge' },
      { id: 'e3', from: 'make-y', to: 'merge' },
      { id: 'e4', from: 'merge', to: 'done' },
    ],
  });
}

/** start1/start2 -> fork (a->merge, b->ask); ask -> merge; merge -> done */
function interleavedComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'interleaved',
    nodes: {
      start1: { kind: 'forager', config: { connection: 'codex', prompt: 'one' } },
      start2: { kind: 'forager', config: { connection: 'codex', prompt: 'two' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start1', to: 'fork' },
      { id: 'e2', from: 'start2', to: 'fork' },
      { id: 'e3', from: 'ask', to: 'merge' },
      { id: 'e4', from: 'merge', to: 'done' },
    ],
  });
}

/** A branch target of 'branch-b' for restore tests. */
function branchWorkComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'branch-work',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'make-b' },
          ],
        },
      },
      'make-b': { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make-b', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

test('fork consumes one Pheromone and emits one tagged copy per branch', async () => {
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(fanoutComposition(), {
    executeForager: executor,
    now: () => START,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ['start'],
    'only the source forager ran; the fork is a control step',
  );
  assert.equal(snapshot.pheromones.length, 3);
  assert.equal(snapshot.rest, false);

  const byBranch = new Map(
    snapshot.pheromones.map((pheromone) => [pheromone.branchId, pheromone]),
  );
  const a = byBranch.get('a');
  const b = byBranch.get('b');
  const c = byBranch.get('c');
  assert.ok(a !== undefined);
  assert.ok(b !== undefined);
  assert.ok(c !== undefined);
  assert.match(a.forkId ?? '', /^fk_/);
  assert.equal(a.forkId, b.forkId);
  assert.equal(a.forkId, c.forkId);
  assert.deepEqual([a.value, b.value, c.value], [text('seed'), text('seed'), text('seed')]);

  runtime.answerHover('ask-a', text('A'));
  runtime.answerHover('ask-b', text('B'));
  runtime.answerHover('ask-c', text('C'));
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, true);
});

test('merge waits for every required branch and emits exactly once', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(humanMergeComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const mergeState = waiting.nodes['merge'];
  assert.ok(mergeState !== undefined);
  const joins = mergeState.joins ?? {};
  const forkIds = Object.keys(joins);
  assert.equal(forkIds.length, 1);
  const join = joins[forkIds[0] ?? ''];
  assert.ok(join !== undefined);
  assert.equal(join.arrived.length, 1);
  assert.equal(join.arrived[0]?.branchId, 'a');
  assert.ok(log.entries.some((entry) => entry.event === 'merge.waiting'));

  const token = waiting.nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('ask', text('reply'), token);
  clock += 1000;
  await runtime.pump();

  const finished = runtime.snapshot();
  assert.equal(finished.rest, true);
  assert.deepEqual(finished.pheromones, [], 'the required branches were consumed atomically');
  assert.equal(finished.nodes['merge']?.joins, undefined);
  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'seed\nreply');
  assert.ok(log.entries.some((entry) => entry.event === 'merge.completed'));

  const mergeOutput = log.entries
    .filter((entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done')
    .at(-1);
  assert.ok(mergeOutput !== undefined);
  assert.equal(mergeOutput.forkId, undefined);
  assert.equal(mergeOutput.branchId, undefined);
});

test('text combine follows the required order, not arrival order', async () => {
  let clock = START;
  const { executor, calls } = recorder((nodeId) => {
    if (nodeId === 'make-x') {
      return text('X');
    }
    if (nodeId === 'make-y') {
      return text('Y');
    }
    return text('ok');
  });
  const runtime = new PheromoneRuntime(combineOrderComposition(), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);

  clock += 1000;
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'Y\nX');
  assert.equal(runtime.snapshot().rest, true);
});

test('two forkIds interleave at one merge without mixing groups', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(interleavedComposition(), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start1', text('one'));
  await runtime.pump();
  clock += 1000;
  runtime.trigger('start2', text('two'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  const joins = waiting.nodes['merge']?.joins ?? {};
  const forkIds = Object.keys(joins);
  assert.equal(forkIds.length, 2, 'each forkId gets its own join');
  const values = forkIds.map((forkId) => {
    const join = joins[forkId];
    assert.ok(join !== undefined);
    assert.equal(join.arrived.length, 1);
    return serializeValue(join.arrived[0]?.value as Value);
  });
  assert.deepEqual(values.sort(), ['one', 'two']);
  assert.equal(waiting.rest, false);

  runtime.answerHover('ask', text('reply-one'));
  clock += 1000;
  await runtime.pump();
  const token = runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(token !== undefined, 'the second queued branch now hovers');
  runtime.answerHover('ask', text('reply-two'), token);
  clock += 1000;
  await runtime.pump();

  const doneInputs = calls
    .filter((call) => call.nodeId === 'done')
    .map((call) => serializeValue(call.input));
  assert.deepEqual(doneInputs, ['one\nreply-one', 'two\nreply-two']);
  assert.equal(runtime.snapshot().rest, true);
});

test('a missing required branch fails the merge instead of leaving a dead join', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'missing-branch',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'sink' },
          ],
        },
      },
      sink: { kind: 'forager', config: { connection: 'codex', prompt: 'sink' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['merge']?.joins, undefined);
  assert.equal(snapshot.rest, true);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'missing-branch');
});

test('a failed branch fails the merge, cancels siblings and is never replayed', async () => {
  const log = createMemoryLog();
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push(node.id);
      if (node.id === 'boom') {
        throw new Error('branch exploded');
      }
      return input;
    },
  };
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'failed-branch',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'boom' },
          ],
        },
      },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await assert.rejects(runtime.pump(), /branch exploded/);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['merge']?.joins, undefined);
  assert.equal(snapshot.rest, true);
  assert.deepEqual(calls, ['start', 'boom']);
  assert.equal(calls.filter((call) => call === 'done').length, 0);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'failed-branch');
});

test('an unknown active branch found on restore fails its join', () => {
  const log = createMemoryLog();
  const definition = branchWorkComposition();
  const field: PersistedField = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.nodes['merge'] = {
    queue: [],
    joins: { fk_restore: { arrived: [branchPheromone('fk_restore', 'a')] } },
  };
  field.nodes['make-b'] = {
    queue: [],
    active: branchPheromone('fk_restore', 'b'),
  };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
    onLog: log.sink,
  });

  assert.deepEqual(report.unknownActive, ['make-b']);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['merge']?.joins, undefined);
  assert.equal(snapshot.rest, true);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'unknown-active');
});

test('a duplicate branch arrival is rejected and fails the join', async () => {
  const log = createMemoryLog();
  const definition = branchWorkComposition();
  const field: PersistedField = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.nodes['merge'] = {
    queue: [branchPheromone('fk_duplicate', 'a')],
    joins: { fk_duplicate: { arrived: [branchPheromone('fk_duplicate', 'a')] } },
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
    onLog: log.sink,
  });
  assert.equal(runtime.snapshot().rest, false);

  await runtime.pump();

  assert.equal(runtime.snapshot().nodes['merge']?.joins, undefined);
  assert.equal(runtime.snapshot().rest, true);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'duplicate-branch');
});

test('Rest stays false while a restored join is incomplete', () => {
  const definition = branchWorkComposition();
  const field: PersistedField = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.nodes['merge'] = {
    queue: [],
    joins: { fk_wait: { arrived: [branchPheromone('fk_wait', 'a')] } },
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false);
  assert.equal(Object.keys(snapshot.nodes['merge']?.joins ?? {}).length, 1);
  assert.equal(snapshot.pheromones.length, 1);
});

test('a restored complete join settles once without replaying its branches', async () => {
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push(node.id);
      return input;
    },
  };
  const definition = branchWorkComposition();
  const field: PersistedField = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
  }).exportField();
  field.nodes['merge'] = {
    queue: [],
    joins: {
      fk_complete: {
        arrived: [
          branchPheromone('fk_complete', 'a', text('A')),
          branchPheromone('fk_complete', 'b', text('B')),
        ],
      },
    },
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor,
    now: () => START,
  });
  await runtime.pump();

  const doneCalls = calls.filter((call) => call === 'done');
  assert.deepEqual(doneCalls, ['done']);
  assert.equal(runtime.snapshot().rest, true);
  assert.equal(runtime.snapshot().pheromones.length, 0);
});

test('fork copies a non-text Value unchanged', async () => {
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(fanoutComposition(), {
    executeForager: executor,
    now: () => START,
  });

  runtime.trigger('start', { kind: 'boolean', value: true });
  await runtime.pump();

  const values = runtime.snapshot().pheromones.map((pheromone) => pheromone.value);
  assert.deepEqual(values, [
    { kind: 'boolean', value: true },
    { kind: 'boolean', value: true },
    { kind: 'boolean', value: true },
  ]);
});

test('a merge without an outgoing edge is terminal', async () => {
  const { executor, calls } = recorder();
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'terminal-merge',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'merge' },
          ],
        },
      },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    edges: [{ id: 'e1', from: 'start', to: 'fork' }],
  });
  let clock = START;
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  assert.deepEqual(calls.map((call) => call.nodeId), ['start']);
  assert.equal(runtime.snapshot().rest, true);
  assert.deepEqual(runtime.snapshot().pheromones, []);
});

test('an unexpected branch arrival fails the merge and cancels siblings', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'unknown-branch',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'merge' },
          ],
        },
      },
      merge: { kind: 'merge', config: { required: ['a', 'c'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  assert.equal(runtime.snapshot().nodes['merge']?.joins, undefined);
  assert.equal(runtime.snapshot().rest, true);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'unknown-branch');
});

test('a failed branch cancels a sibling waiting in a user hover', async () => {
  const log = createMemoryLog();
  const executor: NodeExecutor = {
    async execute(node, input) {
      if (node.id === 'boom') {
        throw new Error('branch exploded');
      }
      return input;
    },
  };
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'cancel-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'boom' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await assert.rejects(runtime.pump(), /branch exploded/);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['ask']?.hover, undefined);
  assert.equal(snapshot.nodes['ask']?.queue.length, 0);
  assert.equal(snapshot.rest, true);
  assert.ok(log.entries.some((entry) => entry.event === 'hover.cancelled'));
});
