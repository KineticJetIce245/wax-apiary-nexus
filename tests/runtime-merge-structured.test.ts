import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  type CompositionDefinition,
  type NodeExecutor,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-07-02T00:00:00.000Z');
const TIMEOUT = 5000;

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

/**
 * start -> fork:
 *   required b -> ask -> merge, required a -> make-a -> merge,
 *   optional d -> make-d -> merge, optional c -> make-c -> merge.
 * Required order is [b, a] and optional order is [d, c], while arrival order is
 * a, d, c, b.
 */
function objectCombineComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'structured-object-combine',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'make-a' },
            { id: 'b', to: 'ask-b' },
            { id: 'c', to: 'make-c' },
            { id: 'd', to: 'make-d' },
          ],
        },
      },
      'make-a': { kind: 'forager', config: { connection: 'codex', prompt: 'a' } },
      'ask-b': { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      'make-c': { kind: 'forager', config: { connection: 'codex', prompt: 'c' } },
      'make-d': { kind: 'forager', config: { connection: 'codex', prompt: 'd' } },
      merge: {
        kind: 'merge',
        config: { required: ['b', 'a'], optional: ['d', 'c'], combine: 'object' },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make-a', to: 'merge' },
      { id: 'e3', from: 'ask-b', to: 'merge' },
      { id: 'e4', from: 'make-c', to: 'merge' },
      { id: 'e5', from: 'make-d', to: 'merge' },
      { id: 'e6', from: 'merge', to: 'done' },
    ],
  });
}

/**
 * start -> fork: required b -> make-b, required a -> make-a, optional c -> ask.
 * The required set completes before the optional branch is answered.
 */
function arrayCombineComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'structured-array-combine',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'make-a' },
            { id: 'b', to: 'make-b' },
            { id: 'c', to: 'ask-c' },
          ],
        },
      },
      'make-a': { kind: 'forager', config: { connection: 'codex', prompt: 'a' } },
      'make-b': { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
      'ask-c': { kind: 'user', config: { modality: 'text', prompt: 'C?' } },
      merge: {
        kind: 'merge',
        config: { required: ['b', 'a'], optional: ['c'], combine: 'array' },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make-a', to: 'merge' },
      { id: 'e3', from: 'make-b', to: 'merge' },
      { id: 'e4', from: 'ask-c', to: 'merge' },
      { id: 'e5', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a,b -> merge required); merge -> done. */
function directComposition(combine: 'text' | 'object' | 'array'): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: `structured-direct-${combine}`,
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'make-a' },
            { id: 'b', to: 'make-b' },
          ],
        },
      },
      'make-a': { kind: 'forager', config: { connection: 'codex', prompt: 'a' } },
      'make-b': { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make-a', to: 'merge' },
      { id: 'e3', from: 'make-b', to: 'merge' },
      { id: 'e4', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a -> merge required, b -> boom optional); merge -> done. */
function optionalFailureComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'structured-optional-failure',
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
      merge: {
        kind: 'merge',
        config: { required: ['a'], optional: ['b'], combine: 'object' },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a -> merge required, b -> sink); merge never completes. */
function timeoutComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'structured-timeout',
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
      merge: {
        kind: 'merge',
        config: { required: ['a', 'b'], combine: 'object', timeoutMs: TIMEOUT },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

function structuredOutput(value: Value): Extract<Value, { kind: 'structured' }> {
  assert.equal(value.kind, 'structured');
  if (value.kind !== 'structured') {
    assert.fail('expected a structured Value');
  }
  return value;
}

test('object combine keys by branchId in required then arrived optional order', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder((nodeId) => {
    switch (nodeId) {
      case 'make-a':
        return { kind: 'message', text: 'A', attachments: [] };
      case 'make-c':
        return { kind: 'choice', choice: 'see' };
      case 'make-d':
        return { kind: 'structured', value: { nested: true } };
      default:
        return text('B');
    }
  });
  const runtime = new PheromoneRuntime(objectCombineComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  // The Merge is rate-limited after its first arrival; let the queued optional
  // branches arrive before the last required branch is answered.
  clock += 1000;
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  const join = Object.values(waiting.nodes['merge']?.joins ?? {})[0];
  assert.ok(join !== undefined);
  assert.deepEqual(
    join.arrived.map((pheromone) => pheromone.branchId).sort(),
    ['a', 'c', 'd'],
    'both optional branches arrived before the last required branch',
  );
  const token = waiting.nodes['ask-b']?.hover?.token;
  assert.ok(token !== undefined);

  runtime.answerHover('ask-b', text('B'), token);
  clock += 1000;
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  const output = structuredOutput(doneCalls[0]?.input as Value);
  const payload = output.value;
  assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload));
  const object = payload as Record<string, Value>;
  assert.deepEqual(Object.keys(object), ['b', 'a', 'd', 'c']);
  assert.deepEqual(object['b'], text('B'));
  assert.deepEqual(object['a'], { kind: 'message', text: 'A', attachments: [] });
  assert.deepEqual(object['d'], { kind: 'structured', value: { nested: true } });
  assert.deepEqual(object['c'], { kind: 'choice', choice: 'see' });
  assert.equal(runtime.snapshot().rest, true);

  const emitted = log.entries
    .filter((entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done')
    .at(-1);
  assert.ok(emitted !== undefined);
  assert.equal(emitted.forkId, undefined);
  assert.equal(emitted.branchId, undefined);
});

test('array combine uses required then arrived optional order and excludes a late optional', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder((nodeId) => {
    switch (nodeId) {
      case 'make-a':
        return { kind: 'choice', choice: 'A' };
      case 'make-b':
        return { kind: 'boolean', value: true };
      default:
        return text('late');
    }
  });
  const runtime = new PheromoneRuntime(arrayCombineComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  // The second required arrival is rate-limited behind the first.
  clock += 1000;
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1, 'the required set completes without the optional branch');
  const output = structuredOutput(doneCalls[0]?.input as Value);
  assert.ok(Array.isArray(output.value));
  assert.deepEqual(output.value, [
    { kind: 'boolean', value: true },
    { kind: 'choice', choice: 'A' },
  ]);

  const token = runtime.snapshot().nodes['ask-c']?.hover?.token;
  assert.ok(token !== undefined, 'the optional branch is still waiting');
  runtime.answerHover('ask-c', text('late'), token);
  clock += 1000;
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
  assert.equal(runtime.snapshot().rest, true);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.optional-dropped'));
});

test('text combine serializes structured branch values instead of flattening them', async () => {
  let clock = START;
  const { executor, calls } = recorder((nodeId) => {
    if (nodeId === 'make-a') {
      return { kind: 'structured', value: { a: 1 } };
    }
    if (nodeId === 'make-b') {
      return { kind: 'structured', value: { b: [2, null] } };
    }
    return text('seed');
  });
  const runtime = new PheromoneRuntime(directComposition('text'), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  // The second required arrival is rate-limited behind the first.
  clock += 1000;
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  const output = doneCalls[0]?.input as Value;
  assert.equal(output.kind, 'text');
  assert.equal(serializeValue(output), '{"a":1}\n{"b":[2,null]}');
});

test('an optional failure does not fail a structured required set', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder((nodeId) => {
    if (nodeId === 'boom') {
      throw new Error('optional branch exploded');
    }
    return text('seed');
  });
  const runtime = new PheromoneRuntime(optionalFailureComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  const output = structuredOutput(doneCalls[0]?.input as Value);
  const payload = output.value;
  assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload));
  assert.deepEqual(Object.keys(payload), ['a']);
  assert.deepEqual((payload as Record<string, Value>)['a'], text('seed'));
  assert.ok(log.entries.some((entry) => entry.event === 'merge.optional-failed'));
  assert.equal(
    log.entries.filter((entry) => entry.event === 'merge.failed').length,
    0,
    'the failed optional branch never fails the join',
  );
  assert.equal(runtime.snapshot().rest, true);
});

test('a structured combine times out without emitting a Value', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(timeoutComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  const waitingJoin = Object.values(waiting.nodes['merge']?.joins ?? {})[0];
  const deadline = waitingJoin?.deadlineAt;
  assert.ok(deadline !== undefined);

  clock = deadline;
  await runtime.pump();

  const timedOut = runtime.snapshot();
  assert.equal(timedOut.rest, true);
  const join = Object.values(timedOut.nodes['merge']?.joins ?? {})[0];
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.deepEqual(join.arrived, []);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.timed-out'));
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'timed-out');
});
