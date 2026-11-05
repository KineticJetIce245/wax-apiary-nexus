import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertEditKeepsReferences,
  findActiveReferences,
  GraphEditBlockedError,
} from '../src/revision.js';
import {
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type NodeStateSnapshot,
  type PheromoneFieldSnapshot,
} from '../src/runtime/index.js';

function composition(extra: Record<string, unknown> = {}): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'edit',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'go' } },
      keep: { kind: 'forager', config: { connection: 'codex', prompt: 'keep' } },
    },
    edges: [],
    ...extra,
  });
}

function snapshotWith(nodes: Record<string, Partial<NodeStateSnapshot>>): PheromoneFieldSnapshot {
  const full: Record<string, NodeStateSnapshot> = {};
  for (const [id, state] of Object.entries(nodes)) {
    full[id] = { queue: [], state: {}, ...state };
  }
  return {
    schemaVersion: 1,
    compositionId: 'edit',
    graphRevision: 'rev',
    rest: false,
    pheromones: [],
    nodes: full,
  };
}

test('findActiveReferences reports queue, pending, active and hover', () => {
  const snapshot = snapshotWith({
    start: {
      queue: [
        { id: 'ph_1', traceId: 'tr_1', value: { kind: 'text', text: 'x' }, at: '2026-03-01T00:00:00.000Z' },
      ],
      pending: {
        id: 'ph_2',
        traceId: 'tr_2',
        value: { kind: 'text', text: 'y' },
        at: '2026-03-01T00:00:01.000Z',
      },
      hover: {
        token: 'hv_1',
        kind: 'user',
        compositionId: 'edit',
        nodeId: 'start',
        pheromoneId: 'ph_3',
      },
    },
    keep: {
      active: { id: 'ph_4', traceId: 'tr_4', value: { kind: 'text', text: 'z' }, at: '2026-03-01T00:00:02.000Z' },
    },
  });

  const references = findActiveReferences(snapshot);
  assert.deepEqual(references, [
    { nodeId: 'start', reason: 'queue' },
    { nodeId: 'start', reason: 'pending' },
    { nodeId: 'start', reason: 'hover' },
    { nodeId: 'keep', reason: 'active' },
  ]);
});

test('removing an idle node is allowed', () => {
  const current = composition();
  const next = parseComposition({
    schemaVersion: 1,
    id: 'edit',
    nodes: { keep: { kind: 'forager', config: { connection: 'codex', prompt: 'keep' } } },
    edges: [],
  });

  assert.deepEqual(assertEditKeepsReferences(current, next, snapshotWith({})), { forced: [] });
});

test('removing a node with live work is refused', () => {
  const current = composition();
  const next = parseComposition({
    schemaVersion: 1,
    id: 'edit',
    nodes: { keep: { kind: 'forager', config: { connection: 'codex', prompt: 'keep' } } },
    edges: [],
  });
  const snapshot = snapshotWith({
    start: {
      queue: [
        { id: 'ph_1', traceId: 'tr_1', value: { kind: 'text', text: 'x' }, at: '2026-03-01T00:00:00.000Z' },
      ],
    },
  });

  assert.throws(() => assertEditKeepsReferences(current, next, snapshot), GraphEditBlockedError);
});

test('a forced edit reports the nodes that must be marked stuck', () => {
  const current = composition();
  const next = parseComposition({
    schemaVersion: 1,
    id: 'edit',
    nodes: { keep: { kind: 'forager', config: { connection: 'codex', prompt: 'keep' } } },
    edges: [],
  });
  const snapshot = snapshotWith({
    start: {
      hover: {
        token: 'hv_1',
        kind: 'user',
        compositionId: 'edit',
        nodeId: 'start',
        pheromoneId: 'ph_3',
      },
    },
  });

  assert.deepEqual(assertEditKeepsReferences(current, next, snapshot, { force: true }), {
    forced: ['start'],
  });
});

test('a runtime can mark forced nodes as needing attention', () => {
  const definition = composition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: { async execute() { return { kind: 'text', text: 'ok' }; } },
    now: () => Date.parse('2026-03-01T00:00:00.000Z'),
  });

  runtime.markNeedsAttention(['start']);

  assert.equal(runtime.snapshot().nodes['start']?.state['needsAttention'], true);
  assert.equal(runtime.snapshot().nodes['keep']?.state['needsAttention'], undefined);
});

test('a merge-waiting join is an active reference and blocks removing the merge', () => {
  const current = parseComposition({
    schemaVersion: 1,
    id: 'edit',
    nodes: {
      keep: { kind: 'forager', config: { connection: 'codex', prompt: 'keep' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    edges: [],
  });
  const next = parseComposition({
    schemaVersion: 1,
    id: 'edit',
    nodes: {
      keep: { kind: 'forager', config: { connection: 'codex', prompt: 'keep' } },
    },
    edges: [],
  });
  const snapshot = snapshotWith({
    merge: {
      joins: {
        fk_1: {
          forkId: 'fk_1',
          arrived: [
            {
              id: 'ph_1',
              traceId: 'tr_1',
              forkId: 'fk_1',
              branchId: 'a',
              value: { kind: 'text', text: 'x' },
              at: '2026-03-01T00:00:00.000Z',
            },
          ],
        },
      },
    },
  });

  assert.deepEqual(findActiveReferences(snapshot), [
    { nodeId: 'merge', reason: 'merge-waiting' },
  ]);
  assert.throws(() => assertEditKeepsReferences(current, next, snapshot), GraphEditBlockedError);
  assert.deepEqual(assertEditKeepsReferences(current, next, snapshot, { force: true }), {
    forced: ['merge'],
  });
});
