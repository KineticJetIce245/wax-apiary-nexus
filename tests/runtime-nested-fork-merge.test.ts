import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HoneyStore } from '../src/storage/honey.js';
import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  type BranchTag,
  type CompositionDefinition,
  type NodeExecutor,
  type PersistedField,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-07-01T00:00:00.000Z');

function text(value: string): Value {
  return { kind: 'text', text: value };
}

interface Recorder {
  readonly executor: NodeExecutor;
  readonly calls: { nodeId: string; input: Value }[];
}

function recorder(output?: (nodeId: string, input: Value) => Value): Recorder {
  const calls: { nodeId: string; input: Value }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push({ nodeId: node.id, input });
      return output === undefined ? input : output(node.id, input);
    },
  };
  return { executor, calls };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wax-nested-honey-'));
}

/**
 * Pumps until the field reaches Rest, advancing the injected clock after every
 * pump so each node's minimum interval can elapse. Only for graphs that have no
 * user hover and no intentionally waiting merge.
 */
async function runToRest(
  runtime: PheromoneRuntime,
  advance: () => void,
  maxPumps = 50,
): Promise<void> {
  for (let index = 0; index < maxPumps; index += 1) {
    await runtime.pump();
    if (runtime.snapshot().rest) {
      return;
    }
    advance();
  }
  assert.fail('the field did not reach Rest');
}

function tagIds(tags: readonly BranchTag[] | undefined): string[] {
  return (tags ?? []).map((tag) => `${tag.forkId}/${tag.branchId}`);
}

function joinAt(
  snapshot: ReturnType<PheromoneRuntime['snapshot']>,
  nodeId: string,
  key?: string,
) {
  const joins = snapshot.nodes[nodeId]?.joins ?? {};
  const value = key === undefined ? Object.values(joins)[0] : joins[key];
  assert.ok(value !== undefined, `expected a join on '${nodeId}'`);
  return value;
}

/** start -> fork (a,b -> merge) -> done. The Stage 3A single-level shape. */
function singleLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-single-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'merge' },
          ],
        },
      },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork
 *   left  -> inner-fork (i-a, i-b -> inner-merge) -> outer-merge
 *   right -> outer-merge
 * outer-merge -> done
 */
function twoLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-two-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'outer-merge' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
          ],
        },
      },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e3', from: 'outer-merge', to: 'done' },
    ],
  });
}

/** Two-level shape whose inner second branch is a user hover. */
function twoLevelHoverComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-two-level-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'outer-merge' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner?' } },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'ask-inner', to: 'inner-merge' },
      { id: 'e3', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e4', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork (o-left -> mid-fork, o-right -> outer-merge)
 * mid-fork (m-left -> inner-fork, m-right -> mid-merge)
 * inner-fork (i-a, i-b -> inner-merge) -> mid-merge -> outer-merge -> done
 */
function threeLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-three-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'o-left', to: 'mid-fork' },
            { id: 'o-right', to: 'outer-merge' },
          ],
        },
      },
      'mid-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'm-left', to: 'inner-fork' },
            { id: 'm-right', to: 'mid-merge' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
          ],
        },
      },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'mid-merge': { kind: 'merge', config: { required: ['m-left', 'm-right'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['o-left', 'o-right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'mid-merge' },
      { id: 'e3', from: 'mid-merge', to: 'outer-merge' },
      { id: 'e4', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * The same three-level nesting as `threeLevelComposition`, but the outer right
 * branch is a user hover instead of a direct Merge arrival:
 *
 * start -> outer-fork
 *   o-left  -> mid-fork (m-left -> inner-fork, m-right -> mid-merge)
 *              inner-fork (i-a, i-b -> inner-merge) -> mid-merge -> outer-merge
 *   o-right -> ask-outer -> outer-merge
 * outer-merge -> done
 *
 * `queue-node` is deliberately detached: no edge reaches it, so it can hold an
 * independent queue/pending pair without touching the nested graph.
 */
function threeLevelHoverComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-three-level-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'o-left', to: 'mid-fork' },
            { id: 'o-right', to: 'ask-outer' },
          ],
        },
      },
      'mid-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'm-left', to: 'inner-fork' },
            { id: 'm-right', to: 'mid-merge' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
          ],
        },
      },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'mid-merge': { kind: 'merge', config: { required: ['m-left', 'm-right'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['o-left', 'o-right'], combine: 'text' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'queue-node': {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'detached {{input}}' },
        minIntervalMs: 5000,
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'mid-merge' },
      { id: 'e3', from: 'mid-merge', to: 'outer-merge' },
      { id: 'e4', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e5', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * Two outer branches, each running its own inner Fork/Merge pair with distinct
 * forager outputs, then both joining at the outer Merge.
 */
function siblingInnerForksComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-sibling-forks',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'left-fork' },
            { id: 'right', to: 'right-fork' },
          ],
        },
      },
      'left-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'l-a', to: 'l-a-node' },
            { id: 'l-b', to: 'l-b-node' },
          ],
        },
      },
      'right-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'r-a', to: 'r-a-node' },
            { id: 'r-b', to: 'r-b-node' },
          ],
        },
      },
      'l-a-node': { kind: 'forager', config: { connection: 'codex', prompt: 'l-a' } },
      'l-b-node': { kind: 'forager', config: { connection: 'codex', prompt: 'l-b' } },
      'r-a-node': { kind: 'forager', config: { connection: 'codex', prompt: 'r-a' } },
      'r-b-node': { kind: 'forager', config: { connection: 'codex', prompt: 'r-b' } },
      'left-merge': { kind: 'merge', config: { required: ['l-a', 'l-b'], combine: 'text' } },
      'right-merge': { kind: 'merge', config: { required: ['r-a', 'r-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'l-a-node', to: 'left-merge' },
      { id: 'e3', from: 'l-b-node', to: 'left-merge' },
      { id: 'e4', from: 'r-a-node', to: 'right-merge' },
      { id: 'e5', from: 'r-b-node', to: 'right-merge' },
      { id: 'e6', from: 'left-merge', to: 'outer-merge' },
      { id: 'e7', from: 'right-merge', to: 'outer-merge' },
      { id: 'e8', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork (left -> inner-fork, right -> ask-outer)
 * inner-fork (i-a, i-b -> inner-merge, i-opt -> ask-inner)
 * inner-merge required [i-a,i-b], optional [i-opt] -> outer-merge
 */
function nestedOptionalComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-optional',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
            { id: 'i-opt', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner optional?' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-merge': {
        kind: 'merge',
        config: { required: ['i-a', 'i-b'], optional: ['i-opt'], combine: 'text' },
      },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'ask-inner', to: 'inner-merge' },
      { id: 'e3', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e4', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e5', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork (left -> inner-fork, right -> ask-outer)
 * inner-fork (i-a -> inner-merge, i-b -> ask-inner)
 * inner-merge required [i-a,i-b], optional [i-opt], timeoutMs 5000.
 */
function nestedTimeoutComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-timeout',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner?' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-merge': {
        kind: 'merge',
        config: {
          required: ['i-a', 'i-b'],
          optional: ['i-opt'],
          combine: 'text',
          timeoutMs: 5000,
        },
      },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'ask-inner', to: 'inner-merge' },
      { id: 'e3', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e4', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e5', from: 'outer-merge', to: 'done' },
    ],
  });
}

/** Same outer shape as nestedTimeout, but one inner branch throws. */
function nestedFailureComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-failure',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'boom' },
          ],
        },
      },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e3', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e4', from: 'outer-merge', to: 'done' },
    ],
  });
}

test('a single-level fork/merge still emits an untagged top-level output', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(singleLevelComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runToRest(runtime, () => {
    clock += 1000;
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
  assert.equal(
    serializeValue(calls.find((call) => call.nodeId === 'done')?.input as Value),
    'seed\nseed',
  );
  const join = joinAt(snapshot, 'merge');
  assert.ok(join.completedAt !== undefined);
  assert.equal(join.lineage, undefined);
  const emitted = log.entries.find(
    (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
  );
  assert.ok(emitted !== undefined);
  assert.equal(emitted.forkId, undefined);
  assert.equal(emitted.branchId, undefined);
});

test('an inner merge restores the outer branch tag so the outer merge completes', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(twoLevelComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runToRest(runtime, () => {
    clock += 1000;
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
  assert.equal(
    serializeValue(calls.find((call) => call.nodeId === 'done')?.input as Value),
    'seed\nseed\nseed',
  );

  const innerJoin = joinAt(snapshot, 'inner-merge');
  const outerJoin = joinAt(snapshot, 'outer-merge');
  assert.ok(innerJoin.completedAt !== undefined);
  assert.ok(outerJoin.completedAt !== undefined);
  assert.equal(innerJoin.lineage?.length, 1);
  assert.equal(innerJoin.lineage?.[0]?.branchId, 'left');
  const outerForkId = innerJoin.lineage?.[0]?.forkId;
  assert.match(outerForkId ?? '', /^fk_/);
  assert.equal(outerJoin.lineage, undefined, 'the top-level merge pops the last tag');

  const outerArrivals = log.entries.filter(
    (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'outer-merge',
  );
  assert.equal(outerArrivals.length, 2);
  const restored = outerArrivals.find((entry) => entry.branchId === 'left');
  const direct = outerArrivals.find((entry) => entry.branchId === 'right');
  assert.ok(restored !== undefined);
  assert.ok(direct !== undefined);
  assert.equal(restored.forkId, outerForkId, 'the inner merge output keeps the outer fork tag');
  assert.equal(direct.forkId, outerForkId);
  assert.equal(
    log.entries.find(
      (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
    )?.forkId,
    undefined,
  );
});

test('three levels of nesting pop one lineage tag per merge', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(threeLevelComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runToRest(runtime, () => {
    clock += 1000;
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.equal(
    serializeValue(calls.find((call) => call.nodeId === 'done')?.input as Value),
    'seed\nseed\nseed\nseed',
  );

  const innerJoin = joinAt(snapshot, 'inner-merge');
  const midJoin = joinAt(snapshot, 'mid-merge');
  const outerJoin = joinAt(snapshot, 'outer-merge');
  assert.equal(innerJoin.lineage?.length, 2, 'inner parent is outer + mid');
  assert.equal(innerJoin.lineage?.[0]?.branchId, 'o-left');
  assert.equal(innerJoin.lineage?.[1]?.branchId, 'm-left');
  assert.deepEqual(tagIds(midJoin.lineage), [tagIds(innerJoin.lineage?.slice(0, 1))[0] ?? '']);
  assert.equal(midJoin.lineage?.length, 1, 'mid merge restores only the outer tag');
  assert.equal(outerJoin.lineage, undefined, 'outer merge pops the last tag');

  const midArrival = log.entries.find(
    (entry) =>
      entry.event === 'pheromone.emitted' &&
      entry.nodeId === 'mid-merge' &&
      entry.branchId === 'm-left',
  );
  assert.ok(midArrival !== undefined, 'the inner merge output carries the mid tag');
  assert.equal(midArrival.forkId, innerJoin.lineage?.[1]?.forkId);
  const outerArrival = log.entries.find(
    (entry) =>
      entry.event === 'pheromone.emitted' &&
      entry.nodeId === 'outer-merge' &&
      entry.branchId === 'o-left',
  );
  assert.ok(outerArrival !== undefined, 'the mid merge output still carries the outer tag');
  assert.equal(outerArrival.forkId, midJoin.lineage?.[0]?.forkId);
  assert.equal(
    log.entries.find(
      (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
    )?.forkId,
    undefined,
  );
});

test('two outer branches with inner forks keep their groups separate', async () => {
  let clock = START;
  const { executor, calls } = recorder((nodeId) => {
    switch (nodeId) {
      case 'l-a-node':
        return text('L-A');
      case 'l-b-node':
        return text('L-B');
      case 'r-a-node':
        return text('R-A');
      case 'r-b-node':
        return text('R-B');
      default:
        return text('unused');
    }
  });
  const runtime = new PheromoneRuntime(siblingInnerForksComposition(), {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runToRest(runtime, () => {
    clock += 1000;
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.equal(
    serializeValue(calls.find((call) => call.nodeId === 'done')?.input as Value),
    'L-A\nL-B\nR-A\nR-B',
  );

  const leftJoin = joinAt(snapshot, 'left-merge');
  const rightJoin = joinAt(snapshot, 'right-merge');
  const outerJoin = joinAt(snapshot, 'outer-merge');
  assert.equal(leftJoin.forkId === rightJoin.forkId, false, 'each inner fork has its own id');
  assert.equal(leftJoin.lineage?.[0]?.branchId, 'left');
  assert.equal(rightJoin.lineage?.[0]?.branchId, 'right');
  assert.equal(leftJoin.lineage?.[0]?.forkId, rightJoin.lineage?.[0]?.forkId);
  assert.equal(outerJoin.lineage, undefined);
});

test('normal nodes preserve lineage and an inner fork copies a structured Value', async () => {
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'nested-normal-node',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'mid' },
            { id: 'right', to: 'outer-merge' },
          ],
        },
      },
      mid: { kind: 'forager', config: { connection: 'codex', prompt: 'mid' } },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner?' } },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'mid', to: 'inner-fork' },
      { id: 'e3', from: 'ask-inner', to: 'inner-merge' },
      { id: 'e4', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e5', from: 'outer-merge', to: 'done' },
    ],
  });
  const { executor, calls } = recorder((nodeId, input) =>
    nodeId === 'mid' ? { kind: 'structured', value: { n: 1 } } : input,
  );
  let clock = START;
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  // The inner Merge can only activate once per minimum interval.
  clock += 1000;
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false);
  const innerJoin = joinAt(snapshot, 'inner-merge');
  assert.equal(innerJoin.arrived.length, 1);
  const arrived = innerJoin.arrived[0];
  assert.ok(arrived !== undefined);
  assert.deepEqual(arrived.value, { kind: 'structured', value: { n: 1 } });
  assert.equal(arrived.lineage?.length, 2);
  assert.equal(arrived.lineage?.[0]?.branchId, 'left');
  assert.equal(arrived.lineage?.[1]?.branchId, 'i-a');
  assert.equal(arrived.forkId, arrived.lineage?.[1]?.forkId);

  const hovered = snapshot.pheromones.find((pheromone) => pheromone.branchId === 'i-b');
  assert.ok(hovered !== undefined);
  assert.deepEqual(hovered.value, { kind: 'structured', value: { n: 1 } });
  assert.equal(hovered.lineage?.length, 2);

  const token = snapshot.nodes['ask-inner']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('ask-inner', text('reply'), token);
  clock += 1000;
  await runtime.pump();

  assert.equal(runtime.snapshot().rest, true);
  assert.equal(
    serializeValue(calls.find((call) => call.nodeId === 'done')?.input as Value),
    '{"n":1}\nreply\nseed',
  );
});

test('inner optional branches complete the inner merge without changing outer semantics', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(nestedOptionalComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  // The two required inner branches share the inner Merge's minimum interval.
  clock += 1000;
  await runtime.pump();

  let snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false);
  const innerJoin = joinAt(snapshot, 'inner-merge');
  const outerJoin = joinAt(snapshot, 'outer-merge');
  assert.ok(innerJoin.completedAt !== undefined);
  assert.equal(innerJoin.lineage?.[0]?.branchId, 'left');
  assert.equal(outerJoin.completedAt, undefined);
  assert.deepEqual(outerJoin.arrived.map((pheromone) => pheromone.branchId), ['left']);
  assert.equal(outerJoin.lineage, undefined);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);

  const outerToken = snapshot.nodes['ask-outer']?.hover?.token;
  assert.ok(outerToken !== undefined);
  runtime.answerHover('ask-outer', text('reply'), outerToken);
  clock += 1000;
  await runtime.pump();

  snapshot = runtime.snapshot();
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
  assert.equal(
    serializeValue(calls.find((call) => call.nodeId === 'done')?.input as Value),
    'seed\nseed\nreply',
  );
  assert.ok(joinAt(snapshot, 'outer-merge').completedAt !== undefined);
  assert.equal(snapshot.rest, false, 'the optional inner hover still waits');

  const innerToken = snapshot.nodes['ask-inner']?.hover?.token;
  assert.ok(innerToken !== undefined);
  runtime.answerHover('ask-inner', text('late'), innerToken);
  clock += 1000;
  await runtime.pump();

  snapshot = runtime.snapshot();
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
  assert.ok(joinAt(snapshot, 'inner-merge').completedAt !== undefined);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.optional-dropped'));
  assert.equal(snapshot.rest, true);
});

test('an inner timeout cancels only the inner fork and leaves the outer sibling', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(nestedTimeoutComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  let snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false);
  const innerJoin = joinAt(snapshot, 'inner-merge');
  const deadline = innerJoin.deadlineAt;
  assert.ok(deadline !== undefined);
  const innerToken = snapshot.nodes['ask-inner']?.hover?.token;
  const outerToken = snapshot.nodes['ask-outer']?.hover?.token;
  assert.ok(innerToken !== undefined);
  assert.ok(outerToken !== undefined);
  assert.equal(Object.keys(snapshot.nodes['outer-merge']?.joins ?? {}).length, 0);

  clock = deadline;
  await runtime.pump();

  snapshot = runtime.snapshot();
  const timedOut = joinAt(snapshot, 'inner-merge');
  assert.ok(timedOut.timedOutAt !== undefined);
  assert.equal(timedOut.lineage?.[0]?.branchId, 'left');
  assert.equal(snapshot.nodes['ask-inner']?.hover, undefined, 'the inner hover was cancelled');
  assert.equal(
    snapshot.nodes['ask-outer']?.hover?.token,
    outerToken,
    'the outer sibling hover is untouched',
  );
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  assert.equal(snapshot.rest, false);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'timed-out');
  assert.equal(failure.forkId, timedOut.forkId);

  runtime.answerHover('ask-outer', text('reply'), outerToken);
  await runtime.pump();

  snapshot = runtime.snapshot();
  const outerJoin = joinAt(snapshot, 'outer-merge');
  assert.equal(outerJoin.lineage, undefined);
  assert.deepEqual(outerJoin.arrived.map((pheromone) => pheromone.branchId), ['right']);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
});

test('an inner branch failure cancels only the inner fork and leaves the outer sibling', async () => {
  const log = createMemoryLog();
  const executor: NodeExecutor = {
    async execute(node, input) {
      if (node.id === 'boom') {
        throw new Error('inner branch exploded');
      }
      return input;
    },
  };
  const runtime = new PheromoneRuntime(nestedFailureComposition(), {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await assert.rejects(runtime.pump(), /inner branch exploded/);
  // The outer sibling may still be queued when the inner error leaves pump().
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['inner-merge']?.joins, undefined);
  const outerHover = snapshot.nodes['ask-outer']?.hover;
  assert.ok(outerHover !== undefined, 'the outer sibling hover survives');
  assert.equal(snapshot.rest, false);

  const boomForkId = log.entries.find(
    (entry) => entry.event === 'node.activated' && entry.nodeId === 'boom',
  )?.forkId;
  const outerForkId = log.entries.find(
    (entry) => entry.event === 'node.activated' && entry.nodeId === 'ask-outer',
  )?.forkId;
  assert.ok(boomForkId !== undefined);
  assert.ok(outerForkId !== undefined);
  assert.notEqual(boomForkId, outerForkId);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'failed-branch');
  assert.equal(failure.forkId, boomForkId);

  runtime.answerHover('ask-outer', text('reply'), outerHover.token);
  await runtime.pump();

  const after = runtime.snapshot();
  assert.deepEqual(
    joinAt(after, 'outer-merge').arrived.map((pheromone) => pheromone.branchId),
    ['right'],
  );
});

test('honey round-trips nested lineage and restores an incomplete inner join', async () => {
  let clock = START;
  const definition = twoLevelHoverComposition();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const before = runtime.snapshot();
  const beforeJoin = joinAt(before, 'inner-merge');
  assert.equal(beforeJoin.completedAt, undefined);
  assert.equal(beforeJoin.lineage?.length, 1);
  assert.equal(beforeJoin.lineage?.[0]?.branchId, 'left');
  assert.equal(beforeJoin.arrived[0]?.lineage?.length, 2);
  const token = before.nodes['ask-inner']?.hover?.token;
  assert.ok(token !== undefined);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'nested-two-level-hover');
  const field = runtime.exportField();
  store.save(field);
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded, field);

  const restoredRecorder = recorder();
  const { runtime: restored, report } = PheromoneRuntime.restore(definition, loaded, {
    executeForager: restoredRecorder.executor,
    now: () => clock,
  });
  assert.deepEqual(report, { resumedHovers: ['ask-inner'], unknownActive: [], stuckActive: [] });

  const restoredSnapshot = restored.snapshot();
  const restoredJoin = joinAt(restoredSnapshot, 'inner-merge');
  assert.equal(restoredJoin.lineage?.[0]?.branchId, 'left');
  assert.equal(restoredJoin.arrived[0]?.lineage?.length, 2);
  assert.equal(restoredSnapshot.nodes['ask-inner']?.hover?.token, token);

  restored.answerHover('ask-inner', text('reply'), token);
  clock += 1000;
  await restored.pump();

  assert.equal(restored.snapshot().rest, true);
  assert.equal(
    serializeValue(restoredRecorder.calls.find((call) => call.nodeId === 'done')?.input as Value),
    'seed\nreply\nseed',
  );
  assert.equal(joinAt(restored.snapshot(), 'inner-merge').lineage?.[0]?.branchId, 'left');
});

test('a real Honey restart mid-flight keeps a three-level join, hover, queue and pending', async () => {
  let clock = START;
  const definition = threeLevelHoverComposition();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  // Pass 1: descend all three forks and park ask-outer on its user hover.
  runtime.trigger('start', text('seed'));
  await runtime.pump();
  // Pass 2: finish the inner and mid joins, so the outer join holds only o-left.
  clock += 1000;
  await runtime.pump();

  // Detached queue node: q1 drains, q2 lands in pending behind the 5s minimum
  // interval, and q3 stays queued behind q2.
  runtime.trigger('queue-node', text('q1'));
  await runtime.pump();
  runtime.trigger('queue-node', text('q2'));
  runtime.trigger('queue-node', text('q3'));
  await runtime.pump();

  const before = runtime.snapshot();
  assert.equal(before.rest, false);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);

  const innerJoin = joinAt(before, 'inner-merge');
  const midJoin = joinAt(before, 'mid-merge');
  const outerJoin = joinAt(before, 'outer-merge');
  assert.ok(innerJoin.completedAt !== undefined, 'the inner join is a completed tombstone');
  assert.ok(midJoin.completedAt !== undefined, 'the mid join is a completed tombstone');
  assert.equal(innerJoin.arrived.length, 0);
  assert.equal(midJoin.arrived.length, 0);
  assert.deepEqual(
    innerJoin.lineage?.map((tag) => tag.branchId),
    ['o-left', 'm-left'],
    'the inner join remembers both enclosing tags',
  );
  assert.deepEqual(
    midJoin.lineage?.map((tag) => tag.branchId),
    ['o-left'],
    'the mid join remembers only the outer tag',
  );
  assert.equal(outerJoin.completedAt, undefined, 'the outer join is still incomplete');
  assert.equal(outerJoin.arrived.length, 1);
  assert.equal(outerJoin.arrived[0]?.branchId, 'o-left');

  const outerForkId = outerJoin.arrived[0]?.forkId;
  assert.ok(outerForkId !== undefined);
  const token = before.nodes['ask-outer']?.hover?.token;
  assert.ok(token !== undefined);
  const parked = before.pheromones.find(
    (pheromone) => pheromone.forkId === outerForkId && pheromone.branchId === 'o-right',
  );
  assert.ok(parked !== undefined, 'the hovered o-right branch is still in the field');
  assert.equal(before.nodes['ask-outer']?.hover?.pheromoneId, parked.id);

  const queueNode = before.nodes['queue-node'];
  assert.ok(queueNode !== undefined);
  assert.equal(queueNode.queue.length, 1);
  const queued = queueNode.queue[0];
  const pending = queueNode.pending;
  assert.ok(queued !== undefined);
  assert.ok(pending !== undefined, 'q2 waits in pending during the minimum interval');
  assert.equal(serializeValue(queued.value), 'q3');
  assert.equal(serializeValue(pending.value), 'q2');

  // Real persistence: JSON on disk, parsed back, then a brand-new runtime.
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', definition.id);
  const field = runtime.exportField();
  store.save(field);
  assert.equal(existsSync(store.paths.field), true, 'honey/field.json was written');
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded, field);
  assert.equal(loaded.nodes['ask-outer']?.hover?.token, token);
  assert.equal(loaded.nodes['queue-node']?.queue[0]?.id, queued.id);
  assert.equal(loaded.nodes['queue-node']?.pending?.id, pending.id);

  const restoredLog = createMemoryLog();
  const restoredRecorder = recorder();
  const { runtime: restored, report } = PheromoneRuntime.restore(definition, loaded, {
    executeForager: restoredRecorder.executor,
    now: () => clock,
    onLog: restoredLog.sink,
  });

  assert.deepEqual(report, {
    resumedHovers: ['ask-outer'],
    unknownActive: [],
    stuckActive: [],
  });

  const restoredBefore = restored.snapshot();
  assert.equal(restoredBefore.rest, false);
  assert.equal(restoredBefore.nodes['ask-outer']?.hover?.token, token);
  assert.equal(restoredBefore.nodes['ask-outer']?.hover?.pheromoneId, parked.id);
  const restoredParked = restoredBefore.pheromones.find(
    (pheromone) => pheromone.id === parked.id,
  );
  assert.ok(restoredParked !== undefined, 'the hovered branch Pheromone survives restore');
  assert.equal(restoredParked?.branchId, 'o-right');

  const restoredQueueNode = restoredBefore.nodes['queue-node'];
  assert.ok(restoredQueueNode !== undefined);
  assert.equal(restoredQueueNode.queue.length, 1);
  assert.equal(restoredQueueNode.queue[0]?.id, queued.id);
  assert.equal(restoredQueueNode.queue[0]?.at, queued.at);
  assert.equal(restoredQueueNode.pending?.id, pending.id);
  assert.equal(restoredQueueNode.pending?.at, pending.at);
  assert.equal(serializeValue(restoredQueueNode.queue[0]?.value as Value), 'q3');
  assert.equal(serializeValue(restoredQueueNode.pending?.value as Value), 'q2');

  const restoredInner = joinAt(restoredBefore, 'inner-merge');
  const restoredMid = joinAt(restoredBefore, 'mid-merge');
  const restoredOuter = joinAt(restoredBefore, 'outer-merge');
  assert.equal(restoredInner.completedAt, innerJoin.completedAt);
  assert.equal(restoredMid.completedAt, midJoin.completedAt);
  assert.deepEqual(restoredInner.lineage, innerJoin.lineage);
  assert.deepEqual(restoredMid.lineage, midJoin.lineage);
  assert.equal(restoredOuter.completedAt, undefined);
  assert.equal(restoredOuter.arrived.length, 1);
  assert.equal(restoredOuter.arrived[0]?.id, outerJoin.arrived[0]?.id);
  assert.equal(restoredOuter.arrived[0]?.branchId, 'o-left');
  // The same fork groups survive, not newly opened joins.
  assert.deepEqual(
    Object.keys(restoredBefore.nodes['inner-merge']?.joins ?? {}),
    Object.keys(before.nodes['inner-merge']?.joins ?? {}),
  );
  assert.deepEqual(
    Object.keys(restoredBefore.nodes['mid-merge']?.joins ?? {}),
    Object.keys(before.nodes['mid-merge']?.joins ?? {}),
  );
  assert.deepEqual(
    Object.keys(restoredBefore.nodes['outer-merge']?.joins ?? {}),
    Object.keys(before.nodes['outer-merge']?.joins ?? {}),
  );

  // Restoring is not replaying: a completed forager or merge must not run again.
  assert.equal(restoredRecorder.calls.length, 0);
  await restored.pump();
  assert.equal(restoredRecorder.calls.length, 0, 'a quiet pump after restore re-runs nothing');
  assert.equal(
    restoredLog.entries.some((entry) => entry.event === 'node.activated'),
    false,
    'no restored node is activated before new input arrives',
  );
  assert.equal(
    restoredLog.entries.some((entry) => entry.event === 'merge.completed'),
    false,
    'no completed merge is replayed before the answer',
  );

  // Answer with the restored token, then let the outer Merge settle.
  restored.answerHover('ask-outer', text('reply'), token);
  clock += 1000; // outer-merge has its own 1s minimum interval
  await restored.pump();

  assert.deepEqual(restoredRecorder.calls.map((call) => call.nodeId), ['done']);
  assert.equal(
    serializeValue(restoredRecorder.calls[0]?.input as Value),
    'seed\nseed\nseed\nreply',
    'the answer joins the three nested combine layers in order',
  );
  const outerCompleted = joinAt(restored.snapshot(), 'outer-merge');
  assert.ok(outerCompleted.completedAt !== undefined);
  assert.equal(outerCompleted.lineage, undefined, 'the top-level merge pops the outer tag');
  assert.equal(outerCompleted.arrived.length, 0);
  assert.equal(restored.snapshot().nodes['ask-outer']?.hover, undefined);

  const doneArrivals = restoredLog.entries.filter(
    (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
  );
  assert.equal(doneArrivals.length, 1);
  assert.equal(doneArrivals[0]?.forkId, undefined);
  assert.equal(doneArrivals[0]?.branchId, undefined);
  assert.equal(
    restoredLog.entries.filter((entry) => entry.event === 'hover.resolved').length,
    1,
  );
  assert.equal(
    restoredLog.entries.filter(
      (entry) => entry.event === 'merge.completed' && entry.nodeId === 'outer-merge',
    ).length,
    1,
  );
  for (const mergeId of ['inner-merge', 'mid-merge']) {
    assert.equal(
      restoredLog.entries.some(
        (entry) => entry.event === 'node.activated' && entry.nodeId === mergeId,
      ),
      false,
      `${mergeId} is not re-activated after restore`,
    );
  }

  // The restored queue/pending keeps the field busy until its interval elapses.
  assert.equal(restored.snapshot().rest, false);
  clock += 4000; // START + 6000: q2's 5s minimum interval has elapsed
  await restored.pump();
  assert.deepEqual(
    restoredRecorder.calls.map((call) => `${call.nodeId}:${serializeValue(call.input)}`),
    ['done:seed\nseed\nseed\nreply', 'queue-node:q2'],
  );
  assert.equal(restored.snapshot().rest, false, 'q3 still waits behind q2');

  clock += 5000; // START + 11000: q3's 5s minimum interval has elapsed
  await restored.pump();
  assert.equal(restored.snapshot().rest, true);
  assert.deepEqual(
    restoredRecorder.calls.map((call) => `${call.nodeId}:${serializeValue(call.input)}`),
    ['done:seed\nseed\nseed\nreply', 'queue-node:q2', 'queue-node:q3'],
  );
  assert.equal(
    restoredRecorder.calls.filter((call) => call.nodeId === 'done').length,
    1,
    'done runs exactly once across the restart',
  );
  assert.equal(
    restoredRecorder.calls.filter((call) => call.nodeId === 'start').length,
    0,
    'the completed start forager is never replayed',
  );
  assert.equal(
    restoredLog.entries.filter(
      (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
    ).length,
    1,
  );
  const finalInner = joinAt(restored.snapshot(), 'inner-merge');
  const finalMid = joinAt(restored.snapshot(), 'mid-merge');
  assert.equal(finalInner.completedAt, innerJoin.completedAt);
  assert.equal(finalMid.completedAt, midJoin.completedAt);
  assert.deepEqual(finalInner.lineage, innerJoin.lineage);
  assert.deepEqual(finalMid.lineage, midJoin.lineage);
});

test('a restored completed nested tombstone still drops a late optional', async () => {
  let clock = START;
  const log = createMemoryLog();
  const definition = nestedOptionalComposition();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  // Complete the inner required set before persisting the nested tombstone.
  clock += 1000;
  await runtime.pump();

  const beforeJoin = joinAt(runtime.snapshot(), 'inner-merge');
  assert.ok(beforeJoin.completedAt !== undefined);
  assert.equal(beforeJoin.lineage?.[0]?.branchId, 'left');

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'nested-optional');
  store.save(runtime.exportField());
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  const persistedJoin = Object.values(loaded.nodes['inner-merge']?.joins ?? {})[0];
  assert.ok(persistedJoin !== undefined);
  assert.equal(persistedJoin.lineage?.[0]?.branchId, 'left');

  const restoredRecorder = recorder();
  const { runtime: restored } = PheromoneRuntime.restore(definition, loaded, {
    executeForager: restoredRecorder.executor,
    now: () => clock,
    onLog: log.sink,
  });

  const outerToken = restored.snapshot().nodes['ask-outer']?.hover?.token;
  assert.ok(outerToken !== undefined);
  restored.answerHover('ask-outer', text('reply'), outerToken);
  clock += 1000;
  await restored.pump();

  const innerToken = restored.snapshot().nodes['ask-inner']?.hover?.token;
  assert.ok(innerToken !== undefined);
  restored.answerHover('ask-inner', text('late'), innerToken);
  clock += 1000;
  await restored.pump();

  assert.equal(restoredRecorder.calls.filter((call) => call.nodeId === 'done').length, 1);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.optional-dropped'));
  const afterJoin = joinAt(restored.snapshot(), 'inner-merge');
  assert.ok(afterJoin.completedAt !== undefined);
  assert.equal(afterJoin.lineage?.[0]?.branchId, 'left');
  assert.equal(restored.snapshot().rest, true);
});

test('a restored timed-out nested tombstone blocks a late inner branch', async () => {
  let clock = START;
  const log = createMemoryLog();
  const definition = nestedTimeoutComposition();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  const deadline = joinAt(runtime.snapshot(), 'inner-merge').deadlineAt;
  assert.ok(deadline !== undefined);
  clock = deadline;
  await runtime.pump();

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'nested-timeout');
  store.save(runtime.exportField());
  const loaded = store.load();
  assert.ok(loaded !== undefined);

  const joins = loaded.nodes['inner-merge']?.joins ?? {};
  const innerForkId = Object.keys(joins)[0];
  assert.ok(innerForkId !== undefined);
  const persistedJoin = joins[innerForkId];
  assert.ok(persistedJoin !== undefined);
  assert.ok(persistedJoin.timedOutAt !== undefined);
  const outerTag = persistedJoin.lineage?.[0];
  assert.ok(outerTag !== undefined);

  const late: Pheromone = {
    id: 'ph_late_optional',
    traceId: 'tr_late_optional',
    forkId: innerForkId,
    branchId: 'i-opt',
    lineage: [
      { forkId: outerTag.forkId, branchId: outerTag.branchId },
      { forkId: innerForkId, branchId: 'i-opt' },
    ],
    value: text('late'),
    at: new Date(clock).toISOString(),
  };
  const innerNode = loaded.nodes['inner-merge'];
  assert.ok(innerNode !== undefined);
  innerNode.queue.push(late);

  const restoredRecorder = recorder();
  const { runtime: restored } = PheromoneRuntime.restore(definition, loaded, {
    executeForager: restoredRecorder.executor,
    now: () => clock,
    onLog: log.sink,
  });
  await restored.pump();

  assert.equal(restoredRecorder.calls.filter((call) => call.nodeId === 'done').length, 0);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.optional-dropped'));
  const afterJoin = joinAt(restored.snapshot(), 'inner-merge');
  assert.ok(afterJoin.timedOutAt !== undefined);
  assert.equal(afterJoin.lineage?.[0]?.branchId, 'left');
  assert.equal(restored.snapshot().nodes['ask-outer']?.hover !== undefined, true);
});

test('honey validates Pheromone lineage and join lineage', () => {
  const definition = twoLevelComposition();
  const field = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'nested-two-level');

  const badPheromone: Pheromone = {
    id: 'ph_bad',
    traceId: 'tr_bad',
    forkId: 'fk_outer',
    branchId: 'i-a',
    lineage: [
      { forkId: 'fk_outer', branchId: 'left' },
      { forkId: 'fk_other', branchId: 'i-a' },
    ],
    value: text('x'),
    at: new Date(START).toISOString(),
  };
  field.nodes['done'] = { queue: [badPheromone] };
  store.save(field);
  assert.throws(() => store.load(), /to match the last lineage tag/);

  const validArrival: Pheromone = {
    id: 'ph_arrival',
    traceId: 'tr_arrival',
    forkId: 'fk_inner',
    branchId: 'i-a',
    lineage: [
      { forkId: 'fk_outer', branchId: 'left' },
      { forkId: 'fk_inner', branchId: 'i-a' },
    ],
    value: text('x'),
    at: new Date(START).toISOString(),
  };
  const mismatchedJoin: PersistedField = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  mismatchedJoin.nodes['inner-merge'] = {
    queue: [],
    joins: {
      fk_inner: {
        arrived: [validArrival],
        lineage: [{ forkId: 'fk_wrong', branchId: 'left' }],
        deadlineAt: START + 1000,
      },
    },
  };
  store.save(mismatchedJoin);
  assert.throws(() => store.load(), /lineage: does not match its branch Pheromones/);
});
