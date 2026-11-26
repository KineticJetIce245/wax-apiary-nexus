import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  renderPrompt,
  serializeValue,
  type ForagerNode,
  type NodeExecutor,
  type RuntimeLogEntry,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

interface Recorder {
  executor: NodeExecutor;
  calls: { nodeId: string; input: Value }[];
}

function recorder(output?: (node: ForagerNode, input: Value) => Value): Recorder {
  const calls: { nodeId: string; input: Value }[] = [];
  return {
    calls,
    executor: {
      async execute(node, input) {
        calls.push({ nodeId: node.id, input });
        return output === undefined
          ? { message: `echo:${serializeValue(input)}` }
          : output(node, input);
      },
    },
  };
}

function terminalComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'terminal',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'reply to {{message}}' } },
    },
    edges: [],
  });
}

function conditionComposition(when: Record<string, unknown>): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'branch',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'ask {{message}}' } },
      check: { kind: 'condition', config: { when } },
      yes: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'yes path' },
        fallback: { message: '' },
      },
      no: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'no path' },
        fallback: { message: '' },
      },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'check' },
      { id: 'e2', from: 'check', to: 'yes', when: 'true' },
      { id: 'e3', from: 'check', to: 'no', when: 'false' },
    ],
  });
}

function twoNodeComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'pair',
    nodes: {
      a: { kind: 'forager', config: { connection: 'codex', prompt: 'first' } },
      b: { kind: 'forager', config: { connection: 'codex', prompt: 'second' } },
    },
    edges: [],
  });
}

function counterComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'loop',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{message}}' } },
      count: { kind: 'counter', config: { max: 2, step: 1 } },
      again: { kind: 'forager', config: { connection: 'codex', prompt: 'again' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'count' },
      { id: 'e2', from: 'count', to: 'again', when: 'continue' },
      { id: 'e3', from: 'count', to: 'done', when: 'done' },
      { id: 'e4', from: 'again', to: 'count' },
    ],
  });
}

test('trigger -> forager -> terminal -> Rest', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(terminalComposition(), { executeForager: executor, now: () => clock });

  assert.equal(runtime.snapshot().rest, true);

  await runtime.admit('start', { message: 'hello' });
  assert.equal(runtime.snapshot().rest, false);
  assert.equal(runtime.snapshot().nodes['start']?.receptor.length, 1);

  await runtime.settle();

  assert.equal(calls.length, 1);
  const first = calls[0];
  assert.ok(first !== undefined);
  assert.equal(serializeValue(first.input), 'hello');
  assert.equal(first.nodeId, 'start');

  const after = runtime.snapshot();
  assert.equal(queuedEntries(after).length, 0);
  assert.equal(after.rest, true);
  assert.equal(after.nodes['start']?.active, undefined);
  assert.equal(after.nodes['start']?.lastActivatedAt, new Date(START).toISOString());
});

test('a terminal node emits no new pheromone', async () => {
  let clock = START;
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(terminalComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', { message: '' });
  await runtime.settle();

  assert.deepEqual(queuedEntries(runtime.snapshot()), []);
});

test('a declarative condition rule follows the true and false edges', async () => {
  let clock = START;
  const { executor, calls } = recorder((_node, input) => input);
  const runtime = new PheromoneRuntime(
    conditionComposition({ path: 'message', equals: 'yes please' }),
    {
      executeForager: executor,
      now: () => clock,
    },
  );

  runtime.admit('start', { message: 'yes please' });
  await runtime.settle();
  clock += 1000;
  runtime.admit('start', { message: 'nope' });
  await runtime.settle();

  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ['start', 'yes', 'start', 'no'],
  );
  assert.equal(runtime.snapshot().rest, true);
});

test('a boolean rule compares an ordinary Value field', async () => {
  let clock = START;
  const { executor, calls } = recorder(
    () => ({ message: 'ok' }),
  );
  const runtime = new PheromoneRuntime(
    conditionComposition({ path: 'boolean', equals: true }),
    {
      executeForager: executor,
      now: () => clock,
    },
  );

  runtime.admit('check', { boolean: true });
  await runtime.settle();
  clock += 1000;
  runtime.admit('check', { boolean: false });
  await runtime.settle();

  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ['yes', 'no'],
  );
});

test('a choice rule compares the selected choice', async () => {
  let clock = START;
  const { executor, calls } = recorder(
    () => ({ message: 'ok' }),
  );
  const runtime = new PheromoneRuntime(
    conditionComposition({ path: 'choice', equals: 'approve' }),
    {
      executeForager: executor,
      now: () => clock,
    },
  );

  runtime.admit('check', { choice: 'approve' });
  await runtime.settle();
  clock += 1000;
  runtime.admit('check', { choice: 'reject' });
  await runtime.settle();

  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ['yes', 'no'],
  );
});

test('counter increments until max and then takes the done edge', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(counterComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', { message: '' });
  await runtime.settle();
  clock += 1000;
  await runtime.settle();

  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ['start', 'again', 'done'],
  );
  const count = runtime.snapshot().nodes['count'];
  assert.ok(count !== undefined);
  assert.equal(count.state['count'], 2);
  assert.equal(runtime.snapshot().rest, true);
});

test('trigger rejects unknown targets and accepts any loaded Bee', async () => {
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(conditionComposition({ path: 'message', exists: true }), {
    executeForager: executor,
    now: () => START,
  });

  await assert.rejects(
    runtime.admit('ghost', { message: '' }),
    /unknown node 'ghost'/,
  );
  // ARCH §4.1: any loaded Bee may be the entry Bee; a control Bee applies its
  // own rules to the delivered value.
  await runtime.admit('check', { message: '' });
  assert.equal(runtime.snapshot().nodes['check']?.receptor.length, 1);
});

test('snapshot is immutable and does not leak internal state', async () => {
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(terminalComposition(), { executeForager: executor, now: () => START });

  runtime.admit('start', { message: 'x' });
  const snapshot = runtime.snapshot();
  const start = snapshot.nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.receptor.length, 1);

  assert.throws(() => {
    (snapshot as { rest: boolean }).rest = false;
  }, TypeError);
  assert.throws(() => {
    (start.receptor as unknown as unknown[]).push({});
  }, TypeError);

  const fresh = runtime.snapshot();
  const freshStart = fresh.nodes['start'];
  assert.ok(freshStart !== undefined);
  assert.equal(freshStart.receptor.length, 1);
  assert.equal(fresh.rest, false);
});

test('log carries node, pheromone and outcome fields', async () => {
  const log = createMemoryLog();
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(terminalComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  await runtime.admit('start', { message: 'log me' });
  const enqueuedAt = runtime.snapshot().nodes['start']?.receptor[0]?.enqueuedAt;
  assert.equal(typeof enqueuedAt, 'string');
  await runtime.settle();

  const events = log.entries.map((entry) => entry.event);
  assert.deepEqual(events, [
    'pheromone.enqueued',
    'node.activated',
    'node.completed',
    'runtime.rest',
  ]);

  const activated = log.entries.find((entry) => entry.event === 'node.activated');
  assert.ok(activated !== undefined);
  assert.equal(activated.nodeId, 'start');
  assert.equal(activated.nodeKind, 'forager');
  assert.equal(activated.queueDepth, 0);
  assert.equal(activated.compositionId, 'terminal');
  assert.equal(typeof activated.graphRevision, 'string');

  const completed = log.entries.find((entry) => entry.event === 'node.completed');
  assert.ok(completed !== undefined);
  assert.equal(completed.outcome, 'ok');
  assert.equal(typeof completed.durationMs, 'number');
});

test('a failing executor is logged and dropped without surfacing an error', async () => {
  const log = createMemoryLog();
  const executor: NodeExecutor = {
    async execute() {
      throw new Error('boom');
    },
  };
  const runtime = new PheromoneRuntime(terminalComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.admit('start', { message: '' });
  await runtime.settle();

  const failed = log.entries.find((entry) => entry.event === 'node.failed');
  assert.ok(failed !== undefined);
  assert.equal(failed.error, 'boom');
  assert.equal(failed.outcome, 'failed');
  assert.equal(runtime.snapshot().nodes['start']?.active, undefined);
});

test('a failed activation leaves an empty field at Rest', async () => {
  const executor: NodeExecutor = {
    async execute() {
      throw new Error('boom');
    },
  };
  const runtime = new PheromoneRuntime(twoNodeComposition(), { executeForager: executor, now: () => START });

  runtime.admit('a', { message: '' });
  await runtime.settle();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['a']?.active, undefined);
  assert.deepEqual(queuedEntries(snapshot), []);
  assert.equal(snapshot.rest, true);
});

test('a failure drops only its input and the same drain continues', async () => {
  let attempts = 0;
  const executor: NodeExecutor = {
    async execute() {
      attempts += 1;
      throw new Error('boom');
    },
  };
  const base = twoNodeComposition();
  const fast = {
    ...base,
    nodes: new Map(
      [...base.nodes].map(([id, node]) => [id, { ...node, minIntervalMs: 0 }]),
    ),
  };
  const runtime = new PheromoneRuntime(fast, { executeForager: executor, now: () => START });

  runtime.admit('a', { message: 'first' });
  runtime.admit('a', { message: 'second' });
  await runtime.settle();

  const snapshot = runtime.snapshot();
  const node = snapshot.nodes['a'];
  assert.ok(node !== undefined);
  assert.equal(node.receptor.length, 0);
  assert.deepEqual(queuedEntries(snapshot), []);
  // The failed input is not replayed, but the next queued input still runs.
  assert.equal(attempts, 2);
  assert.equal(snapshot.rest, true);
});

test('a failure on one node leaves another node runnable', async () => {
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node) {
      if (node.id === 'a') {
        throw new Error('boom');
      }
      calls.push(node.id);
      return { message: 'ok' };
    },
  };
  const runtime = new PheromoneRuntime(twoNodeComposition(), { executeForager: executor, now: () => START });

  runtime.admit('a', { message: '' });
  runtime.admit('b', { message: '' });
  await runtime.settle();

  assert.equal(runtime.snapshot().nodes['a']?.active, undefined);
  assert.deepEqual(calls, ['b']);
  assert.equal(runtime.snapshot().rest, true);
});

test('serializeValue and renderPrompt cover the documented template rule', () => {
  assert.equal(serializeValue({ message: 'hello' }), 'hello');
  assert.equal(serializeValue({ choice: 'a' }), '{"choice":"a"}');
  assert.equal(serializeValue({ boolean: true }), '{"boolean":true}');
  assert.equal(serializeValue({ message: 'hi', attachments: [] }), 'hi');
  assert.equal(serializeValue({ attachments: [] }), '');

  assert.equal(renderPrompt('Review:\n{{message}}', { message: 'code' }), 'Review:\ncode');
  assert.equal(renderPrompt('no placeholder', { message: 'x' }), 'no placeholder');
});

test('two deliveries create independent Pheromones with no identity', async () => {
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(terminalComposition(), { executeForager: executor, now: () => START });

  await runtime.admit('start', { message: '' });
  await runtime.admit('start', { message: '' });
  const queued = runtime.snapshot().nodes['start']?.receptor ?? [];
  assert.equal(queued.length, 2);
  assert.notEqual(queued[0], queued[1]);
  for (const pheromone of queued) {
    assert.deepEqual(Object.keys(pheromone).sort(), ['enqueuedAt', 'value']);
  }

  await runtime.settle();
  // The node's pacing interval holds the second input until the clock advances.
  assert.equal(calls.length, 1);
  assert.equal(runtime.snapshot().nodes['start']?.pending !== undefined, true);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(serializeValue(call.input), '');
});

test('settle is idempotent when nothing is runnable', async () => {
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(terminalComposition(), { executeForager: executor, now: () => START });

  await runtime.settle();
  await runtime.settle();
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.deepEqual(queuedEntries(snapshot), []);
});

test('log entries are well formed for every event emitted', async () => {
  const log = createMemoryLog();
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(conditionComposition({ path: 'message', equals: 'go' }), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.admit('start', { message: 'go' });
  await runtime.settle();

  for (const entry of log.entries as RuntimeLogEntry[]) {
    assert.equal(typeof entry.at, 'string');
    assert.equal(entry.compositionId, 'branch');
    assert.equal(typeof entry.event, 'string');
  }
});

function queuedEntries(snapshot: import('../src/runtime/index.js').PheromoneFieldSnapshot) {
  return Object.values(snapshot.nodes).flatMap((node) => [...node.receptor]);
}