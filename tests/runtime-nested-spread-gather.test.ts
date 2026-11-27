import assert from 'node:assert/strict';
import test from 'node:test';

import { fastDefinition, recorder, runtimeOf } from './support/m19-runtime.js';

function gatherNode(reads: readonly string[]): Record<string, unknown> {
  return {
    kind: 'gather',
    config: {
      types: {
        t: { match: { path: 'role', equals: 't' }, count: 1, reads },
      },
    },
  };
}

function foragerNode(prompt: string): Record<string, unknown> {
  // The terminal sink accepts any package value; the built-in defaults would
  // require a `message` field that an assembled package does not have.
  return {
    kind: 'forager',
    reads: [],
    writes: [],
    config: { connection: 'fake', prompt },
  };
}

test('one spread clone feeds two gathers and each assembles its own package', async () => {
  const definition = fastDefinition('nested-spread-gather', {
    fan: { kind: 'spread', config: { strategy: 'clone', targets: ['left', 'right'] } },
    left: gatherNode(['message']),
    right: gatherNode(['message', 'meta.score']),
  });
  const { executor, calls } = recorder();
  const runtime = runtimeOf(definition, executor);

  await runtime.admit('fan', { role: 't', message: 'seed', meta: { score: 9 } });
  await runtime.settle();

  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.nodes['left']?.lastOutput, { t: ['seed'] });
  assert.deepEqual(snapshot.nodes['right']?.lastOutput, {
    t: [{ message: 'seed', meta: { score: 9 } }],
  });
  assert.equal(calls.length, 0, 'a gather consumes the copy without a forager run');
  assert.equal(snapshot.rest, true);
});

test('a gather package moves through a spread to every target', async () => {
  const definition = fastDefinition(
    'nested-gather-spread',
    {
      gather: {
        kind: 'gather',
        config: {
          types: {
            a: { match: { path: 'role', equals: 'a' }, count: 1, reads: ['message'] },
            b: { match: { path: 'role', equals: 'b' }, count: 1, reads: ['message'] },
          },
        },
      },
      fan: { kind: 'spread', config: { strategy: 'clone', targets: ['left', 'right'] } },
      left: foragerNode('left'),
      right: foragerNode('right'),
    },
    [{ id: 'gather-fan', from: 'gather', to: 'fan' }],
  );
  const { executor, calls } = recorder();
  const runtime = runtimeOf(definition, executor);

  await runtime.admit('gather', { role: 'a', message: 'a' });
  await runtime.admit('gather', { role: 'b', message: 'b' });
  await runtime.settle();

  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ['left', 'right'],
  );
  const packageValue = { a: ['a'], b: ['b'] };
  assert.deepEqual(calls[0]?.input, packageValue);
  assert.deepEqual(calls[1]?.input, packageValue);
  assert.equal(runtime.snapshot().rest, true);
});
