import assert from 'node:assert/strict';
import test from 'node:test';

import { CompositionValidationError, parseComposition } from '../src/runtime/index.js';

function validComposition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'spread-gather',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'make' },
          ],
        },
      },
      make: { kind: 'forager', config: { connection: 'codex', prompt: 'make' } },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'make', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
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

function spreadOf(input: Record<string, unknown>): Record<string, unknown> {
  const nodes = input['nodes'] as Record<string, Record<string, unknown>>;
  const spread = nodes['spread'];
  assert.ok(spread !== undefined);
  return spread;
}

function gatherOf(input: Record<string, unknown>): Record<string, unknown> {
  const nodes = input['nodes'] as Record<string, Record<string, unknown>>;
  const gather = nodes['gather'];
  assert.ok(gather !== undefined);
  return gather;
}

test('parses spread and gather nodes and includes branch config in the graph revision', () => {
  const composition = parseComposition(validComposition());
  const spread = composition.nodes.get('spread');
  const gather = composition.nodes.get('gather');
  assert.ok(spread !== undefined);
  assert.ok(gather !== undefined);
  assert.equal(spread.kind, 'spread');
  if (spread.kind !== 'spread') {
    assert.fail('expected a spread node');
  }
  assert.deepEqual(spread.config.branches, [
    { id: 'a', to: 'gather' },
    { id: 'b', to: 'make' },
  ]);
  assert.equal(gather.kind, 'gather');
  if (gather.kind !== 'gather') {
    assert.fail('expected a gather node');
  }
  assert.deepEqual(gather.config.required, ['a', 'b']);
  assert.equal(gather.config.combine, 'text');

  const changed = structuredClone(validComposition());
  const changedSpread = spreadOf(changed);
  changedSpread['config'] = { branches: [{ id: 'a', to: 'gather' }] };
  assert.notEqual(composition.graphRevision, parseComposition(changed).graphRevision);
});

test('rejects a spread with empty, duplicate or unknown branches', () => {
  const empty = structuredClone(validComposition());
  spreadOf(empty)['config'] = { branches: [] };
  assert.ok(issuesOf(empty).some((issue) => issue.includes('branches: expected a non-empty array')));

  const duplicate = structuredClone(validComposition());
  spreadOf(duplicate)['config'] = {
    branches: [
      { id: 'a', to: 'gather' },
      { id: 'a', to: 'make' },
    ],
  };
  assert.ok(issuesOf(duplicate).some((issue) => issue.includes("duplicate branch id 'a'")));

  const unknown = structuredClone(validComposition());
  spreadOf(unknown)['config'] = {
    branches: [
      { id: 'a', to: 'gather' },
      { id: 'b', to: 'ghost' },
    ],
  };
  assert.ok(issuesOf(unknown).some((issue) => issue.includes("unknown node 'ghost'")));
});

test('rejects a normal outgoing edge from a spread', () => {
  const input = validComposition();
  (input['edges'] as unknown[]).push({ id: 'e4', from: 'spread', to: 'done' });

  const issues = issuesOf(input);
  assert.ok(issues.some((issue) => issue.includes('spread node uses branches and has no normal outgoing edge')));
});

test('rejects a gather with empty or duplicate required branches', () => {
  const empty = structuredClone(validComposition());
  gatherOf(empty)['config'] = { required: [], combine: 'text' };
  assert.ok(issuesOf(empty).some((issue) => issue.includes('required: expected a non-empty array')));

  const duplicate = structuredClone(validComposition());
  gatherOf(duplicate)['config'] = { required: ['a', 'a'], combine: 'text' };
  assert.ok(issuesOf(duplicate).some((issue) => issue.includes("duplicate required branch 'a'")));
});

test('parses optional branches, defaulting to none, and includes them in the revision', () => {
  const defaulted = parseComposition(validComposition());
  const defaultedGather = defaulted.nodes.get('gather');
  assert.ok(defaultedGather !== undefined);
  if (defaultedGather.kind !== 'gather') {
    assert.fail('expected a gather node');
  }
  assert.deepEqual(defaultedGather.config.optional, []);

  const optionalInput = structuredClone(validComposition());
  gatherOf(optionalInput)['config'] = {
    required: ['a', 'b'],
    optional: ['c'],
    combine: 'text',
  };
  const optional = parseComposition(optionalInput);
  const optionalGather = optional.nodes.get('gather');
  assert.ok(optionalGather !== undefined);
  if (optionalGather.kind !== 'gather') {
    assert.fail('expected a gather node');
  }
  assert.deepEqual(optionalGather.config.optional, ['c']);
  assert.notEqual(optional.graphRevision, defaulted.graphRevision);
});

test('rejects duplicate, overlapping or malformed optional branches', () => {
  const duplicate = structuredClone(validComposition());
  gatherOf(duplicate)['config'] = {
    required: ['a', 'b'],
    optional: ['c', 'c'],
    combine: 'text',
  };
  assert.ok(issuesOf(duplicate).some((issue) => issue.includes("duplicate optional branch 'c'")));

  const overlap = structuredClone(validComposition());
  gatherOf(overlap)['config'] = {
    required: ['a', 'b'],
    optional: ['a'],
    combine: 'text',
  };
  assert.ok(issuesOf(overlap).some((issue) => issue.includes("branch 'a' is already required")));

  const notArray = structuredClone(validComposition());
  gatherOf(notArray)['config'] = { required: ['a', 'b'], optional: 'c', combine: 'text' };
  assert.ok(issuesOf(notArray).some((issue) => issue.includes('optional: expected an array')));

  const emptyId = structuredClone(validComposition());
  gatherOf(emptyId)['config'] = { required: ['a', 'b'], optional: [''], combine: 'text' };
  assert.ok(issuesOf(emptyId).some((issue) => issue.includes('expected a non-empty branch id')));
});

test('parses object and array combine, and rejects an unknown combine', () => {
  const revisions = new Set<string>();
  for (const combine of ['text', 'object', 'array'] as const) {
    const input = structuredClone(validComposition());
    gatherOf(input)['config'] = { required: ['a', 'b'], combine };
    const composition = parseComposition(input);
    const gather = composition.nodes.get('gather');
    assert.ok(gather !== undefined);
    if (gather.kind !== 'gather') {
      assert.fail('expected a gather node');
    }
    assert.equal(gather.config.combine, combine);
    revisions.add(composition.graphRevision);
  }
  assert.equal(revisions.size, 3, 'combine is part of the graph revision');

  const invalid = structuredClone(validComposition());
  gatherOf(invalid)['config'] = { required: ['a', 'b'], combine: 'json' };
  assert.ok(
    issuesOf(invalid).some((issue) =>
      issue.includes("combine: expected 'text', 'object' or 'array'"),
    ),
  );
});

test('parses gather timeoutMs with the 600000 default and its 32-bit bound', () => {
  const defaulted = parseComposition(validComposition());
  const defaultedGather = defaulted.nodes.get('gather');
  assert.ok(defaultedGather !== undefined);
  if (defaultedGather.kind !== 'gather') {
    assert.fail('expected a gather node');
  }
  assert.equal(defaultedGather.config.timeoutMs, 600_000);

  const explicitInput = structuredClone(validComposition());
  gatherOf(explicitInput)['config'] = {
    required: ['a', 'b'],
    combine: 'text',
    timeoutMs: 1500,
  };
  const explicit = parseComposition(explicitInput);
  const explicitGather = explicit.nodes.get('gather');
  assert.ok(explicitGather !== undefined);
  if (explicitGather.kind !== 'gather') {
    assert.fail('expected a gather node');
  }
  assert.equal(explicitGather.config.timeoutMs, 1500);
  assert.notEqual(explicit.graphRevision, defaulted.graphRevision);

  for (const timeoutMs of [0, -1, 1.5, '1000', 2_147_483_648]) {
    const invalid = structuredClone(validComposition());
    gatherOf(invalid)['config'] = { required: ['a', 'b'], combine: 'text', timeoutMs };
    assert.ok(
      issuesOf(invalid).some((issue) =>
        issue.includes('timeoutMs: expected a positive integer <= 2147483647'),
      ),
      `expected timeoutMs ${String(timeoutMs)} to be rejected`,
    );
  }
});

test('rejects more than one gather outgoing edge and a when on a gather edge', () => {
  const extra = validComposition();
  (extra['edges'] as unknown[]).push({ id: 'e4', from: 'gather', to: 'start' });
  assert.ok(issuesOf(extra).some((issue) => issue.includes('gather node has at most one outgoing edge')));

  const when = validComposition();
  (when['edges'] as unknown[]).push({ id: 'e4', from: 'gather', to: 'start', when: 'true' });
  const issues = issuesOf(when);
  assert.ok(issues.some((issue) => issue.includes("'when' is only allowed")));
  assert.ok(issues.some((issue) => issue.includes('gather node has at most one outgoing edge')));
});
