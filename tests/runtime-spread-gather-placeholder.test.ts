import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryLog, type GatherNode } from '../src/runtime/index.js';
import { fastDefinition, recorder, runtimeOf } from './support/m19-runtime.js';

// The M19a gather placeholder is retired: M19e assembles a package instead of
// failing with not-implemented. Assemble/batch semantics live in
// tests/runtime-gather-*.test.ts.
test('the M19 gather assemble config parses and executes instead of throwing not-implemented', async () => {
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
  const executor = recorder();
  const runtime = runtimeOf(definition, executor.executor, { onLog: log.sink });
  await runtime.admit('gather', { role: 'draft', message: 'x' });
  await runtime.settle();

  // One type with count 1 completes immediately; no task Bee runs.
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { draft: ['x'] });
  assert.equal(runtime.snapshot().nodes['gather']?.active, undefined);
  assert.equal(runtime.snapshot().rest, true);
  assert.equal(executor.calls.length, 0);
  assert.equal(
    log.entries.some((entry) => entry.event === 'node.failed'),
    false,
  );
});
