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
import {
  START,
  text,
  runToRest,
  recorder,
  tempRoot,
  tagIds,
  joinAt,
  singleLevelComposition,
  twoLevelComposition,
  twoLevelHoverComposition,
  threeLevelComposition,
  threeLevelHoverComposition,
} from './support/runtime-nested-fixtures.js';
import {
  siblingInnerForksComposition,
  nestedOptionalComposition,
  nestedTimeoutComposition,
  nestedFailureComposition,
} from './support/runtime-nested-advanced.js';

test('a single-level fork/merge still emits an untagged top-level output', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(singleLevelComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
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

  runtime.admit('start', text('seed'));
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
