import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  ReceptorFullError,
  serializeValue,
  type NodeExecutor,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function singleNodeComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'queue',
    nodes: {
      start: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'handle {{message}}' },
        minIntervalMs: 1000,
      },
    },
    edges: [],
  });
}

function queueCappedComposition(
  queueMax: number,
  nodes: Record<string, unknown>,
  edges: unknown[] = [],
): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'queue-capped',
    defaults: { queueMax },
    nodes,
    edges,
  });
}

function foragerNode(): unknown {
  return { kind: 'forager', config: { connection: 'codex', prompt: 'handle {{message}}' } };
}

function text(value: string): Value {
  return { message: value };
}

test('a second trigger waits for the first activation to finish', async () => {
  let clock = START;
  const calls: Value[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      calls.push(input);
      return { message: `done:${serializeValue(input)}` };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', text('first'));
  runtime.admit('start', text('second'));
  await runtime.settle();

  assert.equal(calls.length, 1);
  assert.equal(serializeValue(calls[0] as Value), 'first');

  const snapshot = runtime.snapshot();
  const start = snapshot.nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.active, undefined);
  assert.ok(start.pending !== undefined);
  assert.equal(serializeValue(start.pending.value), 'second');
  assert.equal(start.receptor.length, 0);
  assert.equal(start.lastActivatedAt, new Date(START).toISOString());
});

test('early input stays in pending and runs once the minimum interval elapses', async () => {
  let clock = START;
  const calls: Value[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      calls.push(input);
      return { message: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', text('first'));
  runtime.admit('start', text('second'));
  await runtime.settle();
  assert.equal(calls.length, 1);

  await runtime.settle();
  assert.equal(calls.length, 1, 'pending must not run before minInterval');

  clock += 999;
  await runtime.settle();
  assert.equal(calls.length, 1, '999ms is still too early');

  clock += 1;
  await runtime.settle();
  assert.equal(calls.length, 2);
  assert.equal(serializeValue(calls[1] as Value), 'second');
  assert.equal(runtime.snapshot().rest, true);
});

test('queued input is never dropped when the clock advances past several intervals', async () => {
  let clock = START;
  const calls: Value[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      calls.push(input);
      return { message: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', text('a'));
  runtime.admit('start', text('b'));
  runtime.admit('start', text('c'));

  await runtime.settle();
  clock += 1000;
  await runtime.settle();
  clock += 1000;
  await runtime.settle();

  assert.deepEqual(
    calls.map((value) => serializeValue(value)),
    ['a', 'b', 'c'],
  );
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.receptor.length, 0);
  assert.equal(start.pending, undefined);
  assert.equal(runtime.snapshot().rest, true);
});

test('the queue stays FIFO while the node is busy', async () => {
  let clock = START;
  let release: ((value: Value) => void) | undefined;
  const started: Value[] = [];
  const executor: NodeExecutor = {
    execute(_node, input) {
      started.push(input);
      return new Promise<Value>((resolve) => {
        release = resolve;
      });
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', text('running'));
  const settling = runtime.settle();
  await Promise.resolve();

  assert.ok(release !== undefined);
  const busy = runtime.snapshot().nodes['start'];
  assert.ok(busy !== undefined);
  assert.equal(busy.active !== undefined, true);

  runtime.admit('start', text('queued'));
  const afterTrigger = runtime.snapshot().nodes['start'];
  assert.ok(afterTrigger !== undefined);
  assert.equal(afterTrigger.receptor.length, 1);
  assert.equal(serializeValue(afterTrigger.receptor[0]?.value as Value), 'queued');

  release({ message: 'finished' });
  await settling;

  assert.deepEqual(
    started.map((value) => serializeValue(value)),
    ['running'],
  );
  const pending = runtime.snapshot().nodes['start'];
  assert.ok(pending !== undefined);
  assert.ok(pending.pending !== undefined);
  assert.equal(serializeValue(pending.pending.value), 'queued');
});

test('queue depth is reported in the log', async () => {
  let clock = START;
  const log = createMemoryLog();
  const executor: NodeExecutor = {
    async execute() {
      return { message: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.admit('start', text('a'));
  runtime.admit('start', text('b'));
  runtime.admit('start', text('c'));

  const depths = log.entries
    .filter((entry) => entry.event === 'pheromone.enqueued')
    .map((entry) => entry.queueDepth);
  assert.deepEqual(depths, [1, 2, 3]);

  await runtime.settle();
  const pendingEntry = log.entries.find((entry) => entry.event === 'pheromone.pending');
  assert.ok(pendingEntry !== undefined);
  assert.equal(pendingEntry.queueDepth, 1);
});

test('rest flips back to false on a new trigger', async () => {
  let clock = START;
  const executor: NodeExecutor = {
    async execute() {
      return { message: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', text('a'));
  await runtime.settle();
  assert.equal(runtime.snapshot().rest, true);

  runtime.admit('start', text('b'));
  assert.equal(runtime.snapshot().rest, false);
});

test('queueMax: 1 rejects a second trigger, keeps the first and logs the rejection', async () => {
  let clock = START;
  const log = createMemoryLog();
  const executed: string[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      executed.push(serializeValue(input));
      return { message: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(queueCappedComposition(1, { start: foragerNode() }), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  await runtime.admit('start', text('first'));
  await assert.rejects(
    runtime.admit('start', text('second')),
    (error: unknown) => {
      assert.ok(error instanceof ReceptorFullError);
      assert.equal(error.name, 'ReceptorFullError');
      assert.equal(error.nodeId, 'start');
      assert.equal(error.queueMax, 1);
      assert.equal(error.queueDepth, 1);
      return true;
    },
  );

  // Neither the rejected Pheromone nor an eviction changed the queue.
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.receptor.length, 1);
  assert.equal(serializeValue(start.receptor[0]?.value as Value), 'first');

  const rejected = log.entries.filter((entry) => entry.event === 'pheromone.rejected');
  assert.equal(rejected.length, 1);
  const entry = rejected[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.nodeId, 'start');
  assert.equal(entry.nodeKind, 'forager');
  assert.equal(entry.queueDepth, 1);
  assert.equal(entry.outcome, 'queue-max');
  assert.equal(typeof entry.enqueuedAt, 'string');
  // The rejection is logged without a message identity and never enqueued.
  assert.equal(
    log.entries.filter((candidate) => candidate.event === 'pheromone.enqueued').length,
    1,
  );

  await runtime.settle();
  assert.deepEqual(executed, ['first']);
  assert.equal(runtime.snapshot().nodes['start']?.receptor.length, 0);
});

test('an internal move to a full target is dropped and logged, not deferred', async () => {
  let clock = START;
  const log = createMemoryLog();
  const executed: { node: string; value: string }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      executed.push({ node: node.id, value: serializeValue(input) });
      return { message: `out:${serializeValue(input)}` };
    },
  };
  const runtime = new PheromoneRuntime(
    queueCappedComposition(
      1,
      {
        start: foragerNode(),
        sink: { kind: 'user', config: { modality: 'text', prompt: '?' } },
      },
      [{ id: 'e1', from: 'start', to: 'sink' }],
    ),
    { executeForager: executor, now: () => clock, onLog: log.sink },
  );

  // Park the sink on a hover so its receptor keeps one queued entry; with
  // queueMax 1 the next internal move is refused while the target is full.
  runtime.admit('sink', text('open'));
  await runtime.settle();
  runtime.admit('sink', text('existing'));
  await runtime.settle();
  const parked = runtime.snapshot().nodes['sink'];
  assert.equal(parked?.receptor.length, 1);
  assert.equal(parked?.hover?.kind, 'user');

  runtime.admit('start', text('seed'));
  await runtime.settle();

  // The source ran and its output was dropped at the full target: no deferral,
  // no retry, no failure.
  assert.deepEqual(executed, [{ node: 'start', value: 'seed' }]);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['start']?.pending, undefined);
  assert.equal(snapshot.nodes['start']?.active, undefined);
  assert.equal(snapshot.nodes['sink']?.pending, undefined);
  assert.equal(snapshot.nodes['sink']?.receptor.length, 1);
  assert.equal(
    log.entries.some((entry) => entry.event === 'node.failed'),
    false,
    'a full target is a drop, not a node failure',
  );
  assert.equal(
    log.entries.filter((entry) => entry.event === 'pheromone.rejected').length,
    1,
    'the target still records the refused enqueue',
  );
  const dropped = log.entries.find(
    (entry) => entry.event === 'pheromone.dropped' && entry.nodeId === 'start',
  );
  assert.ok(dropped !== undefined);
  assert.equal(dropped.nodeKind, 'forager');
  assert.equal(dropped.outcome, 'target-full:sink');
  assert.equal(dropped.queueDepth, 1);
  assert.equal(dropped.limit, 1);
});

interface SpreadHarness {
  readonly runtime: PheromoneRuntime;
  readonly executed: { node: string; value: string }[];
  readonly log: ReturnType<typeof createMemoryLog>;
}

/** A clone spread whose `left` target is full behind an open user hover. */
async function spreadWithFullLeft(): Promise<SpreadHarness> {
  let clock = START;
  const log = createMemoryLog();
  const executed: { node: string; value: string }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      executed.push({ node: node.id, value: serializeValue(input) });
      return { message: `out:${serializeValue(input)}` };
    },
  };
  const runtime = new PheromoneRuntime(
    queueCappedComposition(
      1,
      {
        start: foragerNode(),
        fan: {
          kind: 'spread',
          config: { strategy: 'clone', targets: ['left', 'right'] },
        },
        left: { kind: 'user', config: { modality: 'text', prompt: '?' } },
        right: foragerNode(),
      },
      [{ id: 'e1', from: 'start', to: 'fan' }],
    ),
    { executeForager: executor, now: () => clock, onLog: log.sink },
  );
  // Keep one entry queued behind a hover on `left`: the spread's left part is
  // refused while `right` still receives its copy.
  runtime.admit('left', text('open'));
  await runtime.settle();
  runtime.admit('left', text('existing-left'));
  await runtime.settle();
  runtime.admit('start', text('seed'));
  await runtime.settle();
  return { runtime, executed, log };
}

test('a spread drops only the part whose target is full and keeps the rest', async () => {
  const { runtime, executed, log } = await spreadWithFullLeft();

  // `left` was full, so its part was dropped; `right` still received the whole
  // copy. Partial fan-out is not a cancellation and never rolls back.
  assert.deepEqual(
    executed.map((call) => call.node),
    ['start', 'right'],
  );
  assert.equal(executed.find((call) => call.node === 'right')?.value, 'out:seed');
  const left = runtime.snapshot().nodes['left'];
  assert.equal(left?.hover?.kind, 'user');
  assert.equal(left?.receptor.length, 1);
  assert.equal(
    executed.filter((call) => call.node === 'left').length,
    0,
    'the dropped part is never retried and the existing input is not lost',
  );

  const dropped = log.entries.find(
    (entry) => entry.event === 'pheromone.dropped' && entry.nodeId === 'fan',
  );
  assert.ok(dropped !== undefined);
  assert.equal(dropped.nodeKind, 'spread');
  assert.equal(dropped.outcome, 'target-full:left');
  assert.equal(dropped.queueDepth, 1);
  assert.equal(dropped.limit, 1);
  assert.equal(
    log.entries.some((entry) => entry.event === 'node.failed'),
    false,
    'a partial fan-out is not a node failure',
  );

  const fan = runtime.snapshot().nodes['fan'];
  assert.ok(fan !== undefined);
  assert.equal(fan.pending, undefined, 'the spread input was consumed');
  assert.equal(fan.active, undefined);
  assert.equal(fan.receptor.length, 0, 'the spread has no ordinary out-edge receptor');
  assert.equal(fan.lastOutput, undefined, 'a spread writes no last output');
  assert.equal(runtime.snapshot().rest, false, 'the parked user input keeps work');
});

interface RestoredQueueHarness {
  readonly runtime: PheromoneRuntime;
  readonly executed: string[];
  readonly advance: () => void;
}

/** A restored field whose receptor already holds more entries than queueMax. */
function restoredOverCapacity(): RestoredQueueHarness {
  let clock = START;
  const definition = queueCappedComposition(1, { start: foragerNode() });
  const executed: string[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      executed.push(serializeValue(input));
      return { message: 'ok' };
    },
  };
  const persistedValue = (_id: string, textValue: string) => ({
    value: { message: textValue },
    enqueuedAt: new Date(START).toISOString(),
  });
  const { runtime } = PheromoneRuntime.restore(
    definition,
    {
      schemaVersion: 2,
      compositionId: definition.id,
      graphRevision: definition.graphRevision,
      rest: false,
      nodes: {
        start: {
          receptor: [
            persistedValue('ph_one', 'one'),
            persistedValue('ph_two', 'two'),
            persistedValue('ph_three', 'three'),
          ],
        },
      },
    },
    { executeForager: executor, now: () => clock },
  );
  return { runtime, executed, advance: () => { clock += 1_000; } };
}

test('a restored over-capacity queue is preserved and only new enqueues are rejected', async () => {
  const { runtime, executed, advance } = restoredOverCapacity();

  assert.deepEqual(
    runtime.snapshot().nodes['start']?.receptor.map((pheromone) => serializeValue(pheromone.value)),
    ['one', 'two', 'three'],
    'restore keeps every accepted input instead of truncating to queueMax',
  );
  await assert.rejects(runtime.admit('start', text('new')), ReceptorFullError);

  await runtime.settle();
  assert.deepEqual(executed, ['one']);
  assert.equal(runtime.snapshot().nodes['start']?.receptor.length, 1);
  await assert.rejects(
    runtime.admit('start', text('still-full')),
    ReceptorFullError,
    'the queue is still at the limit until it drains below it',
  );

  advance();
  await runtime.settle();
  assert.deepEqual(executed, ['one', 'two']);
  assert.equal(runtime.snapshot().nodes['start']?.receptor.length, 0);
  assert.equal(serializeValue(runtime.snapshot().nodes['start']?.pending?.value as Value), 'three');
});
