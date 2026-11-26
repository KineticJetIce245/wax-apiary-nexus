import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseComposition,
  PheromoneRuntime,
  type NodeExecutor,
  type Pheromone,
  type QueueEntry,
  type RuntimeOptions,
  type Value,
} from '../src/runtime/index.js';
import type { EngineContext } from '../src/runtime/engine-context.js';
import { emitAlong } from '../src/runtime/emit.js';
import { createNodeState } from '../src/runtime/field.js';
import {
  createEntry,
  stagePending,
  type QueueContext,
} from '../src/runtime/queue.js';
import { fastDefinition, text } from './support/m19-runtime.js';

const START = Date.parse('2026-07-01T00:00:00.000Z');

function chain(): ReturnType<typeof parseComposition> {
  return fastDefinition(
    'same-pheromone',
    {
      first: { kind: 'forager', config: { connection: 'fake', prompt: 'first' } },
      second: { kind: 'forager', config: { connection: 'fake', prompt: 'second' } },
    },
    [{ id: 'first-second', from: 'first', to: 'second' }],
    { queueMax: 8, queueTtlMs: 60_000 },
  );
}

function runtimeWith(executor: NodeExecutor, now = START): PheromoneRuntime {
  return new PheromoneRuntime(chain(), { executeForager: executor, now: () => now });
}

test('a normal beeline carries the same value object (no message identity)', async () => {
  const seen: { nodeId: string; input: Value }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      seen.push({ nodeId: node.id, input });
      return node.id === 'first' ? { reply: 'ok' } : { final: true };
    },
  };
  const runtime = runtimeWith(executor);
  await runtime.admit('first', text('start'));
  await runtime.pump();

  assert.deepEqual(seen.map((call) => call.nodeId), ['first', 'second']);
  const firstInput = seen[0]?.input;
  const secondInput = seen[1]?.input;
  assert.ok(firstInput !== undefined && secondInput !== undefined);
  // Write-back creates the merged value; the reply is never adopted by
  // reference. The downstream Bee sees exactly one merged object.
  assert.deepEqual(secondInput, { message: 'start', reply: 'ok' });
  assert.deepEqual(firstInput, { message: 'start' });
});

test('a user answer is bound to the same object the caller supplied', async () => {
  const seen: Value[] = [];
  const runtime = new PheromoneRuntime(
    fastDefinition(
      'answer-ref',
      {
        ask: { kind: 'user', config: { modality: 'text', prompt: '?' } },
        done: { kind: 'forager', config: { connection: 'fake', prompt: 'done' } },
      },
      [{ id: 'ask-done', from: 'ask', to: 'done' }],
    ),
    {
      executeForager: {
        async execute(_node, input) {
          seen.push(input);
          return { final: true };
        },
      },
      now: () => START,
    },
  );
  await runtime.admit('ask', text('seed'));
  await runtime.pump();
  const answer: Value = { message: 'yes', extra: { n: 1 } };
  runtime.answerHover('ask', answer);
  await runtime.pump();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], answer, 'the answered object moves along the beeline');
  assert.deepEqual(seen[0], { message: 'yes', extra: { n: 1 } });
});

test('the queue entry owns enqueuedAt; the Pheromone has no id/at/lineage', async () => {
  const runtime = runtimeWith({ async execute(_node, input) { return input; } });
  await runtime.admit('first', text('one'));

  const entry = runtime.snapshot().nodes['first']?.receptor[0];
  assert.ok(entry !== undefined);
  assert.deepEqual(Object.keys(entry).sort(), ['enqueuedAt', 'value']);
  assert.equal(entry.enqueuedAt, new Date(START).toISOString());
  assert.deepEqual(Object.keys(entry.value), ['message']);
});

test('two deliveries are distinct values with no ids', async () => {
  const runtime = runtimeWith({ async execute(_node, input) { return input; } });
  const first: Value = { message: 'first' };
  const second: Value = { message: 'second' };
  await runtime.admit('first', first);
  await runtime.admit('first', second);

  const entries = runtime.snapshot().nodes['first']?.receptor ?? [];
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0], entries[1]);
  assert.notEqual(entries[0]?.value, entries[1]?.value);
  assert.deepEqual(entries.map((entry) => entry.value), [first, second]);
});

test('admission clones the caller value so later mutations cannot leak in', async () => {
  const runtime = runtimeWith({ async execute(_node, input) { return input; } });
  const input: Value = { message: 'one', nested: { n: 1 } };
  await runtime.admit('first', input);
  input['message'] = 'mutated';
  (input['nested'] as Record<string, unknown>)['n'] = 2;

  const entry = runtime.snapshot().nodes['first']?.receptor[0];
  assert.deepEqual(entry?.value, { message: 'one', nested: { n: 1 } });
});

test('every activation overwrites the field-owned last output', async () => {
  let reply = 'A';
  const runtime = new PheromoneRuntime(
    fastDefinition('overwrite', {
      start: { kind: 'forager', config: { connection: 'fake', prompt: 'p' } },
    }),
    {
      executeForager: { async execute() { return { message: reply }; } },
      now: () => START,
    },
  );
  await runtime.admit('start', text('x'));
  await runtime.pump();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, { message: 'A' });

  reply = 'B';
  await runtime.admit('start', text('x'));
  await runtime.pump();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, { message: 'B' });
});

interface EngineAccess {
  readonly engine: EngineContext;
}

function engineOf(runtime: PheromoneRuntime): EngineContext {
  return (runtime as unknown as EngineAccess).engine;
}

function queueContext(definition: ReturnType<typeof parseComposition>): QueueContext {
  return {
    definition,
    states: new Map([['first', createNodeState()], ['second', createNodeState()]]),
    now: () => START,
    log: () => undefined,
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('stagePending keeps the receptor head object as pending', () => {
  const definition = chain();
  const queue = queueContext(definition);
  const state = queue.states.get('first');
  assert.ok(state !== undefined);
  const node = definition.nodes.get('first');
  assert.ok(node !== undefined);
  const entry = createEntry(text('seed'), new Date(START).toISOString());
  state.receptor = [entry];

  assert.equal(stagePending(queue, node, state, false), true);
  assert.equal(state.pending, entry, 'pending is the receptor head object itself');
  assert.equal((state.pending as QueueEntry).enqueuedAt, entry.enqueuedAt);
});

test('emitAlong appends the same Pheromone object to the target receptor', () => {
  const definition = fastDefinition(
    'emit-same',
    {
      start: { kind: 'forager', config: { connection: 'fake', prompt: 'start' } },
      sink: { kind: 'forager', config: { connection: 'fake', prompt: 'sink' } },
    },
    [{ id: 'start-sink', from: 'start', to: 'sink' }],
  );
  const runtime = new PheromoneRuntime(definition, {
    executeForager: { async execute() { return { message: 'x' }; } },
    now: () => START,
  });
  const entry = createEntry(text('seed'), new Date(START - 1_000).toISOString());
  const start = definition.nodes.get('start');
  assert.ok(start !== undefined);

  emitAlong(engineOf(runtime), start, entry);

  const receptor = engineOf(runtime).states.get('sink')?.receptor ?? [];
  assert.equal(receptor[0], entry, 'the target receptor holds the same object');
  assert.equal(entry.enqueuedAt, new Date(START).toISOString(), 'the same object refreshed its instant');
});

test('a deferred normal beeline hands the same Pheromone object downstream', async () => {
  const definition = fastDefinition(
    'deferred-same',
    {
      start: { kind: 'forager', config: { connection: 'fake', prompt: 'start' } },
      sink: { kind: 'forager', config: { connection: 'fake', prompt: 'sink' } },
    },
    [{ id: 'start-sink', from: 'start', to: 'sink' }],
  );
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let startActive: Pheromone | undefined;
  let sinkActive: Pheromone | undefined;
  const runtime = new PheromoneRuntime(definition, {
    executeForager: {
      async execute(node) {
        const engine = engineOf(runtime);
        if (node.id === 'start') {
          startActive = engine.states.get('start')?.active;
          return { message: 'reply' };
        }
        sinkActive = engine.states.get('sink')?.active;
        await gate;
        return { message: 'done' };
      },
    },
    now: () => START,
  } satisfies RuntimeOptions);

  await runtime.admit('start', text('seed'));
  const pumping = runtime.pump();
  await waitUntil(() => sinkActive !== undefined, 'the sink activation');
  assert.equal(sinkActive, startActive, 'the downstream activation is the same Pheromone object');
  release();
  await pumping;
});
