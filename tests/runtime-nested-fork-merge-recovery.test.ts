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
  assert.equal(loaded.nodes['queue-node']?.queue?.[0]?.id, queued.id);
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
  appendQueued(innerNode, late);

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

/** Persisted node states may omit an empty mailbox; append without a `??`. */
function appendQueued(
  state: { queue?: Pheromone[] },
  pheromone: Pheromone,
): void {
  const queue = state.queue;
  if (queue === undefined) {
    state.queue = [pheromone];
  } else {
    queue.push(pheromone);
  }
}
