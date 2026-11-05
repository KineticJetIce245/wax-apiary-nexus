import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPLETED_JOIN_TTL_MS,
  createMemoryLog,
  MAX_COMPLETED_JOINS_PER_MERGE,
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type JoinStateSnapshot,
  type NodeExecutor,
  type PersistedField,
  type PersistedJoinState,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';
import { findActiveReferences } from '../src/revision.js';

const START = Date.parse('2026-06-01T00:00:00.000Z');
const TIMEOUT = 5000;

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function recorder(): {
  readonly executor: NodeExecutor;
  readonly calls: { nodeId: string; input: Value }[];
} {
  const calls: { nodeId: string; input: Value }[] = [];
  return {
    calls,
    executor: {
      async execute(node, input) {
        calls.push({ nodeId: node.id, input });
        return input;
      },
    },
  };
}

function branchPheromone(
  forkId: string,
  branchId: string,
  value: Value = text('x'),
): Pheromone {
  return {
    id: `ph_${forkId}_${branchId}`,
    traceId: `tr_${forkId}`,
    forkId,
    branchId,
    value,
    at: new Date(START).toISOString(),
  };
}

/** start -> fork (a,b -> merge required); merge -> done. */
function directComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-direct',
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
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text', timeoutMs } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a -> merge, b -> ask -> merge required); merge -> done. */
function hoverRequiredComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      merge: {
        kind: 'merge',
        config: { required: ['a', 'b'], combine: 'text', timeoutMs },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

/** start -> fork (a -> ask -> merge required; b -> merge optional); merge -> done. */
function optionalFirstComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-optional-first',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'ask' },
            { id: 'b', to: 'merge' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'A?' } },
      merge: {
        kind: 'merge',
        config: { required: ['a'], optional: ['b'], combine: 'text', timeoutMs },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

/**
 * start -> fork (a -> merge, b -> merge optional); merge requires ['a', 'c']
 * (c has no edge, which is enough for the field fixture) and -> done.
 */
function optionalLateComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-late-optional',
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
      merge: {
        kind: 'merge',
        config: { required: ['a', 'c'], optional: ['b'], combine: 'text', timeoutMs },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

function emptyField(definition: CompositionDefinition): PersistedField {
  const field = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    now: () => START,
  }).exportField();
  field.rest = false;
  return field;
}

function withJoin(
  definition: CompositionDefinition,
  join: PersistedJoinState,
  queue: Pheromone[] = [],
  forkId = 'fk_one',
): PersistedField {
  const field = emptyField(definition);
  field.nodes['merge'] = { queue, joins: { [forkId]: join } };
  return field;
}

function joinOf(
  snapshot: ReturnType<PheromoneRuntime['snapshot']>,
): JoinStateSnapshot | undefined {
  return Object.values(snapshot.nodes['merge']?.joins ?? {})[0];
}

test('required branches that arrive before the deadline emit and disable the timeout', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(directComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  assert.equal(joinOf(waiting)?.deadlineAt, START + TIMEOUT);
  assert.equal(runtime.nextWakeAt(), START + TIMEOUT);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);

  // The second required branch arrives well before the deadline.
  clock = START + 1000;
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
  const completed = joinOf(runtime.snapshot());
  assert.ok(completed !== undefined);
  assert.ok(completed.completedAt !== undefined);
  assert.equal(completed.timedOutAt, undefined);
  assert.equal(completed.deadlineAt, undefined);
  assert.equal(runtime.nextWakeAt(), undefined);
  assert.equal(runtime.snapshot().rest, true);

  // The old deadline can no longer fire.
  clock = START + TIMEOUT * 10;
  await runtime.pump();
  assert.equal(log.entries.filter((entry) => entry.event === 'merge.timed-out').length, 0);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
});

test('a deadline with required branches missing fails the fork, cancels siblings and emits nothing', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(hoverRequiredComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  assert.equal(runtime.snapshot().rest, false);
  assert.ok(runtime.snapshot().nodes['ask']?.hover !== undefined);
  const deadline = runtime.nextWakeAt();
  assert.ok(deadline !== undefined);
  assert.equal(deadline, START + TIMEOUT);

  clock = deadline;
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.equal(snapshot.nodes['ask']?.hover, undefined, 'the queued sibling hover was cancelled');
  assert.equal(snapshot.nodes['ask']?.queue.length, 0);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0, 'no merge emit');
  const join = joinOf(snapshot);
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.equal(join.completedAt, undefined);
  assert.deepEqual(join.arrived, []);
  assert.equal(log.entries.filter((entry) => entry.event === 'merge.timed-out').length, 1);
  const failure = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'timed-out');
  assert.ok(log.entries.some((entry) => entry.event === 'hover.cancelled'));
});

test('a quiet field with no in-flight branch waits for the deadline instead of failing early', async () => {
  let clock = START;
  const log = createMemoryLog();
  const definition = directComposition();
  const deadline = START + TIMEOUT;
  const field = withJoin(definition, {
    arrived: [branchPheromone('fk_one', 'a')],
    deadlineAt: deadline,
  });

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => clock,
    onLog: log.sink,
  });

  assert.equal(runtime.snapshot().rest, false);
  assert.equal(runtime.nextWakeAt(), deadline);
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, false, 'pump never fails a join before its deadline');
  assert.equal(log.entries.filter((entry) => entry.event === 'merge.failed').length, 0);

  clock = deadline - 1;
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, false);
  assert.equal(joinOf(runtime.snapshot())?.timedOutAt, undefined);

  clock = deadline;
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, true);
  assert.ok(joinOf(runtime.snapshot())?.timedOutAt !== undefined);
});

test('restore with an unexpired deadline continues and nextWakeAt stays correct', async () => {
  const log = createMemoryLog();
  const definition = directComposition();
  const deadline = START + TIMEOUT;
  const field = withJoin(
    definition,
    { arrived: [branchPheromone('fk_one', 'a', text('A'))], deadlineAt: deadline },
    [branchPheromone('fk_one', 'b', text('B'))],
  );
  const { calls, executor } = recorder();

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  assert.equal(runtime.snapshot().rest, false);
  assert.equal(runtime.nextWakeAt(), deadline);

  await runtime.pump();

  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.equal(doneCalls.length, 1);
  assert.equal(log.entries.filter((entry) => entry.event === 'merge.timed-out').length, 0);
  const join = joinOf(runtime.snapshot());
  assert.ok(join?.completedAt !== undefined);
  assert.equal(join.timedOutAt, undefined);
  assert.equal(runtime.nextWakeAt(), undefined);
});

test('restore with an expired deadline times out immediately without emitting', () => {
  const log = createMemoryLog();
  const definition = directComposition();
  const field = withJoin(definition, {
    arrived: [branchPheromone('fk_one', 'a')],
    deadlineAt: START - 1000,
  });
  const { calls, executor } = recorder();

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.equal(runtime.nextWakeAt(), undefined);
  const join = joinOf(snapshot);
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.equal(join.deadlineAt, undefined);
  assert.deepEqual(join.arrived, []);
  assert.deepEqual(calls, []);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.timed-out'));

  const exported = runtime.exportField();
  const persisted = Object.values(exported.nodes['merge']?.joins ?? {})[0];
  assert.ok(persisted !== undefined);
  assert.ok(persisted.timedOutAt !== undefined);
  assert.equal(persisted.deadlineAt, undefined);
  assert.deepEqual(persisted.arrived, []);
});

test('a late required branch after a timeout is dropped without rejoining or a second emit', async () => {
  const log = createMemoryLog();
  const definition = directComposition();
  const forkId = 'fk_late_required';
  const expired = withJoin(
    definition,
    { arrived: [branchPheromone(forkId, 'a')], deadlineAt: START - 1000 },
    [],
    forkId,
  );
  const { calls, executor } = recorder();

  // First restore closes the join; the late branch is then injected as if an
  // active sibling had finished after the timeout.
  const closed = PheromoneRuntime.restore(definition, expired, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  }).runtime;
  const field = closed.exportField();
  field.nodes['merge'] = {
    queue: [branchPheromone(forkId, 'b')],
    ...(field.nodes['merge']?.joins === undefined
      ? {}
      : { joins: field.nodes['merge']?.joins }),
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor,
    now: () => START + 1000,
    onLog: log.sink,
  });
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const join = joinOf(runtime.snapshot());
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.deepEqual(join.arrived, []);
  const late = log.entries.find(
    (entry) => entry.event === 'merge.failed' && entry.outcome === 'late-required',
  );
  assert.ok(late !== undefined);
  assert.equal(late.forkId, forkId);
  assert.equal(runtime.snapshot().rest, true);
});

test('a late optional branch after a timeout is dropped without reopening the join', async () => {
  const log = createMemoryLog();
  const definition = optionalLateComposition();
  const forkId = 'fk_late_optional';
  const expired = withJoin(
    definition,
    { arrived: [branchPheromone(forkId, 'a')], deadlineAt: START - 1000 },
    [],
    forkId,
  );
  const { calls, executor } = recorder();

  const closed = PheromoneRuntime.restore(definition, expired, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  }).runtime;
  const field = closed.exportField();
  field.nodes['merge'] = {
    queue: [branchPheromone(forkId, 'b')],
    ...(field.nodes['merge']?.joins === undefined
      ? {}
      : { joins: field.nodes['merge']?.joins }),
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor,
    now: () => START + 1000,
    onLog: log.sink,
  });
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const join = joinOf(runtime.snapshot());
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.deepEqual(join.arrived, []);
  const dropped = log.entries.find((entry) => entry.event === 'merge.optional-dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.forkId, forkId);
  assert.equal(runtime.snapshot().rest, true);
});

test('an arrived optional branch never blocks the required timeout', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(optionalFirstComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  const waitingJoin = joinOf(waiting);
  assert.ok(waitingJoin !== undefined);
  assert.deepEqual(
    waitingJoin.arrived.map((pheromone) => pheromone.branchId),
    ['b'],
    'the optional branch arrived first',
  );
  assert.ok(waiting.nodes['ask']?.hover !== undefined);

  clock = START + TIMEOUT;
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const join = joinOf(runtime.snapshot());
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.equal(runtime.snapshot().rest, true);
  assert.ok(log.entries.some((entry) => entry.event === 'merge.timed-out'));
});

test('a required branch that arrives after the deadline times out instead of emitting', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(directComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('seed'));
  await runtime.pump();
  const deadline = runtime.nextWakeAt();
  assert.ok(deadline !== undefined);

  // The second required branch is still rate-limited when the deadline passes.
  clock = deadline;
  await runtime.pump();

  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0);
  const join = joinOf(runtime.snapshot());
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.equal(join.completedAt, undefined);
  assert.equal(log.entries.filter((entry) => entry.event === 'merge.timed-out').length, 1);
  assert.equal(runtime.snapshot().rest, true);
});

test('a timed-out tombstone is not a Rest blocker or an active edit reference', () => {
  const definition = directComposition();
  const field = withJoin(definition, {
    arrived: [],
    timedOutAt: new Date(START - 1000).toISOString(),
  });
  field.rest = true;

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  });

  assert.equal(runtime.snapshot().rest, true);
  assert.deepEqual(findActiveReferences(runtime.snapshot()), []);
  assert.equal(runtime.nextWakeAt(), undefined);
});

test('timed-out tombstones share the completed 1h/64 cleanup bound on restore', () => {
  const definition = directComposition();
  const field = emptyField(definition);
  const joins: Record<string, PersistedJoinState> = {};
  for (let index = 0; index < MAX_COMPLETED_JOINS_PER_MERGE + 2; index += 1) {
    joins[`fk_${String(index)}`] = {
      arrived: [],
      timedOutAt: new Date(START - index * 1000).toISOString(),
    };
  }
  field.nodes['merge'] = { queue: [], joins };
  field.rest = true;

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  });

  const restored = runtime.snapshot().nodes['merge']?.joins ?? {};
  assert.equal(Object.keys(restored).length, MAX_COMPLETED_JOINS_PER_MERGE);
  assert.equal(restored['fk_65'], undefined);
  assert.equal(restored['fk_64'], undefined);
  assert.ok(restored['fk_63'] !== undefined);

  // A marker older than the shared TTL is pruned as well.
  field.nodes['merge'] = {
    queue: [],
    joins: {
      fk_stale: {
        arrived: [],
        timedOutAt: new Date(START - COMPLETED_JOIN_TTL_MS - 1000).toISOString(),
      },
      fk_fresh: { arrived: [], timedOutAt: new Date(START).toISOString() },
    },
  };
  const second = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  }).runtime.snapshot().nodes['merge']?.joins;
  assert.equal(second?.['fk_stale'], undefined);
  assert.ok(second?.['fk_fresh'] !== undefined);
});
