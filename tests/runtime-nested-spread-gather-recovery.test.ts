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

test('honey round-trips nested lineage and restores an incomplete inner join', async () => {
  let clock = START;
  const definition = twoLevelHoverComposition();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const before = runtime.snapshot();
  const beforeGather = joinAt(before, 'inner-gather');
  assert.equal(beforeGather.completedAt, undefined);
  assert.equal(beforeGather.lineage?.length, 1);
  assert.equal(beforeGather.lineage?.[0]?.branchId, 'left');
  assert.equal(beforeGather.arrived[0]?.lineage?.length, 2);
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
  const restoredGather = joinAt(restoredSnapshot, 'inner-gather');
  assert.equal(restoredGather.lineage?.[0]?.branchId, 'left');
  assert.equal(restoredGather.arrived[0]?.lineage?.length, 2);
  assert.equal(restoredSnapshot.nodes['ask-inner']?.hover?.token, token);

  restored.answerHover('ask-inner', text('reply'), token);
  clock += 1000;
  await restored.pump();

  assert.equal(restored.snapshot().rest, true);
  assert.equal(
    serializeValue(restoredRecorder.calls.find((call) => call.nodeId === 'done')?.input as Value),
    'seed\nreply\nseed',
  );
  assert.equal(joinAt(restored.snapshot(), 'inner-gather').lineage?.[0]?.branchId, 'left');
});

test('a real Honey restart mid-flight keeps a three-level join, hover, queue and pending', async () => {
  let clock = START;
  const definition = threeLevelHoverComposition();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  // Pass 1: descend all three spreads and park ask-outer on its user hover.
  runtime.admit('start', text('seed'));
  await runtime.pump();
  // Pass 2: finish the inner and mid gathers, so the outer join holds only o-left.
  clock += 1000;
  await runtime.pump();

  // Detached queue node: q1 drains, q2 lands in pending behind the 5s minimum
  // interval, and q3 stays queued behind q2.
  runtime.admit('queue-node', text('q1'));
  await runtime.pump();
  runtime.admit('queue-node', text('q2'));
  runtime.admit('queue-node', text('q3'));
  await runtime.pump();

  const before = runtime.snapshot();
  assert.equal(before.rest, false);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);

  const innerGather = joinAt(before, 'inner-gather');
  const midGather = joinAt(before, 'mid-gather');
  const outerGather = joinAt(before, 'outer-gather');
  assert.ok(innerGather.completedAt !== undefined, 'the inner join is a completed tombstone');
  assert.ok(midGather.completedAt !== undefined, 'the mid join is a completed tombstone');
  assert.equal(innerGather.arrived.length, 0);
  assert.equal(midGather.arrived.length, 0);
  assert.deepEqual(
    innerGather.lineage?.map((tag) => tag.branchId),
    ['o-left', 'm-left'],
    'the inner join remembers both enclosing tags',
  );
  assert.deepEqual(
    midGather.lineage?.map((tag) => tag.branchId),
    ['o-left'],
    'the mid join remembers only the outer tag',
  );
  assert.equal(outerGather.completedAt, undefined, 'the outer join is still incomplete');
  assert.equal(outerGather.arrived.length, 1);
  assert.equal(outerGather.arrived[0]?.branchId, 'o-left');

  const outerSpreadId = outerGather.arrived[0]?.spreadId;
  assert.ok(outerSpreadId !== undefined);
  const token = before.nodes['ask-outer']?.hover?.token;
  assert.ok(token !== undefined);
  const parked = before.pheromones.find(
    (pheromone) => pheromone.spreadId === outerSpreadId && pheromone.branchId === 'o-right',
  );
  assert.ok(parked !== undefined, 'the hovered o-right branch is still in the field');
  assert.equal(before.nodes['ask-outer']?.hover?.pheromoneId, parked.id);

  const queueNode = before.nodes['queue-node'];
  assert.ok(queueNode !== undefined);
  assert.equal(queueNode.receptor.length, 1);
  const queued = queueNode.receptor[0];
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
  assert.equal(loaded.nodes['queue-node']?.receptor?.[0]?.id, queued.id);
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
  assert.equal(restoredQueueNode.receptor.length, 1);
  assert.equal(restoredQueueNode.receptor[0]?.id, queued.id);
  assert.equal(restoredQueueNode.receptor[0]?.at, queued.at);
  assert.equal(restoredQueueNode.pending?.id, pending.id);
  assert.equal(restoredQueueNode.pending?.at, pending.at);
  assert.equal(serializeValue(restoredQueueNode.receptor[0]?.value as Value), 'q3');
  assert.equal(serializeValue(restoredQueueNode.pending?.value as Value), 'q2');

  const restoredInner = joinAt(restoredBefore, 'inner-gather');
  const restoredMid = joinAt(restoredBefore, 'mid-gather');
  const restoredOuter = joinAt(restoredBefore, 'outer-gather');
  assert.equal(restoredInner.completedAt, innerGather.completedAt);
  assert.equal(restoredMid.completedAt, midGather.completedAt);
  assert.deepEqual(restoredInner.lineage, innerGather.lineage);
  assert.deepEqual(restoredMid.lineage, midGather.lineage);
  assert.equal(restoredOuter.completedAt, undefined);
  assert.equal(restoredOuter.arrived.length, 1);
  assert.equal(restoredOuter.arrived[0]?.id, outerGather.arrived[0]?.id);
  assert.equal(restoredOuter.arrived[0]?.branchId, 'o-left');
  // The same spread groups survive, not newly opened gathers.
  assert.deepEqual(
    Object.keys(restoredBefore.nodes['inner-gather']?.gathers ?? {}),
    Object.keys(before.nodes['inner-gather']?.gathers ?? {}),
  );
  assert.deepEqual(
    Object.keys(restoredBefore.nodes['mid-gather']?.gathers ?? {}),
    Object.keys(before.nodes['mid-gather']?.gathers ?? {}),
  );
  assert.deepEqual(
    Object.keys(restoredBefore.nodes['outer-gather']?.gathers ?? {}),
    Object.keys(before.nodes['outer-gather']?.gathers ?? {}),
  );

  // Restoring is not replaying: a completed forager or gather must not run again.
  assert.equal(restoredRecorder.calls.length, 0);
  await restored.pump();
  assert.equal(restoredRecorder.calls.length, 0, 'a quiet pump after restore re-runs nothing');
  assert.equal(
    restoredLog.entries.some((entry) => entry.event === 'node.activated'),
    false,
    'no restored node is activated before new input arrives',
  );
  assert.equal(
    restoredLog.entries.some((entry) => entry.event === 'gather.completed'),
    false,
    'no completed gather is replayed before the answer',
  );

  // Answer with the restored token, then let the outer Gather settle.
  restored.answerHover('ask-outer', text('reply'), token);
  clock += 1000; // outer-gather has its own 1s minimum interval
  await restored.pump();

  assert.deepEqual(restoredRecorder.calls.map((call) => call.nodeId), ['done']);
  assert.equal(
    serializeValue(restoredRecorder.calls[0]?.input as Value),
    'seed\nseed\nseed\nreply',
    'the answer gathers the three nested combine layers in order',
  );
  const outerCompleted = joinAt(restored.snapshot(), 'outer-gather');
  assert.ok(outerCompleted.completedAt !== undefined);
  assert.equal(outerCompleted.lineage, undefined, 'the top-level gather pops the outer tag');
  assert.equal(outerCompleted.arrived.length, 0);
  assert.equal(restored.snapshot().nodes['ask-outer']?.hover, undefined);

  const doneArrivals = restoredLog.entries.filter(
    (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'done',
  );
  assert.equal(doneArrivals.length, 1);
  assert.equal(doneArrivals[0]?.spreadId, undefined);
  assert.equal(doneArrivals[0]?.branchId, undefined);
  assert.equal(
    restoredLog.entries.filter((entry) => entry.event === 'hover.resolved').length,
    1,
  );
  assert.equal(
    restoredLog.entries.filter(
      (entry) => entry.event === 'gather.completed' && entry.nodeId === 'outer-gather',
    ).length,
    1,
  );
  for (const gatherId of ['inner-gather', 'mid-gather']) {
    assert.equal(
      restoredLog.entries.some(
        (entry) => entry.event === 'node.activated' && entry.nodeId === gatherId,
      ),
      false,
      `${gatherId} is not re-activated after restore`,
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
  const finalInner = joinAt(restored.snapshot(), 'inner-gather');
  const finalMid = joinAt(restored.snapshot(), 'mid-gather');
  assert.equal(finalInner.completedAt, innerGather.completedAt);
  assert.equal(finalMid.completedAt, midGather.completedAt);
  assert.deepEqual(finalInner.lineage, innerGather.lineage);
  assert.deepEqual(finalMid.lineage, midGather.lineage);
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

  runtime.admit('start', text('seed'));
  await runtime.pump();
  // Complete the inner required set before persisting the nested tombstone.
  clock += 1000;
  await runtime.pump();

  const beforeGather = joinAt(runtime.snapshot(), 'inner-gather');
  assert.ok(beforeGather.completedAt !== undefined);
  assert.equal(beforeGather.lineage?.[0]?.branchId, 'left');

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'nested-optional');
  store.save(runtime.exportField());
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  const persistedGather = Object.values(loaded.nodes['inner-gather']?.gathers ?? {})[0];
  assert.ok(persistedGather !== undefined);
  assert.equal(persistedGather.lineage?.[0]?.branchId, 'left');

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
  assert.ok(log.entries.some((entry) => entry.event === 'gather.optional-dropped'));
  const afterGather = joinAt(restored.snapshot(), 'inner-gather');
  assert.ok(afterGather.completedAt !== undefined);
  assert.equal(afterGather.lineage?.[0]?.branchId, 'left');
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

  runtime.admit('start', text('seed'));
  await runtime.pump();
  const deadline = joinAt(runtime.snapshot(), 'inner-gather').deadlineAt;
  assert.ok(deadline !== undefined);
  clock = deadline;
  await runtime.pump();

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'nested-timeout');
  store.save(runtime.exportField());
  const loaded = store.load();
  assert.ok(loaded !== undefined);

  const gathers = loaded.nodes['inner-gather']?.gathers ?? {};
  const innerSpreadId = Object.keys(gathers)[0];
  assert.ok(innerSpreadId !== undefined);
  const persistedGather = gathers[innerSpreadId];
  assert.ok(persistedGather !== undefined);
  assert.ok(persistedGather.timedOutAt !== undefined);
  const outerTag = persistedGather.lineage?.[0];
  assert.ok(outerTag !== undefined);

  const late: Pheromone = {
    id: 'ph_late_optional',
    spreadId: innerSpreadId,
    branchId: 'i-opt',
    lineage: [
      { spreadId: outerTag.spreadId, branchId: outerTag.branchId },
      { spreadId: innerSpreadId, branchId: 'i-opt' },
    ],
    value: text('late'),
    at: new Date(clock).toISOString(),
  };
  const innerNode = loaded.nodes['inner-gather'];
  assert.ok(innerNode !== undefined);
  appendQueued(innerNode, late);

  const restoredRecorder = recorder();
  const { runtime: restored } = PheromoneRuntime.restore(definition, loaded, {
    executeForager: restoredRecorder.executor,
    now: () => clock,
    onLog: log.sink,
  });
  await restored.pump();

  assert.equal(restoredRecorder.calls.filter((call) => call.nodeId === 'done').length, 0);
  assert.ok(log.entries.some((entry) => entry.event === 'gather.optional-dropped'));
  const afterGather = joinAt(restored.snapshot(), 'inner-gather');
  assert.ok(afterGather.timedOutAt !== undefined);
  assert.equal(afterGather.lineage?.[0]?.branchId, 'left');
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
    spreadId: 'fk_outer',
    branchId: 'i-a',
    lineage: [
      { spreadId: 'fk_outer', branchId: 'left' },
      { spreadId: 'fk_other', branchId: 'i-a' },
    ],
    value: text('x'),
    at: new Date(START).toISOString(),
  };
  field.nodes['done'] = { receptor: [badPheromone] };
  store.save(field);
  assert.throws(() => store.load(), /to match the last lineage tag/);

  const validArrival: Pheromone = {
    id: 'ph_arrival',
    spreadId: 'fk_inner',
    branchId: 'i-a',
    lineage: [
      { spreadId: 'fk_outer', branchId: 'left' },
      { spreadId: 'fk_inner', branchId: 'i-a' },
    ],
    value: text('x'),
    at: new Date(START).toISOString(),
  };
  const mismatchedGather: PersistedField = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  mismatchedGather.nodes['inner-gather'] = {
    receptor: [],
    gathers: {
      fk_inner: {
        arrived: [validArrival],
        lineage: [{ spreadId: 'fk_wrong', branchId: 'left' }],
        deadlineAt: START + 1000,
      },
    },
  };
  store.save(mismatchedGather);
  assert.throws(() => store.load(), /lineage: does not match its branch Pheromones/);
});

/** Persisted node states may omit an empty receptor; append without a `??`. */
function appendQueued(
  state: { receptor?: Pheromone[] },
  pheromone: Pheromone,
): void {
  const queue = state.receptor;
  if (queue === undefined) {
    state.receptor = [pheromone];
  } else {
    queue.push(pheromone);
  }
}
