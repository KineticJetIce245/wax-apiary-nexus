import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPLETED_GATHER_TTL_MS,
  createMemoryLog,
  MAX_COMPLETED_GATHERS,
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
  spreadId: string,
  branchId: string,
  value: Value = text('x'),
): Pheromone {
  return {
    id: `ph_${spreadId}_${branchId}`,
    spreadId,
    branchId,
    value,
    at: new Date(START).toISOString(),
  };
}

/** start -> spread (a->gather required, b->ask->gather optional); gather -> done */
function lateOptionalComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-late',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      gather: { kind: 'gather', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

/** start -> spread (a->ask->gather required, b->gather optional); gather -> done */
function optionalFirstComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-first',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'ask' },
            { id: 'b', to: 'gather' },
          ],
        },
      },
      gather: { kind: 'gather', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'A?' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

/**
 * start -> spread (o1,o2 -> gather optional; x,y -> gather required).
 * Gather config order is required [y,x] then optional [o2,o1], while arrival
 * order is o1,o2,x,y, so the test proves config order wins.
 */
function combineOrderComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-combine-order',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
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
      gather: {
        kind: 'gather',
        config: { required: ['y', 'x'], optional: ['o2', 'o1'], combine: 'text' },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'make-o1', to: 'gather' },
      { id: 'e3', from: 'make-o2', to: 'gather' },
      { id: 'e4', from: 'make-x', to: 'gather' },
      { id: 'e5', from: 'make-y', to: 'gather' },
      { id: 'e6', from: 'gather', to: 'done' },
    ],
  });
}

/** start -> spread (a->gather required, b->boom optional); gather -> done */
function optionalFailureComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-failure',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'boom' },
          ],
        },
      },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      gather: { kind: 'gather', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
    ],
  });
}

/** start -> spread (a,c -> gather required, b -> make-b -> gather optional); gather -> done */
function optionalUnknownComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-unknown',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'make-b' },
            { id: 'c', to: 'gather' },
          ],
        },
      },
      'make-b': { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
      gather: {
        kind: 'gather',
        config: { required: ['a', 'c'], optional: ['b'], combine: 'text' },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'make-b', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

/** start -> spread (a,b -> gather required); gather -> done. No optional branch. */
function directGatherComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'direct-gather',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'gather' },
          ],
        },
      },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
    ],
  });
}

function completedGatherOf(snapshot: ReturnType<PheromoneRuntime['snapshot']>) {
  return Object.values(snapshot.nodes['gather']?.gathers ?? {})[0];
}

test('required branches complete immediately without waiting for an optional one', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(lateOptionalComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1, 'the gather emitted without the optional branch');
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'seed');
  assert.ok(runtime.snapshot().nodes['ask']?.hover !== undefined, 'the optional branch still hovers');

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false, 'the hover on the optional branch still exists');
  const completed = completedGatherOf(snapshot);
  assert.ok(completed !== undefined);
  assert.ok(completed.completedAt !== undefined);
  assert.deepEqual(completed.arrived, []);
  assert.equal(
    log.entries.filter((entry) => entry.event === 'gather.completed').length,
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

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const waitingGather = Object.values(waiting.nodes['gather']?.gathers ?? {})[0];
  assert.ok(waitingGather !== undefined);
  assert.equal(waitingGather.completedAt, undefined);
  assert.deepEqual(
    waitingGather.arrived.map((pheromone) => pheromone.branchId),
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
  assert.ok(completedGatherOf(runtime.snapshot())?.completedAt !== undefined);
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

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
  await runtime.pump();

  assert.deepEqual(calls, ['start', 'boom', 'done']);
  const doneCalls = calls.filter((nodeId) => nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(runtime.snapshot().rest, true);
  assert.ok(log.entries.some((entry) => entry.event === 'node.failed' && entry.nodeId === 'boom'));
  const optionalFailure = log.entries.find((entry) => entry.event === 'gather.optional-failed');
  assert.ok(optionalFailure !== undefined);
  assert.equal(optionalFailure.nodeId, 'gather');
  assert.equal(optionalFailure.branchId, 'b');
  assert.equal(optionalFailure.outcome, 'failed-branch');
  assert.equal(
    log.entries.filter((entry) => entry.event === 'gather.failed').length,
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
  field.nodes['gather'] = {
    receptor: [branchPheromone('fk_unknown_optional', 'c', text('C'))],
    gathers: {
      fk_unknown_optional: {
        arrived: [branchPheromone('fk_unknown_optional', 'a', text('A'))],
        deadlineAt: START + 3_600_000,
      },
    },
  };
  field.nodes['make-b'] = { receptor: [], active: branchPheromone('fk_unknown_optional', 'b') };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
    onLog: log.sink,
  });
  assert.deepEqual(report.unknownActive, ['make-b']);

  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  const completed = completedGatherOf(snapshot);
  assert.ok(completed !== undefined, 'the required set still completed the join');
  assert.ok(completed.completedAt !== undefined);
  assert.ok(log.entries.some((entry) => entry.event === 'gather.optional-failed'));
  assert.equal(
    log.entries.filter((entry) => entry.event === 'gather.failed').length,
    0,
  );
  // The restored queue still carried required branch c, so the gather completed.
  assert.equal(
    log.entries.filter((entry) => entry.event === 'gather.completed').length,
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

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const completed = completedGatherOf(runtime.snapshot());
  assert.ok(completed?.completedAt !== undefined);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);

  const token = runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('ask', text('late'), token);
  clock += 1000;
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1, 'no second emit');
  assert.equal(
    log.entries.filter((entry) => entry.event === 'gather.completed').length,
    1,
  );
  const dropped = log.entries.find((entry) => entry.event === 'gather.optional-dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.nodeId, 'gather');
  assert.equal(dropped.spreadId, completed.spreadId);
  assert.equal(dropped.branchId, 'b');
  assert.equal(dropped.outcome, 'late-optional');
  assert.equal(runtime.snapshot().rest, true);
  const after = runtime.snapshot().nodes['gather']?.gathers ?? {};
  assert.equal(Object.keys(after).length, 1);
  assert.ok(Object.values(after)[0]?.completedAt !== undefined);
});

test('a late required branch is a protocol error and never emits a second time', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor } = recorder();
  const definition = directGatherComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();
  clock += 1000;
  await runtime.pump();
  const firstSpreadId = completedGatherOf(runtime.snapshot())?.spreadId;
  assert.ok(firstSpreadId !== undefined);

  const field = runtime.exportField();
  const gatherState = field.nodes['gather'];
  assert.ok(gatherState !== undefined);
  (gatherState.receptor ??= []).push(branchPheromone(firstSpreadId, 'a', text('again')));

  const calls: string[] = [];
  const restored = PheromoneRuntime.restore(definition, field, {
    executeForager: {
      async execute(node, input) {
        calls.push(node.id);
        return input;
      },
    },
    // The gather is rate-limited after its completion; one interval later the
    // queued late branch is due.
    now: () => clock + 1000,
    onLog: log.sink,
  });

  await restored.runtime.pump();

  assert.deepEqual(calls, [], 'a late required branch has no second emit');
  assert.equal(log.entries.filter((entry) => entry.event === 'gather.completed').length, 0);
  const failure = log.entries.find(
    (entry) => entry.event === 'gather.failed' && entry.outcome === 'late-required',
  );
  assert.ok(failure !== undefined);
  assert.equal(failure.branchId, 'a');
  assert.equal(failure.spreadId, firstSpreadId);
  assert.equal(restored.runtime.snapshot().rest, true);
  assert.ok(completedGatherOf(restored.runtime.snapshot())?.completedAt !== undefined);
});

test('completed gathers are bounded by count, keeping the newest markers', async () => {
  let clock = START;
  const definition = directGatherComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => clock,
  });

  const completeOne = async (): Promise<void> => {
    runtime.admit('start', text('seed'));
    let guard = 0;
    while (!runtime.snapshot().rest) {
      clock += 1000;
      await runtime.pump();
      guard += 1;
      assert.ok(guard < 10, 'a gather cycle should settle quickly');
    }
  };

  await completeOne();
  const oldestSpreadId = completedGatherOf(runtime.snapshot())?.spreadId;
  assert.ok(oldestSpreadId !== undefined);
  const total = MAX_COMPLETED_GATHERS + 2;
  for (let index = 1; index < total; index += 1) {
    await completeOne();
  }

  const gathers = runtime.snapshot().nodes['gather']?.gathers ?? {};
  assert.equal(Object.keys(gathers).length, MAX_COMPLETED_GATHERS);
  assert.equal(gathers[oldestSpreadId], undefined, 'the oldest marker was evicted');
  assert.ok(completedGatherOf(runtime.snapshot())?.completedAt !== undefined);
});

test('expired completed gathers are pruned on the next gather activity', async () => {
  let clock = START;
  const definition = directGatherComposition();
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
      assert.ok(guard < 10, 'a gather cycle should settle quickly');
    }
  };

  runtime.admit('start', text('one'));
  await settle();
  const staleSpreadId = completedGatherOf(runtime.snapshot())?.spreadId;
  assert.ok(staleSpreadId !== undefined);

  clock += COMPLETED_GATHER_TTL_MS + 1000;
  runtime.admit('start', text('two'));
  await settle();

  const gathers = runtime.snapshot().nodes['gather']?.gathers ?? {};
  assert.equal(gathers[staleSpreadId], undefined);
  assert.equal(Object.keys(gathers).length, 1);
});

test('restore prunes a completed marker that outlived its retention', () => {
  const definition = directGatherComposition();
  const field = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.nodes['gather'] = {
    receptor: [],
    gathers: {
      fk_expired: {
        arrived: [],
        completedAt: new Date(START).toISOString(),
      },
    },
  };
  field.rest = true;

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START + COMPLETED_GATHER_TTL_MS + 1000,
  });

  assert.equal(runtime.snapshot().nodes['gather']?.gathers, undefined);
  assert.equal(runtime.snapshot().rest, true);
});
