import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FlowDefinitionError,
  loadFlowDefinition,
  parseFlowDefinition,
  templatePlaceholders,
} from '../src/flow-definition.js';

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    strategy: 'graph',
    input: 'TOPIC',
    participants: {
      planner: { connection: 'dsh' },
      reviewer: { connection: 'codex' },
    },
    start: 'plan',
    nodes: {
      plan: { participant: 'planner', prompt: 'Plan {{input}}', next: 'review' },
      review: { participant: 'reviewer', prompt: 'Review {{plan}}', next: 'end' },
      end: { type: 'end' },
    },
    ...overrides,
  };
}

test('parses a sequential flow and normalizes submit nodes', () => {
  const flow = parseFlowDefinition(definition());
  assert.equal(flow.version, 1);
  assert.equal(flow.strategy, 'graph');
  assert.equal(flow.start, 'plan');
  assert.equal(flow.nodes.plan?.type, 'submit');
  assert.equal(flow.nodes.end?.type, 'end');
  assert.deepEqual(templatePlaceholders('A {{input}} B {{plan}}'), ['input', 'plan']);
});

test('parses a parallel flow whose branch nodes appear before the group', () => {
  const flow = parseFlowDefinition(
    definition({
      start: 'plan',
      nodes: {
        plan: { participant: 'planner', prompt: 'Plan {{input}}', next: 'reviewers' },
        a: { participant: 'planner', prompt: 'A {{plan}}' },
        b: { participant: 'reviewer', prompt: 'B {{plan}}' },
        reviewers: { type: 'parallel', branches: ['a', 'b'], next: 'merge' },
        merge: { participant: 'planner', prompt: '{{a}} + {{b}}', next: 'end' },
        end: { type: 'end' },
      },
    }),
  );
  assert.equal(flow.nodes.reviewers?.type, 'parallel');
  assert.deepEqual(
    flow.nodes.reviewers?.type === 'parallel' ? flow.nodes.reviewers.branches : [],
    ['a', 'b'],
  );
});

test('rejects malformed flow basics', () => {
  assert.throws(() => parseFlowDefinition({ ...definition(), version: 2 }), /version/);
  assert.throws(() => parseFlowDefinition({ ...definition(), strategy: 'dag' }), /strategy/);
  assert.throws(() => parseFlowDefinition(definition({ start: 'missing' })), /start/);
  assert.throws(() => parseFlowDefinition(definition({ nodes: {} })), /nodes/);
  assert.throws(
    () => parseFlowDefinition(definition({ start: 'end', nodes: { end: { type: 'end' } } })),
    /Start node cannot be an end node/,
  );
});

test('rejects bad next targets and conditions', () => {
  assert.throws(
    () =>
      parseFlowDefinition(
        definition({
          nodes: {
            plan: { participant: 'planner', prompt: 'Plan', next: 'missing' },
            end: { type: 'end' },
          },
        }),
      ),
    /unknown next node/,
  );
  assert.throws(
    () =>
      parseFlowDefinition(
        definition({
          nodes: {
            plan: {
              participant: 'planner',
              prompt: 'Plan',
              next: { contains: 'X', equals: 'Y', then: 'end', else: 'end' },
            },
            end: { type: 'end' },
          },
        }),
      ),
    /exactly one of contains\/equals/,
  );
  assert.throws(
    () =>
      parseFlowDefinition(
        definition({
          nodes: {
            plan: { participant: 'planner', prompt: 'Plan', next: { contains: 'X', then: 'end' } },
            end: { type: 'end' },
          },
        }),
      ),
    /next.else/,
  );
});

test('rejects unknown participants, placeholders and malformed braces', () => {
  assert.throws(
    () =>
      parseFlowDefinition(
        definition({
          nodes: {
            plan: { participant: 'nobody', prompt: 'Plan', next: 'end' },
            end: { type: 'end' },
          },
        }),
      ),
    /unknown participant/,
  );
  assert.throws(
    () =>
      parseFlowDefinition(
        definition({
          nodes: {
            plan: { participant: 'planner', prompt: 'Plan {{nope}}', next: 'end' },
            end: { type: 'end' },
          },
        }),
      ),
    /unknown placeholder/,
  );
  assert.throws(() => templatePlaceholders('broken {{name'), /unmatched/);
  assert.throws(
    () =>
      parseFlowDefinition({
        version: 1,
        strategy: 'graph',
        participants: { p: { connection: 'dsh' } },
        start: 'plan',
        nodes: {
          plan: { participant: 'p', prompt: 'Plan {{input}}', next: 'end' },
          end: { type: 'end' },
        },
      }),
    /flow.input is not set/,
  );
});

test('rejects cycles and unreachable nodes', () => {
  assert.throws(
    () =>
      parseFlowDefinition(
        definition({
          nodes: {
            plan: {
              participant: 'planner',
              prompt: 'Plan',
              next: { contains: 'X', then: 'review', else: 'end' },
            },
            review: { participant: 'reviewer', prompt: 'Review', next: 'plan' },
            end: { type: 'end' },
          },
        }),
      ),
    /cycle/,
  );
  assert.throws(
    () =>
      parseFlowDefinition(
        definition({
          nodes: {
            plan: { participant: 'planner', prompt: 'Plan', next: 'end' },
            extra: { participant: 'reviewer', prompt: 'Extra', next: 'end' },
            end: { type: 'end' },
          },
        }),
      ),
    /not reachable/,
  );
});

test('rejects invalid parallel groups, including same-connection branches', () => {
  const make = (nodes: Record<string, unknown>) =>
    parseFlowDefinition(
      definition({
        nodes,
      }),
    );
  assert.throws(
    () =>
      make({
        plan: { participant: 'planner', prompt: 'Plan', next: 'p' },
        p: { type: 'parallel', branches: ['a'], next: 'end' },
        a: { participant: 'planner', prompt: 'A' },
        end: { type: 'end' },
      }),
    /at least two branches/,
  );
  assert.throws(
    () =>
      make({
        plan: { participant: 'planner', prompt: 'Plan', next: 'p' },
        p: { type: 'parallel', branches: ['a', 'b'], next: 'end' },
        a: { participant: 'planner', prompt: 'A' },
        b: { participant: 'planner', prompt: 'B' },
        end: { type: 'end' },
      }),
    /distinct connections/,
  );
  assert.throws(
    () =>
      make({
        plan: { participant: 'planner', prompt: 'Plan', next: 'p' },
        p: { type: 'parallel', branches: ['a', 'b'], next: 'end' },
        a: { participant: 'planner', prompt: 'A' },
        b: { participant: 'reviewer', prompt: 'B', next: 'end' },
        end: { type: 'end' },
      }),
    /submit node without next/,
  );
  assert.throws(
    () =>
      make({
        plan: { participant: 'planner', prompt: 'Plan', next: 'p' },
        p: { type: 'parallel', branches: ['a', 'b'], next: 'merge' },
        a: { participant: 'planner', prompt: 'A' },
        b: { participant: 'reviewer', prompt: 'B' },
        merge: { participant: 'planner', prompt: '{{a}}', next: 'a' },
        end: { type: 'end' },
      }),
    /branch .* target|unknown|not reachable/,
  );
});

test('loads a flow from JSON and rejects unreadable or invalid files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-flow-def-'));
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(definition()), 'utf8');
  assert.equal(loadFlowDefinition(good).start, 'plan');

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  assert.throws(() => loadFlowDefinition(bad), /not valid JSON/);
  assert.throws(() => loadFlowDefinition(join(dir, 'missing.json')), FlowDefinitionError);
});
