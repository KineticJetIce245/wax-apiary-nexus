import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPLETED_GATHER_TTL_MS,
  createMemoryLog,
  MAX_COMPLETED_GATHERS,
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type GatherStateSnapshot,
  type NodeExecutor,
  type PersistedField,
  type PersistedGatherState,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';

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
  spreadId: string,
  branchId: string,
  value: Value = text('x'),
): Pheromone {
  return {
    id: `ph_${spreadId}_${branchId}`,
    spreadId,
    branchId,
    value,
    at: new Date(START).toISOString(),
  };
}

/** start -> spread (a,b -> gather required); gather -> done. */
function directComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-direct',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'gather' },
          ],
        },
      },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text', timeoutMs } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
    ],
  });
}

/** start -> spread (a -> gather, b -> ask -> gather required); gather -> done. */
function hoverRequiredComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      gather: {
        kind: 'gather',
        config: { required: ['a', 'b'], combine: 'text', timeoutMs },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

/** start -> spread (a -> ask -> gather required; b -> gather optional); gather -> done. */
function optionalFirstComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-optional-first',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'ask' },
            { id: 'b', to: 'gather' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'A?' } },
      gather: {
        kind: 'gather',
        config: { required: ['a'], optional: ['b'], combine: 'text', timeoutMs },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

/**
 * start -> spread (a -> gather, b -> gather optional); gather requires ['a', 'c']
 * (c has no edge, which is enough for the field fixture) and -> done.
 */
function optionalLateComposition(timeoutMs: number = TIMEOUT): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'timeout-late-optional',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'gather' },
          ],
        },
      },
      gather: {
        kind: 'gather',
        config: { required: ['a', 'c'], optional: ['b'], combine: 'text', timeoutMs },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
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

function withGather(
  definition: CompositionDefinition,
  join: PersistedGatherState,
  receptor: Pheromone[] = [],
  spreadId = 'fk_one',
): PersistedField {
  const field = emptyField(definition);
  field.nodes['gather'] = { receptor, gathers: { [spreadId]: join } };
  return field;
}

function joinOf(
  snapshot: ReturnType<PheromoneRuntime['snapshot']>,
): GatherStateSnapshot | undefined {
  return Object.values(snapshot.nodes['gather']?.gathers ?? {})[0];
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

  runtime.admit('start', text('seed'));
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
  assert.equal(log.entries.filter((entry) => entry.event === 'gather.timed-out').length, 0);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 1);
});

test('a deadline with required branches missing fails the spread, cancels siblings and emits nothing', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(hoverRequiredComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.admit('start', text('seed'));
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
  assert.equal(snapshot.nodes['ask']?.receptor.length, 0);
  assert.equal(calls.filter((call) => call.nodeId === 'done').length, 0, 'no gather emit');
  const join = joinOf(snapshot);
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.equal(join.completedAt, undefined);
  assert.deepEqual(join.arrived, []);
  assert.equal(log.entries.filter((entry) => entry.event === 'gather.timed-out').length, 1);
  const failure = log.entries.find((entry) => entry.event === 'gather.failed');
  assert.ok(failure !== undefined);
  assert.equal(failure.outcome, 'timed-out');
  assert.ok(log.entries.some((entry) => entry.event === 'hover.cancelled'));
});

test('a quiet field with no in-flight branch waits for the deadline instead of failing early', async () => {
  let clock = START;
  const log = createMemoryLog();
  const definition = directComposition();
  const deadline = START + TIMEOUT;
  const field = withGather(definition, {
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
  assert.equal(log.entries.filter((entry) => entry.event === 'gather.failed').length, 0);

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
  const field = withGather(
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
  assert.equal(log.entries.filter((entry) => entry.event === 'gather.timed-out').length, 0);
  const join = joinOf(runtime.snapshot());
  assert.ok(join?.completedAt !== undefined);
  assert.equal(join.timedOutAt, undefined);
  assert.equal(runtime.nextWakeAt(), undefined);
});

test('restore with an expired deadline times out immediately without emitting', () => {
  const log = createMemoryLog();
  const definition = directComposition();
  const field = withGather(definition, {
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
  assert.ok(log.entries.some((entry) => entry.event === 'gather.timed-out'));

  const exported = runtime.exportField();
  const persisted = Object.values(exported.nodes['gather']?.gathers ?? {})[0];
  assert.ok(persisted !== undefined);
  assert.ok(persisted.timedOutAt !== undefined);
  assert.equal(persisted.deadlineAt, undefined);
  assert.deepEqual(persisted.arrived, []);
});

test('a late required branch after a timeout is dropped without rejoining or a second emit', async () => {
  const log = createMemoryLog();
  const definition = directComposition();
  const spreadId = 'fk_late_required';
  const expired = withGather(
    definition,
    { arrived: [branchPheromone(spreadId, 'a')], deadlineAt: START - 1000 },
    [],
    spreadId,
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
  field.nodes['gather'] = {
    receptor: [branchPheromone(spreadId, 'b')],
    ...(field.nodes['gather']?.gathers === undefined
      ? {}
      : { gathers: field.nodes['gather']?.gathers }),
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
    (entry) => entry.event === 'gather.failed' && entry.outcome === 'late-required',
  );
  assert.ok(late !== undefined);
  assert.equal(late.spreadId, spreadId);
  assert.equal(runtime.snapshot().rest, true);
});

test('a late optional branch after a timeout is dropped without reopening the join', async () => {
  const log = createMemoryLog();
  const definition = optionalLateComposition();
  const spreadId = 'fk_late_optional';
  const expired = withGather(
    definition,
    { arrived: [branchPheromone(spreadId, 'a')], deadlineAt: START - 1000 },
    [],
    spreadId,
  );
  const { calls, executor } = recorder();

  const closed = PheromoneRuntime.restore(definition, expired, {
    executeForager: executor,
    now: () => START,
    onLog: log.sink,
  }).runtime;
  const field = closed.exportField();
  field.nodes['gather'] = {
    receptor: [branchPheromone(spreadId, 'b')],
    ...(field.nodes['gather']?.gathers === undefined
      ? {}
      : { gathers: field.nodes['gather']?.gathers }),
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
  const dropped = log.entries.find((entry) => entry.event === 'gather.optional-dropped');
  assert.ok(dropped !== undefined);
  assert.equal(dropped.spreadId, spreadId);
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

  runtime.admit('start', text('seed'));
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  const waitingGather = joinOf(waiting);
  assert.ok(waitingGather !== undefined);
  assert.deepEqual(
    waitingGather.arrived.map((pheromone) => pheromone.branchId),
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
  assert.ok(log.entries.some((entry) => entry.event === 'gather.timed-out'));
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

  runtime.admit('start', text('seed'));
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
  assert.equal(log.entries.filter((entry) => entry.event === 'gather.timed-out').length, 1);
  assert.equal(runtime.snapshot().rest, true);
});

test('a timed-out tombstone is not a Rest blocker or an active edit reference', () => {
  const definition = directComposition();
  const field = withGather(definition, {
    arrived: [],
    timedOutAt: new Date(START - 1000).toISOString(),
  });
  field.rest = true;

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  });

  assert.equal(runtime.snapshot().rest, true);
  assert.equal(runtime.nextWakeAt(), undefined);
});

test('timed-out tombstones share the completed 1h/64 cleanup bound on restore', () => {
  const definition = directComposition();
  const field = emptyField(definition);
  const gathers: Record<string, PersistedGatherState> = {};
  for (let index = 0; index < MAX_COMPLETED_GATHERS + 2; index += 1) {
    gathers[`fk_${String(index)}`] = {
      arrived: [],
      timedOutAt: new Date(START - index * 1000).toISOString(),
    };
  }
  field.nodes['gather'] = { receptor: [], gathers };
  field.rest = true;

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  });

  const restored = runtime.snapshot().nodes['gather']?.gathers ?? {};
  assert.equal(Object.keys(restored).length, MAX_COMPLETED_GATHERS);
  assert.equal(restored['fk_65'], undefined);
  assert.equal(restored['fk_64'], undefined);
  assert.ok(restored['fk_63'] !== undefined);

  // A marker older than the shared TTL is pruned as well.
  field.nodes['gather'] = {
    receptor: [],
    gathers: {
      fk_stale: {
        arrived: [],
        timedOutAt: new Date(START - COMPLETED_GATHER_TTL_MS - 1000).toISOString(),
      },
      fk_fresh: { arrived: [], timedOutAt: new Date(START).toISOString() },
    },
  };
  const second = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => START,
  }).runtime.snapshot().nodes['gather']?.gathers;
  assert.equal(second?.['fk_stale'], undefined);
  assert.ok(second?.['fk_fresh'] !== undefined);
});
