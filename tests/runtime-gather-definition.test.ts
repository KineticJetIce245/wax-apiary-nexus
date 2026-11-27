import assert from 'node:assert/strict';
import test from 'node:test';

import { CompositionValidationError, parseComposition } from '../src/runtime/index.js';

const TYPE_T = {
  match: { path: 'role', equals: 't' },
  count: 1,
  reads: ['message'],
};

/** A batch type declares no count, so batch configs must use this shape. */
const BATCH_TYPE_T = {
  match: { path: 'role', equals: 't' },
  reads: ['message'],
};

/** Parse a gather composition and return every validation issue. */
function issuesOf(
  config: Record<string, unknown>,
  edges: readonly Record<string, unknown>[] = [],
): string[] {
  try {
    parseComposition({
      schemaVersion: 1,
      id: 'gather-definition',
      nodes: {
        gather: { kind: 'gather', config },
        next: { kind: 'forager', config: { connection: 'fake', prompt: 'next' } },
        other: { kind: 'forager', config: { connection: 'fake', prompt: 'other' } },
      },
      edges,
    });
  } catch (error) {
    assert.ok(error instanceof CompositionValidationError);
    return [...error.issues];
  }
  assert.fail('expected the composition to be rejected');
}

test('a gather without types is rejected instead of assembling an empty package', () => {
  const issues = issuesOf({ types: {} });
  assert.ok(issues.some((issue) => issue.includes('expected at least one type')));
});

test('an assemble type count must be a positive integer', () => {
  const zero = issuesOf({ types: { t: { ...TYPE_T, count: 0 } } });
  const fractional = issuesOf({ types: { t: { ...TYPE_T, count: 1.5 } } });

  assert.ok(zero.some((issue) => issue.includes('count: expected a positive integer')));
  assert.ok(fractional.some((issue) => issue.includes('count: expected a positive integer')));
});

test('a gather strategy is assemble or batch, never a pool', () => {
  const issues = issuesOf({ strategy: 'pool', types: { t: TYPE_T } });
  assert.ok(issues.some((issue) => issue.includes("expected 'assemble' or 'batch'")));
});

test('a batch gather requires a batch signal rule', () => {
  const missing = issuesOf({ strategy: 'batch', types: { t: BATCH_TYPE_T } });
  const notAnObject = issuesOf({ strategy: 'batch', batch: true, types: { t: BATCH_TYPE_T } });

  assert.ok(missing.some((issue) => issue.includes('batch: expected { signal: <rule> }')));
  assert.ok(notAnObject.some((issue) => issue.includes('batch: expected { signal: <rule> }')));
});

test('a gather has at most one outgoing edge and no when on it', () => {
  const base = { types: { t: TYPE_T } };
  const twoEdges = issuesOf(base, [
    { id: 'e1', from: 'gather', to: 'next' },
    { id: 'e2', from: 'gather', to: 'other' },
  ]);
  const labelled = issuesOf(base, [{ id: 'e1', from: 'gather', to: 'next', when: 'true' }]);

  assert.ok(twoEdges.some((issue) => issue.includes('at most one outgoing edge')));
  assert.ok(labelled.some((issue) => issue.includes("'when' is only allowed")));
});
