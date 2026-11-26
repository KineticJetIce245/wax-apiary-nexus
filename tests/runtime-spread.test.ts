import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  PheromoneRuntime,
  SpreadEmitError,
  type CompositionDefinition,
  type PheromoneFieldSnapshot,
  type SpreadNode,
  type Value,
} from '../src/runtime/index.js';
import { fastDefinition, recorder, runtimeOf, text } from './support/m19-runtime.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function forager(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'fake', prompt } };
}

function user(prompt = 'park'): Record<string, unknown> {
  return { kind: 'user', config: { modality: 'text', prompt } };
}

function cloneNode(targets: unknown): Record<string, unknown> {
  return { kind: 'spread', config: { strategy: 'clone', targets } };
}

function cleaveNode(targets: Record<string, readonly string[]>): Record<string, unknown> {
  return { kind: 'spread', config: { strategy: 'cleave', targets } };
}

/** A user target keeps its copy parked as `hoverPheromone`, so tests can read it. */
function parkedValue(snapshot: PheromoneFieldSnapshot, nodeId: string): Value {
  const hover = snapshot.nodes[nodeId]?.hover;
  assert.ok(hover !== undefined, `node '${nodeId}' has no open hover`);
  const parked = snapshot.nodes[nodeId]?.hoverPheromone;
  assert.ok(parked !== undefined, `node '${nodeId}' has no parked Pheromone`);
  return parked.value;
}

test('clone with an ordered BeeId list emits one new Pheromone per target', async () => {
  const log = createMemoryLog();
  const definition = fastDefinition('spread-clone-list', {
    fan: cloneNode(['left', 'right']),
    left: user('left'),
    right: user('right'),
  });
  let tick = START;
  const runtime = runtimeOf(definition, recorder().executor, {
    now: () => (tick += 1),
    onLog: log.sink,
  });

  await runtime.admit('fan', { message: 'seed', meta: { nested: { n: 1 } } });
  await runtime.pump();

  const snapshot = runtime.snapshot();
  const left = parkedValue(snapshot, 'left');
  const right = parkedValue(snapshot, 'right');
  assert.deepEqual(left, { message: 'seed', meta: { nested: { n: 1 } } });
  assert.deepEqual(right, left);
  assert.notEqual(
    snapshot.nodes['left']?.hoverPheromone,
    snapshot.nodes['right']?.hoverPheromone,
    'every copy is a different Pheromone object',
  );
  assert.notEqual(left, right, 'every copy carries a different value object');

  // The input was consumed by the fan-out: no value, no last output, no queue.
  const fan = snapshot.nodes['fan'];
  assert.ok(fan !== undefined);
  assert.equal(fan.pending, undefined);
  assert.equal(fan.active, undefined);
  assert.equal(fan.receptor.length, 0);
  assert.equal(fan.lastOutput, undefined, 'a spread writes no last output');

  const emitted = log.entries.filter((entry) => entry.event === 'pheromone.emitted');
  assert.deepEqual(
    emitted.map((entry) => entry.nodeId),
    ['left', 'right'],
    'emission follows the configured target order',
  );
  const stamps = emitted.map((entry) => entry.enqueuedAt);
  assert.ok(stamps[0] !== undefined && stamps[1] !== undefined);
  assert.notEqual(stamps[0], stamps[1], 'each copy gets its own queue instant');
});

test('clone accepts a BeeId map and ignores its values', async () => {
  const definition = fastDefinition('spread-clone-map', {
    fan: cloneNode({ left: true, right: 'ignored-value' }),
    left: forager('left {{message}}'),
    right: forager('right {{message}}'),
  });
  const { executor, calls } = recorder();
  const runtime = runtimeOf(definition, executor);

  await runtime.admit('fan', text('seed'));
  await runtime.pump();

  assert.deepEqual(calls.map((call) => call.nodeId), ['left', 'right']);
  assert.deepEqual(calls[0]?.input, { message: 'seed' });
  assert.deepEqual(calls[1]?.input, { message: 'seed' });
  assert.equal(runtime.snapshot().rest, true);
});

test('cleave projects only the listed dot paths into each part', async () => {
  const definition = fastDefinition('spread-cleave', {
    fan: cleaveNode({
      topic: ['message', 'meta.topic'],
      items: ['items', 'meta.extra'],
    }),
    topic: user('topic'),
    items: user('items'),
  });
  const runtime = runtimeOf(definition, recorder().executor);

  await runtime.admit('fan', {
    message: 'seed',
    meta: { topic: 'review', extra: true, secret: 'never-projected' },
    items: [{ name: 'one' }],
  });
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.deepEqual(parkedValue(snapshot, 'topic'), {
    message: 'seed',
    meta: { topic: 'review' },
  });
  assert.deepEqual(parkedValue(snapshot, 'items'), {
    meta: { extra: true },
    items: [{ name: 'one' }],
  });
  assert.equal(
    JSON.stringify(snapshot.nodes).includes('never-projected'),
    false,
    'a cleave part never carries an unlisted field',
  );
});

test('cleave supports a read through an array index path', async () => {
  const definition = fastDefinition('spread-cleave-array', {
    fan: cleaveNode({ first: ['items.0.name'] }),
    first: user('first'),
  });
  const runtime = runtimeOf(definition, recorder().executor);

  await runtime.admit('fan', { items: [{ name: 'first' }, { name: 'second' }] });
  await runtime.pump();

  assert.deepEqual(parkedValue(runtime.snapshot(), 'first'), {
    items: [{ name: 'first' }],
  });
});

test('a missing cleave path is a typed error and emits nothing', async () => {
  const log = createMemoryLog();
  const definition = fastDefinition('spread-cleave-missing', {
    fan: cleaveNode({
      left: ['message', 'meta.absent'],
      right: ['message'],
    }),
    left: user('left'),
    right: forager('right {{message}}'),
  });
  const { executor, calls } = recorder();
  const runtime = runtimeOf(definition, executor, { onLog: log.sink });

  await runtime.admit('fan', { message: 'seed', meta: {} });
  await assert.rejects(
    runtime.pump(),
    (error: unknown) =>
      error instanceof SpreadEmitError &&
      /target 'left' is missing path 'meta.absent'/.test(error.message),
  );

  // Nothing was emitted: the valid sibling target was not partially served.
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['left']?.hover, undefined);
  assert.equal(snapshot.nodes['right']?.receptor.length, 0);
  assert.deepEqual(calls, []);
  assert.equal(snapshot.nodes['fan']?.lastOutput, undefined);
  assert.equal(snapshot.rest, true);
  assert.ok(
    log.entries.some(
      (entry) => entry.event === 'node.failed' && entry.nodeId === 'fan',
    ),
    'the typed error is logged',
  );
});

test('a hand-built spread with an unknown target fails before emitting', async () => {
  const parsed = fastDefinition('spread-unknown', {
    fan: cloneNode(['left', 'right']),
    left: user('left'),
    right: user('right'),
  });
  const nodes = new Map(parsed.nodes);
  nodes.delete('right');
  const broken: CompositionDefinition = { ...parsed, nodes };
  const runtime = new PheromoneRuntime(broken, { executeForager: recorder().executor });

  await runtime.admit('fan', text('seed'));
  await assert.rejects(
    runtime.pump(),
    (error: unknown) =>
      error instanceof SpreadEmitError && /targets unknown bee 'right'/.test(error.message),
  );
  assert.equal(runtime.snapshot().nodes['left']?.hover, undefined);
});

test('the spread parser rejects an unknown target BeeId', () => {
  assert.throws(
    () =>
      fastDefinition('spread-unknown-parse', {
        fan: cloneNode(['ghost']),
      }),
    /unknown node 'ghost'/,
  );
});

test('the spread parser rejects empty targets', () => {
  assert.throws(
    () => fastDefinition('spread-empty-list', { fan: cloneNode([]) }),
    /expected at least one target BeeId/,
  );
  assert.throws(
    () => fastDefinition('spread-empty-map', { fan: cloneNode({}) }),
    /expected at least one target BeeId/,
  );
  assert.throws(
    () => fastDefinition('spread-empty-cleave', { fan: cleaveNode({}) }),
    /expected at least one target BeeId/,
  );
});

test('the spread parser rejects duplicate targets and empty cleave paths', () => {
  assert.throws(
    () =>
      fastDefinition('spread-duplicate', {
        fan: cloneNode(['left', 'left']),
        left: user('left'),
      }),
    /duplicate target 'left'/,
  );
  assert.throws(
    () =>
      fastDefinition('spread-cleave-empty-paths', {
        fan: cleaveNode({ left: [] }),
        left: user('left'),
      }),
    /expected a non-empty dot-path array/,
  );
});

test('a spread has no normal outgoing edge', () => {
  assert.throws(
    () =>
      fastDefinition(
        'spread-edge',
        {
          fan: cloneNode(['left']),
          left: user('left'),
        },
        [{ id: 'e1', from: 'fan', to: 'left' }],
      ),
    /a spread node uses config.targets and has no normal outgoing edge/,
  );
});

test('the parsed spread config is the new strategy/targets shape', () => {
  const definition = fastDefinition('spread-shape', {
    fan: cloneNode(['left']),
    left: user('left'),
  });
  const fan = definition.nodes.get('fan');
  assert.ok(fan !== undefined && fan.kind === 'spread');
  assert.deepEqual((fan as SpreadNode).config, {
    strategy: 'clone',
    targets: ['left'],
  });
});
