import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  QUEUE_RETRY_MS,
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

test('a full target pauses the upstream node, then resumes it without losing the output', async () => {
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

  // Warm the sink so its next queued input is held by minIntervalMs: the
  // target can stay full across a whole pump instead of draining immediately.
  runtime.trigger('sink', text('warm'));
  await runtime.pump();
  assert.deepEqual(executed, [{ node: 'sink', value: 'warm' }]);
  executed.length = 0;

  runtime.trigger('sink', text('existing'));
  runtime.trigger('start', text('seed'));

  await runtime.pump();

  // The upstream node did not run and did not fail: its input is preserved.
  assert.deepEqual(executed, [], 'the upstream node is not activated while the target is full');
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.ok(start.pending !== undefined, 'the source Pheromone stays pending');
  assert.equal(serializeValue(start.pending.value), 'seed');
  assert.equal(start.active, undefined);
  assert.equal(start.queue.length, 0);
  assert.equal(
    log.entries.some((entry) => entry.event === 'node.failed'),
    false,
    'backpressure is not a node failure',
  );
  assert.equal(
    log.entries.some((entry) => entry.event === 'pheromone.rejected'),
    false,
    'the source is held, not rejected',
  );

  const blocked = log.entries.find(
    (entry) => entry.event === 'pheromone.blocked' && entry.nodeId === 'start',
  );
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome, 'queue-max:sink');
  assert.equal(blocked.queueDepth, 1);
  assert.equal(typeof blocked.pheromoneId, 'string');

  // The retry hint is a real future instant, not a 0ms spin.
  assert.equal(runtime.snapshot().rest, false);
  assert.equal(runtime.nextWakeAt(), clock + QUEUE_RETRY_MS);

  // Free the target by letting its rate limit expire, then pump again.
  clock += 1000;
  await runtime.pump();

  assert.deepEqual(
    executed,
    [
      { node: 'start', value: 'seed' },
      { node: 'sink', value: 'existing' },
    ],
    'the preserved input runs once the target has room',
  );

  clock += 1000;
  await runtime.pump();

  assert.deepEqual(
    executed,
    [
      { node: 'start', value: 'seed' },
      { node: 'sink', value: 'existing' },
      { node: 'sink', value: 'out:seed' },
    ],
    'the source output is delivered and consumed, never lost',
  );
  assert.equal(runtime.snapshot().rest, true);
  assert.equal(runtime.snapshot().nodes['sink']?.queue.length, 0);
  assert.equal(
    log.entries.some((entry) => entry.event === 'node.failed'),
    false,
    'nothing failed during the pause or the resume',
  );
});

test('a fork pauses before activation when a branch target is full and loses no branch', async () => {
  let clock = START;
  const log = createMemoryLog();
  const executed: { node: string; value: string }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      executed.push({ node: node.id, value: serializeValue(input) });
      return { kind: 'text', text: `out:${serializeValue(input)}` };
    },
  };

  let runtime: PheromoneRuntime | undefined;
  let atBlock: { pending?: string; rightQueue: number } | undefined;
  const onLog = (entry: Parameters<typeof log.sink>[0]): void => {
    log.sink(entry);
    if (entry.event === 'pheromone.blocked' && entry.nodeId === 'fan' && runtime !== undefined) {
      const snapshot = runtime.snapshot();
      const pending = snapshot.nodes['fan']?.pending;
      atBlock = {
        ...(pending === undefined ? {} : { pending: serializeValue(pending.value) }),
        rightQueue: snapshot.nodes['right']?.queue.length ?? -1,
      };
    }
  };

  runtime = new PheromoneRuntime(
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
    { executeForager: executor, now: () => clock, onLog },
  );

  runtime.trigger('left', text('existing-left'));
  runtime.trigger('start', text('seed'));

  // No rejection: the fork waits until every branch target had room.
  await runtime.pump();

  assert.ok(atBlock !== undefined, 'the fork activation was deferred once');
  assert.deepEqual(
    atBlock,
    { pending: 'out:seed', rightQueue: 0 },
    'the fork input stays pending and no branch is emitted while one target is full',
  );

  const blocked = log.entries.find(
    (entry) => entry.event === 'pheromone.blocked' && entry.nodeId === 'fan',
  );
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome, 'queue-max:left');
  assert.equal(blocked.queueDepth, 1, 'one existing input plus two branches exceeds queueMax: 2');
  assert.equal(
    log.entries.some((entry) => entry.event === 'pheromone.rejected'),
    false,
    'the fork is not rejected after activation',
  );
  assert.equal(log.entries.some((entry) => entry.event === 'node.failed'), false);

  // The fork resumed in the same pump once `left` drained its existing input.
  assert.deepEqual(executed, [
    { node: 'start', value: 'seed' },
    { node: 'left', value: 'existing-left' },
    { node: 'right', value: 'out:seed' },
  ]);
  const fanPending = runtime.snapshot().nodes['fan']?.pending;
  assert.equal(fanPending, undefined, 'the fork input was consumed by its one activation');

  // The two `left` branches are spaced by minIntervalMs; drain both.
  clock += 1000;
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  assert.deepEqual(
    executed.filter((call) => call.node === 'left').map((call) => call.value),
    ['existing-left', 'out:seed', 'out:seed'],
    'both repeated-target branches are delivered exactly once',
  );
  assert.deepEqual(
    executed.filter((call) => call.node === 'right').map((call) => call.value),
    ['out:seed'],
  );
  assert.equal(runtime.snapshot().rest, true);
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
