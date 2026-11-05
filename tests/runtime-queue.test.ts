import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
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
