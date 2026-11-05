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
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'do {{input}}' } },
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

test('rejects unsupported node kinds instead of silently ignoring them', () => {
  const issues = issuesOf(
    minimal({ nodes: { ask: { kind: 'user', config: { modality: 'text' } } } }),
  );

  assert.ok(issues.some((issue) => issue.includes("'user' is not supported")));
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
          config: { connection: 'codex', prompt: 'do {{input}} and {{task}}' },
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
        check: { kind: 'condition', config: { mode: 'text', contains: 'ok' } },
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

test('rejects scheduled triggers, empty node sets and bad schema versions', () => {
  assert.ok(issuesOf(minimal({ triggers: [{ id: 't1' }] })).some((issue) => issue.includes('not supported')));
  assert.ok(issuesOf(minimal({ nodes: {} })).some((issue) => issue.includes('at least one node')));
  assert.ok(issuesOf(minimal({ schemaVersion: 2 })).some((issue) => issue.includes('schemaVersion')));
});

test('rejects text conditions that set neither or both of contains and equals', () => {
  const neither = issuesOf(
    minimal({
      nodes: {
        check: { kind: 'condition', config: { mode: 'text' } },
        yes: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
        no: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
      },
      edges: [
        { id: 'e1', from: 'check', to: 'yes', when: 'true' },
        { id: 'e2', from: 'check', to: 'no', when: 'false' },
      ],
    }),
  );
  const both = issuesOf(
    minimal({
      nodes: {
        check: { kind: 'condition', config: { mode: 'text', contains: 'a', equals: 'b' } },
        yes: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
        no: { kind: 'forager', config: { connection: 'c', prompt: 'p' } },
      },
      edges: [
        { id: 'e1', from: 'check', to: 'yes', when: 'true' },
        { id: 'e2', from: 'check', to: 'no', when: 'false' },
      ],
    }),
  );

  assert.ok(neither.some((issue) => issue.includes('exactly one of')));
  assert.ok(both.some((issue) => issue.includes('exactly one of')));
});
