import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NotImplementedError,
  PheromoneRuntime,
  type GatherNode,
} from '../src/runtime/index.js';
import { fastDefinition, recorder, runtimeOf } from './support/m19-runtime.js';

// The M19c spread placeholder was replaced by real cases in
// tests/runtime-spread.test.ts. Gather assemble/batch is still M19d.

test('the M19 gather assemble config parses; its execution path is typed not-implemented', async () => {
  const definition = fastDefinition('gather-placeholder', {
    gather: {
      kind: 'gather',
      config: {
        strategy: 'assemble',
        types: {
          draft: {
            match: { path: 'role', equals: 'draft' },
            count: 1,
            reads: ['message'],
          },
        },
      },
    },
  });
  const node = definition.nodes.get('gather');
  assert.ok(node !== undefined && node.kind === 'gather');
  const config = (node as GatherNode).config;
  assert.equal(config.strategy, 'assemble');
  assert.equal(config.typeQueueMax, 256);

  const runtime = runtimeOf(definition, recorder().executor);
  await runtime.admit('gather', { role: 'draft', message: 'x' });
  await assert.rejects(
    runtime.pump(),
    (error: unknown) =>
      error instanceof NotImplementedError &&
      error.code === 'not-implemented' &&
      /M19d/.test(error.message),
  );
});
