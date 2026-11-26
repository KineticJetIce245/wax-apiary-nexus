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
  siblingInnerSpreadsComposition,
  nestedOptionalComposition,
  nestedTimeoutComposition,
  nestedFailureComposition,
} from './support/runtime-nested-advanced.js';

test('a single-level spread/gather still emits an untagged top-level output', async () => {
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
  const join = joinAt(snapshot, 'gather');
  assert.ok(join.completedAt !== undefined);
  assert.equal(join.lineage, undefined);
  const emitted = log.entries.find(
    (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
  );
  assert.ok(emitted !== undefined);
  assert.equal(emitted.spreadId, undefined);
  assert.equal(emitted.branchId, undefined);
});

test('an inner gather restores the outer branch tag so the outer gather completes', async () => {
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

  const innerGather = joinAt(snapshot, 'inner-gather');
  const outerGather = joinAt(snapshot, 'outer-gather');
  assert.ok(innerGather.completedAt !== undefined);
  assert.ok(outerGather.completedAt !== undefined);
  assert.equal(innerGather.lineage?.length, 1);
  assert.equal(innerGather.lineage?.[0]?.branchId, 'left');
  const outerSpreadId = innerGather.lineage?.[0]?.spreadId;
  assert.match(outerSpreadId ?? '', /^fk_/);
  assert.equal(outerGather.lineage, undefined, 'the top-level gather pops the last tag');

  const outerArrivals = log.entries.filter(
    (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'outer-gather',
  );
  assert.equal(outerArrivals.length, 2);
  const restored = outerArrivals.find((entry) => entry.branchId === 'left');
  const direct = outerArrivals.find((entry) => entry.branchId === 'right');
  assert.ok(restored !== undefined);
  assert.ok(direct !== undefined);
  assert.equal(restored.spreadId, outerSpreadId, 'the inner gather output keeps the outer spread tag');
  assert.equal(direct.spreadId, outerSpreadId);
  assert.equal(
    log.entries.find(
      (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
    )?.spreadId,
    undefined,
  );
});

test('three levels of nesting pop one lineage tag per gather', async () => {
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

  const innerGather = joinAt(snapshot, 'inner-gather');
  const midGather = joinAt(snapshot, 'mid-gather');
  const outerGather = joinAt(snapshot, 'outer-gather');
  assert.equal(innerGather.lineage?.length, 2, 'inner parent is outer + mid');
  assert.equal(innerGather.lineage?.[0]?.branchId, 'o-left');
  assert.equal(innerGather.lineage?.[1]?.branchId, 'm-left');
  assert.deepEqual(tagIds(midGather.lineage), [tagIds(innerGather.lineage?.slice(0, 1))[0] ?? '']);
  assert.equal(midGather.lineage?.length, 1, 'mid gather restores only the outer tag');
  assert.equal(outerGather.lineage, undefined, 'outer gather pops the last tag');

  const midArrival = log.entries.find(
    (entry) =>
      entry.event === 'pheromone.emitted' &&
      entry.nodeId === 'mid-gather' &&
      entry.branchId === 'm-left',
  );
  assert.ok(midArrival !== undefined, 'the inner gather output carries the mid tag');
  assert.equal(midArrival.spreadId, innerGather.lineage?.[1]?.spreadId);
  const outerArrival = log.entries.find(
    (entry) =>
      entry.event === 'pheromone.emitted' &&
      entry.nodeId === 'outer-gather' &&
      entry.branchId === 'o-left',
  );
  assert.ok(outerArrival !== undefined, 'the mid gather output still carries the outer tag');
  assert.equal(outerArrival.spreadId, midGather.lineage?.[0]?.spreadId);
  assert.equal(
    log.entries.find(
      (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
    )?.spreadId,
    undefined,
  );
});

test('two outer branches with inner spreads keep their groups separate', async () => {
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
  const runtime = new PheromoneRuntime(siblingInnerSpreadsComposition(), {
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

  const leftGather = joinAt(snapshot, 'left-gather');
  const rightGather = joinAt(snapshot, 'right-gather');
  const outerGather = joinAt(snapshot, 'outer-gather');
  assert.equal(leftGather.spreadId === rightGather.spreadId, false, 'each inner spread has its own id');
  assert.equal(leftGather.lineage?.[0]?.branchId, 'left');
  assert.equal(rightGather.lineage?.[0]?.branchId, 'right');
  assert.equal(leftGather.lineage?.[0]?.spreadId, rightGather.lineage?.[0]?.spreadId);
  assert.equal(outerGather.lineage, undefined);
});

test('normal nodes preserve lineage and an inner spread copies a structured Value', async () => {
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'nested-normal-node',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'left', to: 'mid' },
            { id: 'right', to: 'outer-gather' },
          ],
        },
      },
      mid: { kind: 'forager', config: { connection: 'codex', prompt: 'mid' } },
      'inner-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-gather' },
            { id: 'i-b', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner?' } },
      'inner-gather': { kind: 'gather', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-gather': { kind: 'gather', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'mid', to: 'inner-spread' },
      { id: 'e3', from: 'ask-inner', to: 'inner-gather' },
      { id: 'e4', from: 'inner-gather', to: 'outer-gather' },
      { id: 'e5', from: 'outer-gather', to: 'done' },
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
  // The inner Gather can only activate once per minimum interval.
  clock += 1000;
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false);
  const innerGather = joinAt(snapshot, 'inner-gather');
  assert.equal(innerGather.arrived.length, 1);
  const arrived = innerGather.arrived[0];
  assert.ok(arrived !== undefined);
  assert.deepEqual(arrived.value, { kind: 'structured', value: { n: 1 } });
  assert.equal(arrived.lineage?.length, 2);
  assert.equal(arrived.lineage?.[0]?.branchId, 'left');
  assert.equal(arrived.lineage?.[1]?.branchId, 'i-a');
  assert.equal(arrived.spreadId, arrived.lineage?.[1]?.spreadId);

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

test('inner optional branches complete the inner gather without changing outer semantics', async () => {
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
  // The two required inner branches share the inner Gather's minimum interval.
  clock += 1000;
  await runtime.pump();

  let snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, false);
  const innerGather = joinAt(snapshot, 'inner-gather');
  const outerGather = joinAt(snapshot, 'outer-gather');
  assert.ok(innerGather.completedAt !== undefined);
  assert.equal(innerGather.lineage?.[0]?.branchId, 'left');
  assert.equal(outerGather.completedAt, undefined);
  assert.deepEqual(outerGather.arrived.map((pheromone) => pheromone.branchId), ['left']);
  assert.equal(outerGather.lineage, undefined);
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
  assert.ok(joinAt(snapshot, 'outer-gather').completedAt !== undefined);
  assert.equal(snapshot.rest, false, 'the optional inner hover still waits');

  const innerToken = snapshot.nodes['ask-inner']?.hover?.token;
  assert.ok(innerToken !== undefined);
  runtime.answerHover('ask-inner', text('late'), innerToken);
  clock += 1000;
  await runtime.pump();

  snapshot = runtime.snapshot();
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
  assert.ok(joinAt(snapshot, 'inner-gather').completedAt !== undefined);
  assert.ok(log.entries.some((entry) => entry.event === 'gather.optional-dropped'));
  assert.equal(snapshot.rest, true);
});

test('an inner timeout cancels only the inner spread and leaves the outer sibling', async () => {
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
  const innerGather = joinAt(snapshot, 'inner-gather');
  const deadline = innerGather.deadlineAt;
  assert.ok(deadline !== undefined);
  const innerToken = snapshot.nodes['ask-inner']?.hover?.token;
  const outerToken = snapshot.nodes['ask-outer']?.hover?.token;
  assert.ok(innerToken !== undefined);
  assert.ok(outerToken !== undefined);
  assert.equal(Object.keys(snapshot.nodes['outer-gather']?.gathers ?? {}).length, 0);

  clock = deadline;
  await runtime.pump();

  snapshot = runtime.snapshot();
  const timedOut = joinAt(snapshot, 'inner-gather');
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
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'timed-out');
  assert.equal(failure.spreadId, timedOut.spreadId);

  runtime.answerHover('ask-outer', text('reply'), outerToken);
  await runtime.pump();

  snapshot = runtime.snapshot();
  const outerGather = joinAt(snapshot, 'outer-gather');
  assert.equal(outerGather.lineage, undefined);
  assert.deepEqual(outerGather.arrived.map((pheromone) => pheromone.branchId), ['right']);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
});

test('an inner branch failure cancels only the inner spread and leaves the outer sibling', async () => {
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
  assert.equal(snapshot.nodes['inner-gather']?.gathers, undefined);
  const outerHover = snapshot.nodes['ask-outer']?.hover;
  assert.ok(outerHover !== undefined, 'the outer sibling hover survives');
  assert.equal(snapshot.rest, false);

  const boomSpreadId = log.entries.find(
    (entry) => entry.event === 'node.activated' && entry.nodeId === 'boom',
  )?.spreadId;
  const outerSpreadId = log.entries.find(
    (entry) => entry.event === 'node.activated' && entry.nodeId === 'ask-outer',
  )?.spreadId;
  assert.ok(boomSpreadId !== undefined);
  assert.ok(outerSpreadId !== undefined);
  assert.notEqual(boomSpreadId, outerSpreadId);
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'failed-branch');
  assert.equal(failure.spreadId, boomSpreadId);

  runtime.answerHover('ask-outer', text('reply'), outerHover.token);
  await runtime.pump();

  const after = runtime.snapshot();
  assert.deepEqual(
    joinAt(after, 'outer-gather').arrived.map((pheromone) => pheromone.branchId),
    ['right'],
  );
});
