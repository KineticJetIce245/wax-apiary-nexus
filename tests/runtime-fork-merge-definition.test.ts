import assert from 'node:assert/strict';
import test from 'node:test';

import { CompositionValidationError, parseComposition } from '../src/runtime/index.js';

function validComposition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'fork-merge',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'make' },
          ],
        },
      },
      make: { kind: 'forager', config: { connection: 'codex', prompt: 'make' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'make', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  };
}

function issuesOf(input: unknown): string[] {
  try {
    parseComposition(input);
  } catch (error) {
    assert.ok(error instanceof CompositionValidationError);
    return [...error.issues];
  }
  assert.fail('expected the composition to be rejected');
}

function forkOf(input: Record<string, unknown>): Record<string, unknown> {
  const nodes = input['nodes'] as Record<string, Record<string, unknown>>;
  const fork = nodes['fork'];
  assert.ok(fork !== undefined);
  return fork;
}

function mergeOf(input: Record<string, unknown>): Record<string, unknown> {
  const nodes = input['nodes'] as Record<string, Record<string, unknown>>;
  const merge = nodes['merge'];
  assert.ok(merge !== undefined);
  return merge;
}

test('parses fork and merge nodes and includes branch config in the graph revision', () => {
  const composition = parseComposition(validComposition());
  const fork = composition.nodes.get('fork');
  const merge = composition.nodes.get('merge');
  assert.ok(fork !== undefined);
  assert.ok(merge !== undefined);
  assert.equal(fork.kind, 'fork');
  if (fork.kind !== 'fork') {
    assert.fail('expected a fork node');
  }
  assert.deepEqual(fork.config.branches, [
    { id: 'a', to: 'merge' },
    { id: 'b', to: 'make' },
  ]);
  assert.equal(merge.kind, 'merge');
  if (merge.kind !== 'merge') {
    assert.fail('expected a merge node');
  }
  assert.deepEqual(merge.config.required, ['a', 'b']);
  assert.equal(merge.config.combine, 'text');

  const changed = structuredClone(validComposition());
  const changedFork = forkOf(changed);
  changedFork['config'] = { branches: [{ id: 'a', to: 'merge' }] };
  assert.notEqual(composition.graphRevision, parseComposition(changed).graphRevision);
});

test('rejects a fork with empty, duplicate or unknown branches', () => {
  const empty = structuredClone(validComposition());
  forkOf(empty)['config'] = { branches: [] };
  assert.ok(issuesOf(empty).some((issue) => issue.includes('branches: expected a non-empty array')));

  const duplicate = structuredClone(validComposition());
  forkOf(duplicate)['config'] = {
    branches: [
      { id: 'a', to: 'merge' },
      { id: 'a', to: 'make' },
    ],
  };
  assert.ok(issuesOf(duplicate).some((issue) => issue.includes("duplicate branch id 'a'")));

  const unknown = structuredClone(validComposition());
  forkOf(unknown)['config'] = {
    branches: [
      { id: 'a', to: 'merge' },
      { id: 'b', to: 'ghost' },
    ],
  };
  assert.ok(issuesOf(unknown).some((issue) => issue.includes("unknown node 'ghost'")));
});

test('rejects a normal outgoing edge from a fork', () => {
  const input = validComposition();
  (input['edges'] as unknown[]).push({ id: 'e4', from: 'fork', to: 'done' });

  const issues = issuesOf(input);
  assert.ok(issues.some((issue) => issue.includes('fork node uses branches and has no normal outgoing edge')));
});

test('rejects a merge with empty or duplicate required branches', () => {
  const empty = structuredClone(validComposition());
  mergeOf(empty)['config'] = { required: [], combine: 'text' };
  assert.ok(issuesOf(empty).some((issue) => issue.includes('required: expected a non-empty array')));

  const duplicate = structuredClone(validComposition());
  mergeOf(duplicate)['config'] = { required: ['a', 'a'], combine: 'text' };
  assert.ok(issuesOf(duplicate).some((issue) => issue.includes("duplicate required branch 'a'")));
});

test('parses optional branches, defaulting to none, and includes them in the revision', () => {
  const defaulted = parseComposition(validComposition());
  const defaultedMerge = defaulted.nodes.get('merge');
  assert.ok(defaultedMerge !== undefined);
  if (defaultedMerge.kind !== 'merge') {
    assert.fail('expected a merge node');
  }
  assert.deepEqual(defaultedMerge.config.optional, []);

  const optionalInput = structuredClone(validComposition());
  mergeOf(optionalInput)['config'] = {
    required: ['a', 'b'],
    optional: ['c'],
    combine: 'text',
  };
  const optional = parseComposition(optionalInput);
  const optionalMerge = optional.nodes.get('merge');
  assert.ok(optionalMerge !== undefined);
  if (optionalMerge.kind !== 'merge') {
    assert.fail('expected a merge node');
  }
  assert.deepEqual(optionalMerge.config.optional, ['c']);
  assert.notEqual(optional.graphRevision, defaulted.graphRevision);
});

test('rejects duplicate, overlapping or malformed optional branches', () => {
  const duplicate = structuredClone(validComposition());
  mergeOf(duplicate)['config'] = {
    required: ['a', 'b'],
    optional: ['c', 'c'],
    combine: 'text',
  };
  assert.ok(issuesOf(duplicate).some((issue) => issue.includes("duplicate optional branch 'c'")));

  const overlap = structuredClone(validComposition());
  mergeOf(overlap)['config'] = {
    required: ['a', 'b'],
    optional: ['a'],
    combine: 'text',
  };
  assert.ok(issuesOf(overlap).some((issue) => issue.includes("branch 'a' is already required")));

  const notArray = structuredClone(validComposition());
  mergeOf(notArray)['config'] = { required: ['a', 'b'], optional: 'c', combine: 'text' };
  assert.ok(issuesOf(notArray).some((issue) => issue.includes('optional: expected an array')));

  const emptyId = structuredClone(validComposition());
  mergeOf(emptyId)['config'] = { required: ['a', 'b'], optional: [''], combine: 'text' };
  assert.ok(issuesOf(emptyId).some((issue) => issue.includes('expected a non-empty branch id')));
});

test('rejects object/array combine and merge timeouts in 5A', () => {
  const object = structuredClone(validComposition());
  mergeOf(object)['config'] = { required: ['a', 'b'], combine: 'object' };
  assert.ok(issuesOf(object).some((issue) => issue.includes("only 'text' is supported in Stage 5A")));

  const timeout = structuredClone(validComposition());
  mergeOf(timeout)['config'] = {
    required: ['a', 'b'],
    combine: 'text',
    timeoutMs: 1000,
  };
  assert.ok(issuesOf(timeout).some((issue) => issue.includes('merge timeouts are not supported')));
});

test('rejects more than one merge outgoing edge and a when on a merge edge', () => {
  const extra = validComposition();
  (extra['edges'] as unknown[]).push({ id: 'e4', from: 'merge', to: 'start' });
  assert.ok(issuesOf(extra).some((issue) => issue.includes('merge node has at most one outgoing edge')));

  const when = validComposition();
  (when['edges'] as unknown[]).push({ id: 'e4', from: 'merge', to: 'start', when: 'true' });
  const issues = issuesOf(when);
  assert.ok(issues.some((issue) => issue.includes("'when' is only allowed")));
  assert.ok(issues.some((issue) => issue.includes('merge node has at most one outgoing edge')));
});
