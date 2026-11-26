import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  type NodeExecutor,
  type RuntimeLogEntry,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-05-01T00:00:00.000Z');

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function pheromoneIds(entries: readonly RuntimeLogEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.pheromoneId !== undefined) {
      ids.push(entry.pheromoneId);
    }
  }
  return ids;
}

/** a -> b: one ordinary beeline between two foragers. */
function chainComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'identity-chain',
    nodes: {
      a: { kind: 'forager', config: { connection: 'codex', prompt: 'a {{input}}' } },
      b: { kind: 'forager', config: { connection: 'codex', prompt: 'b {{input}}' } },
    },
    edges: [{ id: 'e1', from: 'a', to: 'b' }],
  });
}

/** start -> fork (a -> ask-a, b -> ask-b): a cardinality change. */
function forkComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'identity-fork',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'ask-a' },
            { id: 'b', to: 'ask-b' },
          ],
        },
      },
      'ask-a': { kind: 'user', config: { modality: 'text', prompt: 'A?' } },
      'ask-b': { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
    },
    edges: [{ id: 'e1', from: 'start', to: 'fork' }],
  });
}

/** start -> ask (user) -> done: a hover pauses and resumes the same beeline. */
function hoverComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'identity-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Q?' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done {{input}}' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'ask' },
      { id: 'e2', from: 'ask', to: 'done' },
    ],
  });
}

test('a normal beeline moves the same Pheromone id from bee to bee', async () => {
  const log = createMemoryLog();
  const calls: { nodeId: string; input: Value }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push({ nodeId: node.id, input });
      return { kind: 'text', text: `out:${node.id}:${serializeValue(input)}` };
    },
  };
  const runtime = new PheromoneRuntime(chainComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  await runtime.admit('a', text('hello'));
  await runtime.pump();

  assert.deepEqual(calls.map((call) => call.nodeId), ['a', 'b']);
  // The target bee runs the source bee's replaced value, not the trigger.
  assert.deepEqual(calls[1]?.input, text('out:a:hello'));

  const activated = log.entries.filter((entry) => entry.event === 'node.activated');
  assert.deepEqual(activated.map((entry) => entry.nodeId), ['a', 'b']);
  const first = activated[0]?.pheromoneId;
  const second = activated[1]?.pheromoneId;
  assert.equal(typeof first, 'string');
  assert.equal(second, first, 'a normal beeline must move the same Pheromone id to the next bee');

  // Nothing in the run created a second identity: the trigger, the activation,
  // the emission and the target activation all refer to one Pheromone.
  const ids = new Set(pheromoneIds(log.entries));
  assert.deepEqual([...ids], [first]);
});

test('a user hover resumes the same Pheromone id after the answer', async () => {
  const log = createMemoryLog();
  const executor: NodeExecutor = {
    async execute() {
      return text('ran');
    },
  };
  const runtime = new PheromoneRuntime(hoverComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  await runtime.admit('start', text('hello'));
  await runtime.pump();
  assert.ok(runtime.snapshot().nodes['ask']?.hover !== undefined, 'the user bee is hovering');

  runtime.answerHover('ask', text('answered'));
  await runtime.pump();

  const activated = log.entries.filter((entry) => entry.event === 'node.activated');
  assert.deepEqual(activated.map((entry) => entry.nodeId), ['start', 'ask', 'done']);
  const ids = new Set(activated.map((entry) => entry.pheromoneId));
  assert.equal(ids.size, 1, 'the hovered Pheromone keeps its identity after the answer');
  assert.equal(typeof activated[0]?.pheromoneId, 'string');
  const hoverOpened = log.entries.find((entry) => entry.event === 'hover.opened');
  const hoverResolved = log.entries.find((entry) => entry.event === 'hover.resolved');
  assert.equal(hoverOpened?.pheromoneId, activated[0]?.pheromoneId);
  assert.equal(hoverResolved?.pheromoneId, activated[0]?.pheromoneId);
});

test('fork still copies the Pheromone into one new id per branch', async () => {
  const log = createMemoryLog();
  const executor: NodeExecutor = {
    async execute() {
      return text('branched');
    },
  };
  const runtime = new PheromoneRuntime(forkComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  await runtime.admit('start', text('hello'));
  await runtime.pump();

  const input = log.entries.find(
    (entry) => entry.event === 'node.activated' && entry.nodeId === 'start',
  )?.pheromoneId;
  assert.equal(typeof input, 'string');

  const branchTargets = new Set(['ask-a', 'ask-b']);
  const emitted = log.entries.filter(
    (entry) => entry.event === 'pheromone.emitted' && branchTargets.has(entry.nodeId ?? ''),
  );
  assert.equal(emitted.length, 2, 'one copy per fork branch');
  const branchIds = emitted.map((entry) => entry.pheromoneId);
  assert.equal(typeof branchIds[0], 'string');
  assert.equal(typeof branchIds[1], 'string');
  assert.notEqual(branchIds[0], branchIds[1], 'each branch copy gets its own id');
  assert.equal(emitted[0]?.forkId, emitted[1]?.forkId, 'both copies share the fork tag');
  assert.notEqual(emitted[0]?.branchId, emitted[1]?.branchId, 'each copy carries its own branch');
  assert.ok(
    branchIds.every((id) => id !== input),
    'fork is a cardinality change: no branch keeps the input id',
  );
});
