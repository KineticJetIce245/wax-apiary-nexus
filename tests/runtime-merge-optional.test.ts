import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPLETED_JOIN_TTL_MS,
  createMemoryLog,
  MAX_COMPLETED_JOINS_PER_MERGE,
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  type NodeExecutor,
  type PersistedField,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-05-01T00:00:00.000Z');

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
      return output === undefined ? input : output(node.id, input);
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

/** start -> fork (a->merge required, b->ask->merge optional); merge -> done */
function lateOptionalComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-late',
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
      merge: { kind: 'merge', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a->ask->merge required, b->merge optional); merge -> done */
function optionalFirstComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-first',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'ask' },
            { id: 'b', to: 'merge' },
          ],
        },
      },
      merge: { kind: 'merge', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'A?' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

/**
 * start -> fork (o1,o2 -> merge optional; x,y -> merge required).
 * Merge config order is required [y,x] then optional [o2,o1], while arrival
 * order is o1,o2,x,y, so the test proves config order wins.
 */
function combineOrderComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-combine-order',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'o1', to: 'make-o1' },
            { id: 'o2', to: 'make-o2' },
            { id: 'x', to: 'make-x' },
            { id: 'y', to: 'make-y' },
          ],
        },
      },
      'make-o1': { kind: 'forager', config: { connection: 'codex', prompt: 'o1' } },
      'make-o2': { kind: 'forager', config: { connection: 'codex', prompt: 'o2' } },
      'make-x': { kind: 'forager', config: { connection: 'codex', prompt: 'x' } },
      'make-y': { kind: 'forager', config: { connection: 'codex', prompt: 'y' } },
      merge: {
        kind: 'merge',
        config: { required: ['y', 'x'], optional: ['o2', 'o1'], combine: 'text' },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make-o1', to: 'merge' },
      { id: 'e3', from: 'make-o2', to: 'merge' },
      { id: 'e4', from: 'make-x', to: 'merge' },
      { id: 'e5', from: 'make-y', to: 'merge' },
      { id: 'e6', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a->merge required, b->boom optional); merge -> done */
function optionalFailureComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-failure',
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
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      merge: { kind: 'merge', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a,c -> merge required, b -> make-b -> merge optional); merge -> done */
function optionalUnknownComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-unknown',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'make-b' },
            { id: 'c', to: 'merge' },
          ],
        },
      },
      'make-b': { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
      merge: {
        kind: 'merge',
        config: { required: ['a', 'c'], optional: ['b'], combine: 'text' },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make-b', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a,b -> merge required); merge -> done. No optional branch. */
function directMergeComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'direct-merge',
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
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

function completedJoinOf(snapshot: ReturnType<PheromoneRuntime['snapshot']>) {
  return Object.values(snapshot.nodes['merge']?.joins ?? {})[0];
}

test('required branches complete immediately without waiting for an optional one', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(lateOptionalComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1, 'the merge emitted without the optional branch');
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'seed');
  assert.ok(runtime.snapshot().nodes['ask']?.hover !== undefined, 'the optional branch still hovers');

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false, 'the hover on the optional branch still exists');
  const completed = completedJoinOf(snapshot);
  assert.ok(completed !== undefined);
  assert.ok(completed.completedAt !== undefined);
  assert.deepEqual(completed.arrived, []);
  assert.equal(
    log.entries.filter((entry) => entry.event === 'merge.completed').length,
    1,
  );
});

test('an optional branch that arrives first waits for required, then combines', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(optionalFirstComposition(), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const waitingJoin = Object.values(waiting.nodes['merge']?.joins ?? {})[0];
  assert.ok(waitingJoin !== undefined);
  assert.equal(waitingJoin.completedAt, undefined);
  assert.deepEqual(
    waitingJoin.arrived.map((pheromone) => pheromone.branchId),
    ['b'],
  );

  const token = runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('ask', text('A'), token);
  clock += 1000;
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'A\nseed');
  assert.equal(runtime.snapshot().rest, true);
  assert.ok(completedJoinOf(runtime.snapshot())?.completedAt !== undefined);
});

test('text combine uses required order, then arrived optional in optional config order', async () => {
  let clock = START;
  const { executor, calls } = recorder((nodeId) => {
    switch (nodeId) {
      case 'make-x':
        return text('X');
      case 'make-y':
        return text('Y');
      case 'make-o1':
        return text('O1');
      case 'make-o2':
        return text('O2');
      default:
        return text('seed');
    }
  });
  const runtime = new PheromoneRuntime(combineOrderComposition(), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  for (let step = 0; step < 3; step += 1) {
    clock += 1000;
    await runtime.pump();
  }

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'Y\nX\nO2\nO1');
  assert.equal(runtime.snapshot().rest, true);
});

test('an optional branch failure is logged and does not fail the required set', async () => {
  const log = createMemoryLog();
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push(node.id);
      if (node.id === 'boom') {
        throw new Error('optional branch exploded');
      }
      return input;
    },
  };
  const runtime = new PheromoneRuntime(optionalFailureComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  assert.deepEqual(calls, ['start', 'boom', 'done']);
  const doneCalls = calls.filter((nodeId) => nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(runtime.snapshot().rest, true);
  assert.ok(log.entries.some((entry) => entry.event === 'node.failed' && entry.nodeId === 'boom'));
  const optionalFailure = log.entries.find((entry) => entry.event === 'merge.optional-failed');
  assert.ok(optionalFailure !== undefined);
  assert.equal(optionalFailure.nodeId, 'merge');
  assert.equal(optionalFailure.branchId, 'b');
  assert.equal(optionalFailure.outcome, 'failed-branch');
  assert.equal(
    log.entries.filter((entry) => entry.event === 'merge.failed').length,
    0,
    'an optional-only failure never fails the join',
  );
});

test('an unknown optional branch on restore is logged and does not fail the join', async () => {
  const log = createMemoryLog();
  const definition = optionalUnknownComposition();
  const field: PersistedField = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.nodes['merge'] = {
    queue: [branchPheromone('fk_unknown_optional', 'c', text('C'))],
    joins: {
      fk_unknown_optional: {
        arrived: [branchPheromone('fk_unknown_optional', 'a', text('A'))],
        deadlineAt: START + 3_600_000,
      },
    },
  };
  field.nodes['make-b'] = { queue: [], active: branchPheromone('fk_unknown_optional', 'b') };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
    onLog: log.sink,
  });
  assert.deepEqual(report.unknownActive, ['make-b']);

  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  const completed = completedJoinOf(snapshot);
  assert.ok(completed !== undefined, 'the required set still completed the join');
  assert.ok(completed.completedAt !== undefined);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.optional-failed'));
  assert.equal(
    log.entries.filter((entry) => entry.event === 'merge.failed').length,
    0,
  );
  // The restored queue still carried required branch c, so the merge completed.
  assert.equal(
    log.entries.filter((entry) => entry.event === 'merge.completed').length,
    1,
  );
});

test('a late optional branch is dropped and logged without reopening the join', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(lateOptionalComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const completed = completedJoinOf(runtime.snapshot());
  assert.ok(completed?.completedAt !== undefined);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);

  const token = runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('ask', text('late'), token);
  clock += 1000;
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1, 'no second emit');
  assert.equal(
    log.entries.filter((entry) => entry.event === 'merge.completed').length,
    1,
  );
  const dropped = log.entries.find((entry) => entry.event === 'merge.optional-dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.nodeId, 'merge');
  assert.equal(dropped.forkId, completed.forkId);
  assert.equal(dropped.branchId, 'b');
  assert.equal(dropped.outcome, 'late-optional');
  assert.equal(runtime.snapshot().rest, true);
  const after = runtime.snapshot().nodes['merge']?.joins ?? {};
  assert.equal(Object.keys(after).length, 1);
  assert.ok(Object.values(after)[0]?.completedAt !== undefined);
});

test('a late required branch is a protocol error and never emits a second time', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor } = recorder();
  const definition = directMergeComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  clock += 1000;
  await runtime.pump();
  const firstForkId = completedJoinOf(runtime.snapshot())?.forkId;
  assert.ok(firstForkId !== undefined);

  const field = runtime.exportField();
  const mergeState = field.nodes['merge'];
  assert.ok(mergeState !== undefined);
  mergeState.queue.push(branchPheromone(firstForkId, 'a', text('again')));

  const calls: string[] = [];
  const restored = PheromoneRuntime.restore(definition, field, {
    executeForager: {
      async execute(node, input) {
        calls.push(node.id);
        return input;
      },
    },
    // The merge is rate-limited after its completion; one interval later the
    // queued late branch is due.
    now: () => clock + 1000,
    onLog: log.sink,
  });

  await restored.runtime.pump();

  assert.deepEqual(calls, [], 'a late required branch has no second emit');
  assert.equal(log.entries.filter((entry) => entry.event === 'merge.completed').length, 0);
  const failure = log.entries.find(
    (entry) => entry.event === 'merge.failed' && entry.outcome === 'late-required',
  );
  assert.ok(failure !== undefined);
  assert.equal(failure.branchId, 'a');
  assert.equal(failure.forkId, firstForkId);
  assert.equal(restored.runtime.snapshot().rest, true);
  assert.ok(completedJoinOf(restored.runtime.snapshot())?.completedAt !== undefined);
});

test('completed joins are bounded by count, keeping the newest markers', async () => {
  let clock = START;
  const definition = directMergeComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => clock,
  });

  const completeOne = async (): Promise<void> => {
    runtime.trigger('start', text('seed'));
    let guard = 0;
    while (!runtime.snapshot().rest) {
      clock += 1000;
      await runtime.pump();
      guard += 1;
      assert.ok(guard < 10, 'a merge cycle should settle quickly');
    }
  };

  await completeOne();
  const oldestForkId = completedJoinOf(runtime.snapshot())?.forkId;
  assert.ok(oldestForkId !== undefined);
  const total = MAX_COMPLETED_JOINS_PER_MERGE + 2;
  for (let index = 1; index < total; index += 1) {
    await completeOne();
  }

  const joins = runtime.snapshot().nodes['merge']?.joins ?? {};
  assert.equal(Object.keys(joins).length, MAX_COMPLETED_JOINS_PER_MERGE);
  assert.equal(joins[oldestForkId], undefined, 'the oldest marker was evicted');
  assert.ok(completedJoinOf(runtime.snapshot())?.completedAt !== undefined);
});

test('expired completed joins are pruned on the next merge activity', async () => {
  let clock = START;
  const definition = directMergeComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => clock,
  });

  const settle = async (): Promise<void> => {
    let guard = 0;
    while (!runtime.snapshot().rest) {
      clock += 1000;
      await runtime.pump();
      guard += 1;
      assert.ok(guard < 10, 'a merge cycle should settle quickly');
    }
  };

  runtime.trigger('start', text('one'));
  await settle();
  const staleForkId = completedJoinOf(runtime.snapshot())?.forkId;
  assert.ok(staleForkId !== undefined);

  clock += COMPLETED_JOIN_TTL_MS + 1000;
  runtime.trigger('start', text('two'));
  await settle();

  const joins = runtime.snapshot().nodes['merge']?.joins ?? {};
  assert.equal(joins[staleForkId], undefined);
  assert.equal(Object.keys(joins).length, 1);
});

test('restore prunes a completed marker that outlived its retention', () => {
  const definition = directMergeComposition();
  const field = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.nodes['merge'] = {
    queue: [],
    joins: {
      fk_expired: {
        arrived: [],
        completedAt: new Date(START).toISOString(),
      },
    },
  };
  field.rest = true;

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START + COMPLETED_JOIN_TTL_MS + 1000,
  });

  assert.equal(runtime.snapshot().nodes['merge']?.joins, undefined);
  assert.equal(runtime.snapshot().rest, true);
});
