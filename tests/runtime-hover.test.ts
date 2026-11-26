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

const START = Date.parse('2026-02-01T00:00:00.000Z');

interface Recorder {
  readonly executor: NodeExecutor;
  readonly calls: { nodeId: string; input: Value }[];
}

function recorder(output?: (input: Value) => Value): Recorder {
  const calls: { nodeId: string; input: Value }[] = [];
  return {
    calls,
    executor: {
      async execute(node, input) {
        calls.push({ nodeId: node.id, input });
        return output === undefined ? { kind: 'text', text: `out:${serializeValue(input)}` } : output(input);
      },
    },
  };
}

function askComposition(modality: Record<string, unknown> = { modality: 'text' }): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'ask',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'plan {{input}}' } },
      ask: { kind: 'user', config: { prompt: 'Approve?', ...modality } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'ask' },
      { id: 'e2', from: 'ask', to: 'done' },
    ],
  });
}

function userOnlyComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'user-only',
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Name?' } },
    },
    edges: [],
  });
}

test('a user node parks the Pheromone in a hover instead of running', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(askComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  const snapshot = runtime.snapshot();
  const ask = snapshot.nodes['ask'];
  assert.ok(ask !== undefined);
  assert.ok(ask.hover !== undefined);
  assert.equal(ask.hover.kind, 'user');
  assert.equal(ask.hover.nodeId, 'ask');
  assert.match(ask.hover.token, /^hv_/);
  assert.equal(snapshot.pheromones.length, 1);
  assert.equal(snapshot.rest, false);
  assert.deepEqual(calls.map((call) => call.nodeId), ['start']);
});

test('answering a hover resumes the graph and reaches Rest', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(askComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();
  const token = runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);

  runtime.answerHover('ask', { kind: 'text', text: 'yes' }, token);
  await runtime.pump();

  assert.deepEqual(calls.map((call) => call.nodeId), ['start', 'done']);
  assert.deepEqual(runtime.snapshot().pheromones, []);
  assert.equal(runtime.snapshot().rest, true);
});

test('a user node without an outgoing edge is terminal', async () => {
  let clock = START;
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(userOnlyComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('ask', { kind: 'text', text: 'ignored' });
  await runtime.pump();
  assert.ok(runtime.snapshot().nodes['ask']?.hover !== undefined);

  runtime.answerHover('ask', { kind: 'text', text: 'Ada' });
  await runtime.pump();

  assert.deepEqual(runtime.snapshot().pheromones, []);
  assert.equal(runtime.snapshot().rest, true);
});

test('an answer before the hover is rejected instead of being queued', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(askComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  assert.throws(
    () => runtime.answerHover('ask', { kind: 'text', text: 'early' }),
    /has no open hover/,
  );
  assert.deepEqual(log.entries, [], 'a refused early answer writes no log entry');
  assert.equal(runtime.snapshot().nodes['ask']?.hover, undefined);

  runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  const ask = runtime.snapshot().nodes['ask'];
  assert.ok(ask !== undefined);
  assert.ok(ask.hover !== undefined, 'the hover waits for a real answer');
  assert.equal(runtime.snapshot().rest, false);
  assert.deepEqual(calls.map((call) => call.nodeId), ['start']);
});

test('hover tokens and modalities are validated', async () => {
  let clock = START;
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(askComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();
  const token = runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);

  assert.throws(() => runtime.answerHover('ask', { kind: 'text', text: 'no' }, 'wrong'), /token mismatch/);
  assert.throws(() => runtime.answerHover('ask', { kind: 'boolean', value: true }), /expects a text value/);
  assert.throws(() => runtime.answerHover('start', { kind: 'text', text: 'no' }), /not a user node/);
});

test('yes-no accepts booleans and rejects text', async () => {
  let clock = START;
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(askComposition({ modality: 'yes-no' }), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  assert.throws(() => runtime.answerHover('ask', { kind: 'text', text: 'yes' }), /expects a boolean/);
  runtime.answerHover('ask', { kind: 'boolean', value: true });
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, true);
});

test('choice accepts only an offered label', async () => {
  let clock = START;
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(
    askComposition({ modality: 'choice', choices: ['approve', 'reject'] }),
    { executeForager: executor, now: () => clock },
  );

  runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  assert.throws(() => runtime.answerHover('ask', { kind: 'choice', choice: 'maybe' }), /does not offer choice/);
  runtime.answerHover('ask', { kind: 'choice', choice: 'approve' });
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, true);
});

test('a hovering node does not activate queued Pheromones', async () => {
  let clock = START;
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(userOnlyComposition(), { executeForager: executor, now: () => clock });

  runtime.admit('ask', { kind: 'text', text: 'first' });
  runtime.admit('ask', { kind: 'text', text: 'second' });
  await runtime.pump();

  const ask = runtime.snapshot().nodes['ask'];
  assert.ok(ask !== undefined);
  assert.ok(ask.hover !== undefined);
  assert.equal(ask.receptor.length, 1);

  runtime.answerHover('ask', { kind: 'text', text: 'answer' });
  clock += 1000;
  await runtime.pump();

  const second = runtime.snapshot().nodes['ask'];
  assert.ok(second !== undefined);
  assert.ok(second.hover !== undefined);
  assert.equal(second.receptor.length, 0);
});

test('the log records hover open and resolve', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(askComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();
  runtime.answerHover('ask', { kind: 'text', text: 'yes' });
  await runtime.pump();

  const events = log.entries.map((entry) => entry.event);
  assert.ok(events.includes('hover.opened'));
  assert.ok(events.includes('hover.resolved'));
  const resolved = log.entries.find((entry) => entry.event === 'hover.resolved');
  assert.equal(resolved?.outcome, 'answered');
});
