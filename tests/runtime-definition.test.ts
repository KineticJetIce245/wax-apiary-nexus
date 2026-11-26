import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositionValidationError,
  parseComposition,
} from '../src/runtime/index.js';

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'demo',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'do {{message}}' } },
    },
    edges: [],
    ...overrides,
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

test('parses a minimal composition and treats a node without an outgoing edge as terminal', () => {
  const composition = parseComposition(minimal());

  assert.equal(composition.schemaVersion, 1);
  assert.equal(composition.id, 'demo');
  assert.equal(composition.nodes.size, 1);
  assert.equal(composition.edges.length, 0);

  const start = composition.nodes.get('start');
  assert.ok(start !== undefined);
  assert.equal(start.kind, 'forager');
  assert.equal(start.minIntervalMs, 1000);
  assert.equal(composition.defaults.minIntervalMs, 1000);
  assert.equal(composition.defaults.queueMax, 1024);
});

test('keeps a stable graph revision and changes it when the graph changes', () => {
  const first = parseComposition(minimal());
  const second = parseComposition(minimal());
  const changed = parseComposition(
    minimal({
      nodes: {
        start: { kind: 'forager', config: { connection: 'codex', prompt: 'changed' } },
      },
    }),
  );

  assert.equal(first.graphRevision, second.graphRevision);
  assert.notEqual(first.graphRevision, changed.graphRevision);
});

test('rejects unknown node kinds instead of silently ignoring them', () => {
  const issues = issuesOf(
    minimal({ nodes: { run: { kind: 'scheduler', config: {} } } }),
  );

  assert.ok(issues.some((issue) => issue.includes("unknown node kind 'scheduler'")));
});

test('rejects unknown node kinds, unknown fields and malformed ids', () => {
  const issues = issuesOf(
    minimal({
      nodes: {
        'Bad Id': { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
        start: {
          kind: 'mystery',
          config: {},
        },
        other: {
          kind: 'forager',
          config: { connection: 'c', prompt: 'p', extra: true },
        },
      },
    }),
  );

  assert.ok(issues.some((issue) => issue.includes('id must match')));
  assert.ok(issues.some((issue) => issue.includes("unknown node kind 'mystery'")));
  assert.ok(issues.some((issue) => issue.includes("unknown field 'extra'")));
});

test('rejects unknown top-level fields so typos do not pass silently', () => {
  const issues = issuesOf(minimal({ node: {} }));

  assert.ok(issues.some((issue) => issue.includes("unknown field 'node'")));
});

test('rejects unknown template placeholders in a forager prompt', () => {
  const issues = issuesOf(
    minimal({
      nodes: {
        start: {
          kind: 'forager',
          config: { connection: 'codex', prompt: 'do {{message}} and {{task}}' },
        },
      },
    }),
  );

  assert.ok(issues.some((issue) => issue.includes("'{{task}}'")));
});

test('requires minIntervalMs to be at least 1000 on nodes and defaults', () => {
  const nodeIssues = issuesOf(
    minimal({
      nodes: {
        start: {
          kind: 'forager',
          config: { connection: 'codex', prompt: 'p' },
          minIntervalMs: 999,
        },
      },
    }),
  );
  const defaultIssues = issuesOf(minimal({ defaults: { minIntervalMs: 10 } }));

  assert.ok(nodeIssues.some((issue) => issue.includes('minIntervalMs: expected an integer >= 1000')));
  assert.ok(defaultIssues.some((issue) => issue.includes('defaults.minIntervalMs')));
});

test('rejects a forager edge that carries when', () => {
  const issues = issuesOf(
    minimal({
      nodes: {
        start: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
        next: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
      },
      edges: [{ id: 'e1', from: 'start', to: 'next', when: 'true' }],
    }),
  );

  assert.ok(issues.some((issue) => issue.includes("'when' is only allowed")));
});

test('rejects a condition without exactly one true edge and one false edge', () => {
  const issues = issuesOf(
    minimal({
      nodes: {
        check: { kind: 'condition', config: { when: { path: 'message', equals: 'ok' } } },
        yes: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
      },
      edges: [{ id: 'e1', from: 'check', to: 'yes', when: 'true' }],
    }),
  );

  assert.ok(issues.some((issue) => issue.includes("expected exactly one 'false'")));
  assert.ok(issues.some((issue) => issue.includes('found 1')));
});

test('rejects a counter without a done edge and a duplicate edge id', () => {
  const issues = issuesOf(
    minimal({
      nodes: {
        count: { kind: 'counter', config: { max: 2 } },
        start: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
      },
      edges: [
        { id: 'e1', from: 'start', to: 'count' },
        { id: 'e1', from: 'count', to: 'start', when: 'continue' },
      ],
    }),
  );

  assert.ok(issues.some((issue) => issue.includes("duplicate edge id 'e1'")));
  assert.ok(issues.some((issue) => issue.includes("expected exactly one 'done'")));
});

test('rejects edges that point at unknown nodes', () => {
  const issues = issuesOf(
    minimal({
      nodes: { start: { kind: 'forager', config: { connection: 'c', prompt: 'p' } } },
      edges: [{ id: 'e1', from: 'start', to: 'ghost' }],
    }),
  );

  assert.ok(issues.some((issue) => issue.includes("unknown node 'ghost'")));
});

test('rejects a non-array triggers value, empty node sets and bad schema versions', () => {
  assert.ok(issuesOf(minimal({ triggers: {} })).some((issue) => issue.includes('expected an array')));
  assert.ok(issuesOf(minimal({ nodes: {} })).some((issue) => issue.includes('at least one node')));
  assert.ok(issuesOf(minimal({ schemaVersion: 2 })).some((issue) => issue.includes('schemaVersion')));
});

function conditionIssues(config: Record<string, unknown>): string[] {
  return issuesOf(
    minimal({
      nodes: {
        check: { kind: 'condition', config },
        yes: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
        no: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
      },
      edges: [
        { id: 'e1', from: 'check', to: 'yes', when: 'true' },
        { id: 'e2', from: 'check', to: 'no', when: 'false' },
      ],
    }),
  );
}

test('rejects a condition rule with no operator or more than one operator', () => {
  const neither = conditionIssues({ when: { path: 'message' } });
  const both = conditionIssues({ when: { path: 'message', equals: 'a', oneOf: ['b'] } });

  assert.ok(neither.some((issue) => issue.includes('exactly one of')));
  assert.ok(both.some((issue) => issue.includes('exactly one of')));
});

test('rejects the removed condition modes and a malformed code rule', () => {
  const legacy = conditionIssues({ mode: 'text', contains: 'ok' });
  assert.ok(legacy.some((issue) => issue.includes("unknown field 'mode'")));
  assert.ok(legacy.some((issue) => issue.includes('when: expected a rule object')));

  const syntax = conditionIssues({ when: { code: 'return (' } });
  assert.ok(syntax.some((issue) => issue.includes('syntax error')));
});

test('parses all declarative condition operators and a code block', () => {
  for (const when of [
    { path: 'message', equals: 'ok' },
    { path: 'kind', oneOf: ['a', 'b'] },
    { path: 'message', exists: true },
    { path: 'count', type: 'number' },
    { code: 'return value.count > 1;' },
  ]) {
    const composition = parseComposition(
      minimal({
        nodes: {
          check: { kind: 'condition', config: { when } },
          yes: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
          no: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
        },
        edges: [
          { id: 'e1', from: 'check', to: 'yes', when: 'true' },
          { id: 'e2', from: 'check', to: 'no', when: 'false' },
        ],
      }),
    );
    const node = composition.nodes.get('check');
    assert.ok(node !== undefined && node.kind === 'condition');
    assert.deepEqual(node.config.when, when);
  }
});
