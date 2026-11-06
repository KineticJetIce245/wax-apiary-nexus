import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  QueueFullError,
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
        config: { connection: 'codex', prompt: 'handle {{input}}' },
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
  return { kind: 'forager', config: { connection: 'codex', prompt: 'handle {{input}}' } };
}

function text(value: string): Value {
  return { kind: 'text', text: value };
}

test('a second trigger waits for the first activation to finish', async () => {
  let clock = START;
  const calls: Value[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      calls.push(input);
      return { kind: 'text', text: `done:${serializeValue(input)}` };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.trigger('start', text('first'));
  runtime.trigger('start', text('second'));
  await runtime.pump();

  assert.equal(calls.length, 1);
  assert.equal(serializeValue(calls[0] as Value), 'first');

  const snapshot = runtime.snapshot();
  const start = snapshot.nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.active, undefined);
  assert.ok(start.pending !== undefined);
  assert.equal(serializeValue(start.pending.value), 'second');
  assert.equal(start.queue.length, 0);
  assert.equal(start.lastActivatedAt, new Date(START).toISOString());
});

test('early input stays in pending and runs once the minimum interval elapses', async () => {
  let clock = START;
  const calls: Value[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      calls.push(input);
      return { kind: 'text', text: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.trigger('start', text('first'));
  runtime.trigger('start', text('second'));
  await runtime.pump();
  assert.equal(calls.length, 1);

  await runtime.pump();
  assert.equal(calls.length, 1, 'pending must not run before minInterval');

  clock += 999;
  await runtime.pump();
  assert.equal(calls.length, 1, '999ms is still too early');

  clock += 1;
  await runtime.pump();
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
      return { kind: 'text', text: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.trigger('start', text('a'));
  runtime.trigger('start', text('b'));
  runtime.trigger('start', text('c'));

  await runtime.pump();
  clock += 1000;
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  assert.deepEqual(
    calls.map((value) => serializeValue(value)),
    ['a', 'b', 'c'],
  );
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.queue.length, 0);
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

  runtime.trigger('start', text('running'));
  const pumping = runtime.pump();
  await Promise.resolve();

  assert.ok(release !== undefined);
  const busy = runtime.snapshot().nodes['start'];
  assert.ok(busy !== undefined);
  assert.equal(busy.active !== undefined, true);

  runtime.trigger('start', text('queued'));
  const afterTrigger = runtime.snapshot().nodes['start'];
  assert.ok(afterTrigger !== undefined);
  assert.equal(afterTrigger.queue.length, 1);
  assert.equal(serializeValue(afterTrigger.queue[0]?.value as Value), 'queued');

  release({ kind: 'text', text: 'finished' });
  await pumping;

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
      return { kind: 'text', text: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('a'));
  runtime.trigger('start', text('b'));
  runtime.trigger('start', text('c'));

  const depths = log.entries
    .filter((entry) => entry.event === 'pheromone.enqueued')
    .map((entry) => entry.queueDepth);
  assert.deepEqual(depths, [1, 2, 3]);

  await runtime.pump();
  const pendingEntry = log.entries.find((entry) => entry.event === 'pheromone.pending');
  assert.ok(pendingEntry !== undefined);
  assert.equal(pendingEntry.queueDepth, 1);
});

test('rest flips back to false on a new trigger', async () => {
  let clock = START;
  const executor: NodeExecutor = {
    async execute() {
      return { kind: 'text', text: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(singleNodeComposition(), { executeForager: executor, now: () => clock });

  runtime.trigger('start', text('a'));
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, true);

  runtime.trigger('start', text('b'));
  assert.equal(runtime.snapshot().rest, false);
});

test('queueMax: 1 rejects a second trigger, keeps the first and logs the rejection', async () => {
  let clock = START;
  const log = createMemoryLog();
  const executed: string[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      executed.push(serializeValue(input));
      return { kind: 'text', text: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(queueCappedComposition(1, { start: foragerNode() }), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('first'));
  assert.throws(
    () => runtime.trigger('start', text('second')),
    (error: unknown) => {
      assert.ok(error instanceof QueueFullError);
      assert.equal(error.name, 'QueueFullError');
      assert.equal(error.nodeId, 'start');
      assert.equal(error.queueMax, 1);
      assert.equal(error.queueDepth, 1);
      return true;
    },
  );

  // Neither the rejected Pheromone nor an eviction changed the queue.
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.queue.length, 1);
  assert.equal(serializeValue(start.queue[0]?.value as Value), 'first');

  const rejected = log.entries.filter((entry) => entry.event === 'pheromone.rejected');
  assert.equal(rejected.length, 1);
  const entry = rejected[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.nodeId, 'start');
  assert.equal(entry.nodeKind, 'forager');
  assert.equal(entry.queueDepth, 1);
  assert.equal(entry.outcome, 'queue-max');
  assert.equal(typeof entry.pheromoneId, 'string');
  assert.equal(typeof entry.traceId, 'string');
  // The rejection log names a Pheromone that was never enqueued.
  assert.equal(
    log.entries.some(
      (candidate) =>
        candidate.event === 'pheromone.enqueued' &&
        candidate.pheromoneId === entry.pheromoneId,
    ),
    false,
  );

  await runtime.pump();
  assert.deepEqual(executed, ['first']);
  assert.equal(runtime.snapshot().nodes['start']?.queue.length, 0);
});

test('a normal edge emit is rejected when the target queue is full', async () => {
  let clock = START;
  const log = createMemoryLog();
  const executed: { node: string; value: string }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      executed.push({ node: node.id, value: serializeValue(input) });
      return { kind: 'text', text: `out:${serializeValue(input)}` };
    },
  };
  const runtime = new PheromoneRuntime(
    queueCappedComposition(
      1,
      { start: foragerNode(), sink: foragerNode() },
      [{ id: 'e1', from: 'start', to: 'sink' }],
    ),
    { executeForager: executor, now: () => clock, onLog: log.sink },
  );

  runtime.trigger('sink', text('existing'));
  runtime.trigger('start', text('seed'));

  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof QueueFullError);
    assert.equal(error.nodeId, 'sink');
    assert.equal(error.queueMax, 1);
    assert.equal(error.queueDepth, 1);
    return true;
  });

  assert.deepEqual(executed, [{ node: 'start', value: 'seed' }]);
  const sink = runtime.snapshot().nodes['sink'];
  assert.ok(sink !== undefined);
  assert.equal(sink.queue.length, 1, 'the existing target input is never evicted');
  assert.equal(serializeValue(sink.queue[0]?.value as Value), 'existing');
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.queue.length, 0);
  assert.equal(start.pending, undefined);
  assert.equal(start.active, undefined);

  const completed = log.entries.find(
    (entry) => entry.event === 'node.completed' && entry.nodeId === 'start',
  );
  assert.ok(completed !== undefined);
  assert.equal(completed.outcome, 'ok');
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'start',
  );
  assert.ok(failed !== undefined);
  assert.match(String(failed.error), /queue for node 'sink' is full/);
  const rejected = log.entries.find((entry) => entry.event === 'pheromone.rejected');
  assert.ok(rejected !== undefined);
  assert.equal(rejected.nodeId, 'sink');
  assert.equal(rejected.queueDepth, 1);
  assert.equal(rejected.outcome, 'queue-max');

  // The runtime survives the rejection and still drains the existing queue.
  await runtime.pump();
  assert.deepEqual(executed, [
    { node: 'start', value: 'seed' },
    { node: 'sink', value: 'existing' },
  ]);
  assert.equal(runtime.snapshot().rest, true);
});

test('a fork preflights every branch and emits none when a repeated target would overflow', async () => {
  let clock = START;
  const log = createMemoryLog();
  const executed: { node: string; value: string }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      executed.push({ node: node.id, value: serializeValue(input) });
      return { kind: 'text', text: `out:${serializeValue(input)}` };
    },
  };
  const runtime = new PheromoneRuntime(
    queueCappedComposition(
      2,
      {
        start: foragerNode(),
        fan: {
          kind: 'fork',
          config: {
            branches: [
              { id: 'a', to: 'left' },
              { id: 'b', to: 'left' },
              { id: 'c', to: 'right' },
            ],
          },
        },
        left: foragerNode(),
        right: foragerNode(),
      },
      [{ id: 'e1', from: 'start', to: 'fan' }],
    ),
    { executeForager: executor, now: () => clock, onLog: log.sink },
  );

  runtime.trigger('left', text('existing-left'));
  runtime.trigger('start', text('seed'));

  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof QueueFullError);
    assert.equal(error.nodeId, 'left');
    assert.equal(error.queueMax, 2);
    assert.equal(error.queueDepth, 1);
    return true;
  });

  // One existing input plus the two `left` branches exceeds queueMax: 2. The
  // whole fork is refused, even though `right` had room for its branch.
  const left = runtime.snapshot().nodes['left'];
  assert.ok(left !== undefined);
  assert.equal(left.queue.length, 1);
  assert.equal(serializeValue(left.queue[0]?.value as Value), 'existing-left');
  const right = runtime.snapshot().nodes['right'];
  assert.ok(right !== undefined);
  assert.equal(right.queue.length, 0, 'no branch is emitted when the preflight fails');
  assert.equal(
    log.entries.filter(
      (entry) =>
        entry.event === 'pheromone.emitted' &&
        (entry.nodeId === 'left' || entry.nodeId === 'right'),
    ).length,
    0,
  );

  const rejected = log.entries.find((entry) => entry.event === 'pheromone.rejected');
  assert.ok(rejected !== undefined);
  assert.equal(rejected.nodeId, 'left');
  assert.equal(rejected.nodeKind, 'forager');
  assert.equal(rejected.branchId, 'b', 'the duplicate branch is the one that overflows');
  assert.equal(rejected.queueDepth, 1);
  assert.equal(rejected.outcome, 'queue-max');
  assert.equal(typeof rejected.forkId, 'string');
  assert.equal(typeof rejected.pheromoneId, 'string');
  assert.equal(typeof rejected.traceId, 'string');

  // The rejected fork does not break the field: existing work still runs and
  // new input is accepted once the queue has room.
  await runtime.pump();
  assert.deepEqual(
    executed,
    [
      { node: 'start', value: 'seed' },
      { node: 'left', value: 'existing-left' },
    ],
    'the runtime keeps processing the existing queue after the rejection',
  );
  runtime.trigger('right', text('after-rejection'));
  assert.equal(runtime.snapshot().nodes['right']?.queue.length, 1);
});

test('a restored over-capacity queue is preserved and only new enqueues are rejected', async () => {
  let clock = START;
  const definition = queueCappedComposition(1, { start: foragerNode() });
  const executed: string[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      executed.push(serializeValue(input));
      return { kind: 'text', text: 'ok' };
    },
  };
  const persistedValue = (id: string, textValue: string) => ({
    id,
    traceId: `tr_${id}`,
    value: { kind: 'text' as const, text: textValue },
    at: new Date(START).toISOString(),
  });
  // A field written before the limit was enforced can hold more than queueMax.
  const { runtime } = PheromoneRuntime.restore(
    definition,
    {
      schemaVersion: 1,
      compositionId: definition.id,
      graphRevision: definition.graphRevision,
      rest: false,
      nodes: {
        start: {
          queue: [persistedValue('ph_one', 'one'), persistedValue('ph_two', 'two'), persistedValue('ph_three', 'three')],
        },
      },
    },
    { executeForager: executor, now: () => clock },
  );

  assert.deepEqual(
    runtime.snapshot().nodes['start']?.queue.map((pheromone) => serializeValue(pheromone.value)),
    ['one', 'two', 'three'],
    'restore keeps every accepted input instead of truncating to queueMax',
  );
  assert.throws(() => runtime.trigger('start', text('new')), QueueFullError);

  await runtime.pump();
  assert.deepEqual(executed, ['one']);
  assert.equal(runtime.snapshot().nodes['start']?.queue.length, 1);
  assert.throws(
    () => runtime.trigger('start', text('still-full')),
    QueueFullError,
    'the queue is still at the limit until it drains below it',
  );

  clock += 1000;
  await runtime.pump();
  assert.deepEqual(executed, ['one', 'two']);
  assert.equal(runtime.snapshot().nodes['start']?.queue.length, 0);
  runtime.trigger('start', text('four'));
  assert.equal(runtime.snapshot().nodes['start']?.queue.length, 1);

  clock += 1000;
  await runtime.pump();
  assert.deepEqual(executed, ['one', 'two', 'three']);
  clock += 1000;
  await runtime.pump();
  assert.deepEqual(executed, ['one', 'two', 'three', 'four']);
  assert.equal(runtime.snapshot().rest, true);
});
