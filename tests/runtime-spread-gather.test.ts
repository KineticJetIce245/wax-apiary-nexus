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

/** start -> spread (a->gather, b->ask, c->ask-c) */
function fanoutComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'fanout',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
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
    edges: [{ id: 'e1', from: 'start', to: 'spread' }],
  });
}

/** start -> spread (a->gather, b->ask); ask -> gather; gather -> done */
function humanGatherComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'human-gather',
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
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

/** start -> spread (x->make-x, y->make-y); both -> gather (required y,x); gather -> done */
function combineOrderComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'combine-order',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'x', to: 'make-x' },
            { id: 'y', to: 'make-y' },
          ],
        },
      },
      'make-x': { kind: 'forager', config: { connection: 'codex', prompt: 'x' } },
      'make-y': { kind: 'forager', config: { connection: 'codex', prompt: 'y' } },
      gather: { kind: 'gather', config: { required: ['y', 'x'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'make-x', to: 'gather' },
      { id: 'e3', from: 'make-y', to: 'gather' },
      { id: 'e4', from: 'gather', to: 'done' },
    ],
  });
}

/** start1/start2 -> spread (a->gather, b->ask); ask -> gather; gather -> done */
function interleavedComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'interleaved',
    nodes: {
      start1: { kind: 'forager', config: { connection: 'codex', prompt: 'one' } },
      start2: { kind: 'forager', config: { connection: 'codex', prompt: 'two' } },
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
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start1', to: 'spread' },
      { id: 'e2', from: 'start2', to: 'spread' },
      { id: 'e3', from: 'ask', to: 'gather' },
      { id: 'e4', from: 'gather', to: 'done' },
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
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'make-b' },
          ],
        },
      },
      'make-b': { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'make-b', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

test('spread consumes one Pheromone and emits one tagged copy per branch', async () => {
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(fanoutComposition(), {
    executeForager: executor,
    now: () => START,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ['start'],
    'only the source forager ran; the spread is a control step',
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
  assert.match(a.spreadId ?? '', /^fk_/);
  assert.equal(a.spreadId, b.spreadId);
  assert.equal(a.spreadId, c.spreadId);
  assert.deepEqual([a.value, b.value, c.value], [text('seed'), text('seed'), text('seed')]);

  runtime.answerHover('ask-a', text('A'));
  runtime.answerHover('ask-b', text('B'));
  runtime.answerHover('ask-c', text('C'));
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, true);
});

test('gather waits for every required branch and emits exactly once', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(humanGatherComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const gatherState = waiting.nodes['gather'];
  assert.ok(gatherState !== undefined);
  const gathers = gatherState.gathers ?? {};
  const spreadIds = Object.keys(gathers);
  assert.equal(spreadIds.length, 1);
  const join = gathers[spreadIds[0] ?? ''];
  assert.ok(join !== undefined);
  assert.equal(join.arrived.length, 1);
  assert.equal(join.arrived[0]?.branchId, 'a');
  assert.ok(log.entries.some((entry) => entry.event === 'gather.waiting'));

  const token = waiting.nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('ask', text('reply'), token);
  clock += 1000;
  await runtime.pump();

  const finished = runtime.snapshot();
  assert.equal(finished.rest, true);
  assert.deepEqual(finished.pheromones, [], 'the required branches were consumed atomically');
  // Stage 5A keeps a completed tombstone so a late optional can be dropped.
  const completedGather = Object.values(finished.nodes['gather']?.gathers ?? {})[0];
  assert.ok(completedGather !== undefined);
  assert.ok(completedGather.completedAt !== undefined);
  assert.deepEqual(completedGather.arrived, []);
  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'seed\nreply');
  assert.ok(log.entries.some((entry) => entry.event === 'gather.completed'));

  const gatherOutput = log.entries
    .filter((entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done')
    .at(-1);
  assert.ok(gatherOutput !== undefined);
  assert.equal(gatherOutput.spreadId, undefined);
  assert.equal(gatherOutput.branchId, undefined);
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

  runtime.admit('start', text('seed'));
  await runtime.pump();
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);

  clock += 1000;
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(serializeValue(doneCalls[0]?.input as Value), 'Y\nX');
  assert.equal(runtime.snapshot().rest, true);
});

test('two spreadIds interleave at one gather without mixing groups', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(interleavedComposition(), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.admit('start1', text('one'));
  await runtime.pump();
  clock += 1000;
  runtime.admit('start2', text('two'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  const gathers = waiting.nodes['gather']?.gathers ?? {};
  const spreadIds = Object.keys(gathers);
  assert.equal(spreadIds.length, 2, 'each spreadId gets its own join');
  const values = spreadIds.map((spreadId) => {
    const join = gathers[spreadId];
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

test('a missing required branch waits for the gather deadline, then times out', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'missing-branch',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'sink' },
          ],
        },
      },
      sink: { kind: 'forager', config: { connection: 'codex', prompt: 'sink' } },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false, 'the join waits instead of failing early');
  assert.equal(Object.keys(waiting.nodes['gather']?.gathers ?? {}).length, 1);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  assert.equal(log.entries.filter((entry) => entry.event === 'gather.failed').length, 0);
  const waitingGather = Object.values(waiting.nodes['gather']?.gathers ?? {})[0];
  const deadline = waitingGather?.deadlineAt;
  assert.ok(deadline !== undefined);

  clock = deadline - 1;
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, false, 'still waiting just before the deadline');

  clock = deadline;
  await runtime.pump();

  const timedOut = runtime.snapshot();
  assert.equal(timedOut.rest, true);
  const join = Object.values(timedOut.nodes['gather']?.gathers ?? {})[0];
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.deepEqual(join.arrived, []);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  assert.ok(log.entries.some((entry) => entry.event === 'gather.timed-out'));
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'timed-out');
});

test('a failed branch fails the gather, cancels siblings and is never replayed', async () => {
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
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'boom' },
          ],
        },
      },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
  await assert.rejects(runtime.pump(), /branch exploded/);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['gather']?.gathers, undefined);
  assert.equal(snapshot.rest, true);
  assert.deepEqual(calls, ['start', 'boom']);
  assert.equal(calls.filter((call) => call === 'done').length, 0);
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
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
  field.nodes['gather'] = {
    receptor: [],
    gathers: {
      fk_restore: {
        arrived: [branchPheromone('fk_restore', 'a')],
        deadlineAt: START + 3_600_000,
      },
    },
  };
  field.nodes['make-b'] = {
    receptor: [],
    active: branchPheromone('fk_restore', 'b'),
  };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
    onLog: log.sink,
  });

  assert.deepEqual(report.unknownActive, ['make-b']);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['gather']?.gathers, undefined);
  assert.equal(snapshot.rest, true);
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
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
  field.nodes['gather'] = {
    receptor: [branchPheromone('fk_duplicate', 'a')],
    gathers: {
      fk_duplicate: {
        arrived: [branchPheromone('fk_duplicate', 'a')],
        deadlineAt: START + 3_600_000,
      },
    },
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
    onLog: log.sink,
  });
  assert.equal(runtime.snapshot().rest, false);

  await runtime.pump();

  assert.equal(runtime.snapshot().nodes['gather']?.gathers, undefined);
  assert.equal(runtime.snapshot().rest, true);
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'duplicate-branch');
});

test('Rest stays false while a restored join is incomplete', () => {
  const definition = branchWorkComposition();
  const field: PersistedField = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.nodes['gather'] = {
    receptor: [],
    gathers: {
      fk_wait: {
        arrived: [branchPheromone('fk_wait', 'a')],
        deadlineAt: START + 3_600_000,
      },
    },
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false);
  assert.equal(Object.keys(snapshot.nodes['gather']?.gathers ?? {}).length, 1);
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
  field.nodes['gather'] = {
    receptor: [],
    gathers: {
      fk_complete: {
        arrived: [
          branchPheromone('fk_complete', 'a', text('A')),
          branchPheromone('fk_complete', 'b', text('B')),
        ],
        deadlineAt: START + 3_600_000,
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

test('spread copies a non-text Value unchanged', async () => {
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(fanoutComposition(), {
    executeForager: executor,
    now: () => START,
  });

  runtime.admit('start', { kind: 'boolean', value: true });
  await runtime.pump();

  const values = runtime.snapshot().pheromones.map((pheromone) => pheromone.value);
  assert.deepEqual(values, [
    { kind: 'boolean', value: true },
    { kind: 'boolean', value: true },
    { kind: 'boolean', value: true },
  ]);
});

test('a gather without an outgoing edge is terminal', async () => {
  const { executor, calls } = recorder();
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'terminal-gather',
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
    },
    edges: [{ id: 'e1', from: 'start', to: 'spread' }],
  });
  let clock = START;
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  assert.deepEqual(calls.map((call) => call.nodeId), ['start']);
  assert.equal(runtime.snapshot().rest, true);
  assert.deepEqual(runtime.snapshot().pheromones, []);
});

test('an unexpected branch arrival fails the gather and cancels siblings', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'unknown-branch',
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
      gather: { kind: 'gather', config: { required: ['a', 'c'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  assert.equal(runtime.snapshot().nodes['gather']?.gathers, undefined);
  assert.equal(runtime.snapshot().rest, true);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
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
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'boom' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
  await assert.rejects(runtime.pump(), /branch exploded/);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['ask']?.hover, undefined);
  assert.equal(snapshot.nodes['ask']?.receptor.length, 0);
  assert.equal(snapshot.rest, true);
  assert.ok(log.entries.some((entry) => entry.event === 'hover.cancelled'));
});
