import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryLog, type GatherNode } from '../src/runtime/index.js';
import { fastDefinition, recorder, runtimeOf } from './support/m19-runtime.js';

// The M19c spread placeholder was replaced by real cases in
// tests/runtime-spread.test.ts. Gather assemble/batch is still M19e.

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

  const log = createMemoryLog();
  const runtime = runtimeOf(definition, recorder().executor, { onLog: log.sink });
  await runtime.admit('gather', { role: 'draft', message: 'x' });
  await runtime.settle();
  // The placeholder input is dropped and logged; it is never executed as a
  // package until M19e implements gather.
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'gather',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /M19e/);
  assert.equal(runtime.snapshot().nodes['gather']?.active, undefined);
  assert.equal(runtime.snapshot().rest, true);
});
