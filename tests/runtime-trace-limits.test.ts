import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  readTraceLimitOptions,
  serializeValue,
  TraceLimitError,
  type CompositionDefinition,
  type NodeDefinition,
  type NodeExecutor,
  type RuntimeOptions,
  type RuntimeRunObserver,
  type TraceDeadlineTimer,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-11-25T00:00:00.000Z');

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function forager(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'fake', prompt } };
}

/** Parses a definition and removes the 1s pacing floor for deterministic pumps. */
function fastDefinition(
  id: string,
  nodes: Record<string, unknown>,
  edges: readonly Record<string, unknown>[] = [],
): CompositionDefinition {
  const parsed = parseComposition({ schemaVersion: 1, id, nodes, edges });
  const fastNodes = new Map<string, NodeDefinition>();
  for (const [nodeId, node] of parsed.nodes) {
    fastNodes.set(nodeId, { ...node, minIntervalMs: 0 });
  }
  return { ...parsed, nodes: fastNodes };
}

interface TraceRecord {
  activated: number;
  outputs: Value[];
  failures: unknown[];
  settled: number;
}

interface Fixture {
  readonly runtime: PheromoneRuntime;
  readonly recorded: ReturnType<typeof recordingObserver>;
  readonly log: ReturnType<typeof createMemoryLog>;
}

function recordingObserver(): {
  readonly observer: RuntimeRunObserver;
  readonly byTrace: Map<string, TraceRecord>;
} {
  const byTrace = new Map<string, TraceRecord>();
  const recordOf = (traceId: string): TraceRecord => {
    const existing = byTrace.get(traceId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: TraceRecord = { activated: 0, outputs: [], failures: [], settled: 0 };
    byTrace.set(traceId, fresh);
    return fresh;
  };
  return {
    byTrace,
    observer: {
      activated: (traceId) => {
        recordOf(traceId).activated += 1;
      },
      output: (traceId, _nodeId, value) => {
        recordOf(traceId).outputs.push(value);
      },
      failed: (traceId, error) => {
        recordOf(traceId).failures.push(error);
      },
      settled: (traceId) => {
        recordOf(traceId).settled += 1;
      },
    },
  };
}

function buildFixture(
  definition: CompositionDefinition,
  executor: NodeExecutor,
  options: Omit<RuntimeOptions, 'executeForager' | 'onRun' | 'onLog'> = {},
): Fixture {
  const recorded = recordingObserver();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    ...options,
    onRun: recorded.observer,
    onLog: log.sink,
  });
  return { runtime, recorded, log };
}

function traceOf(fixture: Fixture, traceId: string): TraceRecord {
  const trace = fixture.recorded.byTrace.get(traceId);
  assert.ok(trace !== undefined, `trace '${traceId}' was not observed`);
  return trace;
}

function cycleGraph(): CompositionDefinition {
  return fastDefinition(
    'trace-hop-independent',
    {
      a: forager('a {{input}}'),
      b: forager('b {{input}}'),
      other: forager('other {{input}}'),
    },
    [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'ba', from: 'b', to: 'a' },
    ],
  );
}

function foragerExecutor(): NodeExecutor {
  return {
    async execute(node) {
      return { kind: 'text', text: node.id };
    },
  };
}

function assertCycleCancelled(fixture: Fixture): void {
  const cycleNodes = fixture.log.entries
    .filter((entry) => entry.event === 'node.activated' && entry.traceId === 'tr_cycle')
    .map((entry) => entry.nodeId);
  assert.deepEqual(cycleNodes, ['a', 'b', 'a', 'b']);
  const trace = traceOf(fixture, 'tr_cycle');
  assert.equal(trace.activated, 4, 'exactly maxHopsPerTrace activations started');
  assert.equal(trace.failures.length, 1);
  const failure = trace.failures[0];
  assert.ok(failure instanceof TraceLimitError);
  assert.equal(failure.state, 'cancelled');
  assert.equal(failure.reason, 'trace-limit');
  assert.equal(failure.limit, 'hops');
  assert.equal(failure.max, 4);
  assert.equal(trace.outputs.length, 0);
  assert.ok(trace.settled >= 1);
  const cancelled = fixture.log.entries.find(
    (entry) => entry.event === 'trace.cancelled' && entry.traceId === 'tr_cycle',
  );
  assert.ok(cancelled !== undefined);
  assert.equal(cancelled.outcome, 'hops');
  assert.equal(cancelled.limit, 4);
}

function assertIndependentCompleted(fixture: Fixture): void {
  const trace = traceOf(fixture, 'tr_other');
  assert.equal(trace.failures.length, 0);
  assert.equal(trace.outputs.length, 1);
  assert.equal(serializeValue(trace.outputs[0] ?? text('')), 'other');
  assert.ok(trace.settled >= 1);
}

test('a hop-limited cycle is cancelled while an independent trace completes', async () => {
  const fixture = buildFixture(cycleGraph(), foragerExecutor(), {
    now: () => START,
    maxHopsPerTrace: 4,
  });
  await fixture.runtime.admit('a', text('cycle'), 'tr_cycle');
  await fixture.runtime.admit('other', text('indep'), 'tr_other');
  await fixture.runtime.pump();

  assertCycleCancelled(fixture);
  assertIndependentCompleted(fixture);
  const snapshot = fixture.runtime.snapshot();
  assert.equal(snapshot.rest, true);
  assert.deepEqual(snapshot.pheromones, []);
});

function forkMergeGraph(): CompositionDefinition {
  return fastDefinition(
    'trace-hop-fork-merge',
    {
      start: forager('start {{input}}'),
      fan: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'branch-a' },
            { id: 'b', to: 'branch-b' },
          ],
        },
      },
      'branch-a': forager('a {{input}}'),
      'branch-b': forager('b {{input}}'),
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    [
      { id: 'e1', from: 'start', to: 'fan' },
      { id: 'e2', from: 'branch-a', to: 'merge' },
      { id: 'e3', from: 'branch-b', to: 'merge' },
    ],
  );
}

test('fork/merge branches share one trace budget; a merge arrival is a hop', async () => {
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node) {
      calls.push(node.id);
      return { kind: 'text', text: node.id };
    },
  };
  const five = buildFixture(forkMergeGraph(), executor, {
    now: () => START,
    maxHopsPerTrace: 5,
  });
  await five.runtime.admit('start', text('seed'), 'tr_fork');
  await five.runtime.pump();

  assert.deepEqual(calls, ['start', 'branch-a', 'branch-b']);
  const limited = traceOf(five, 'tr_fork');
  assert.equal(
    limited.activated,
    5,
    'start + fork + both branches + the first merge arrival',
  );
  assert.equal(limited.outputs.length, 0, 'the second merge arrival was refused');
  const failure = limited.failures[0];
  assert.ok(failure instanceof TraceLimitError);
  assert.equal(failure.limit, 'hops');
  assert.equal(failure.max, 5);

  // The merge consumes one Pheromone per branch arrival, so completing the
  // two-branch join needs six activations; the branches did not reset the
  // budget to give the second arrival a free hop.
  const six = buildFixture(forkMergeGraph(), executor, {
    now: () => START,
    maxHopsPerTrace: 6,
  });
  await six.runtime.admit('start', text('seed'), 'tr_fork_six');
  await six.runtime.pump();
  const merged = traceOf(six, 'tr_fork_six');
  assert.equal(merged.activated, 6);
  assert.equal(merged.failures.length, 0);
  assert.equal(merged.outputs.length, 1, 'the merge emitted its combined output');
  assert.equal(six.runtime.snapshot().rest, true);
});

interface Gated {
  readonly executor: NodeExecutor;
  readonly started: Promise<void>;
  release(): void;
}

function gatedExecutor(): Gated {
  let release: (() => void) | undefined;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  return {
    started,
    release(): void {
      assert.ok(release !== undefined, 'the activation never started');
      release();
    },
    executor: {
      execute() {
        startedResolve?.();
        return new Promise<Value>((resolve) => {
          release = () => {
            resolve(text('late-output'));
          };
        });
      },
    },
  };
}

interface DeadlineHarness {
  readonly timer: TraceDeadlineTimer;
  readonly deadlines: (() => void)[];
}

function deadlineHarness(): DeadlineHarness {
  const deadlines: (() => void)[] = [];
  return {
    deadlines,
    timer: (callback) => {
      deadlines.push(callback);
      return () => undefined;
    },
  };
}

function fireDeadline(harness: DeadlineHarness): void {
  const fire = harness.deadlines[0];
  assert.ok(fire !== undefined, 'no trace deadline was scheduled');
  fire();
}

function assertActiveDurationCancelled(fixture: Fixture): void {
  const trace = traceOf(fixture, 'tr_slow');
  assert.equal(trace.failures.length, 1);
  const failure = trace.failures[0];
  assert.ok(failure instanceof TraceLimitError);
  assert.equal(failure.limit, 'duration');
  assert.equal(failure.max, 1_000);
  assert.equal(trace.outputs.length, 0);
  assert.ok(
    fixture.runtime.snapshot().nodes['only']?.active !== undefined,
    'the running activation is not force-killed',
  );
}

test('duration uses an injected clock/timer; an active execution emits nothing', async () => {
  let clock = START;
  const gated = gatedExecutor();
  const deadlines = deadlineHarness();
  const fixture = buildFixture(terminalDefinition(), gated.executor, {
    now: () => clock,
    maxDurationPerTraceMs: 1_000,
    traceDeadlineTimer: deadlines.timer,
  });
  await fixture.runtime.admit('only', text('slow'), 'tr_slow');
  const pumping = fixture.runtime.pump();
  await gated.started;
  assert.equal(deadlines.deadlines.length, 1, 'one deadline was scheduled at admission');

  clock += 1_000;
  fireDeadline(deadlines);
  assertActiveDurationCancelled(fixture);

  gated.release();
  await pumping;
  const trace = traceOf(fixture, 'tr_slow');
  assert.equal(trace.outputs.length, 0, 'the late output is suppressed');
  assert.ok(trace.settled >= 1);
  const snapshot = fixture.runtime.snapshot();
  assert.equal(snapshot.nodes['only']?.active, undefined);
  assert.equal(snapshot.rest, true);
  assert.deepEqual(snapshot.pheromones, []);
});

function terminalDefinition(): CompositionDefinition {
  return fastDefinition('trace-terminal', { only: forager('run {{input}}') });
}

test('duration cancellation resolves an open guard hover as cancelled', async () => {
  let clock = START;
  let requestedResolve: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    requestedResolve = resolve;
  });
  const decisions: string[] = [];
  const executor: NodeExecutor = {
    async execute(_node, _input, context) {
      assert.ok(context !== undefined);
      requestedResolve?.();
      const decision = await context.requestGuard({
        requestId: 'r1',
        executionId: 'e1',
        summary: 'approval',
        options: ['allow_once'],
      });
      decisions.push(decision);
      return text('late-guard-output');
    },
  };
  const deadlines = deadlineHarness();
  const fixture = buildFixture(terminalDefinition(), executor, {
    now: () => clock,
    maxDurationPerTraceMs: 1_000,
    traceDeadlineTimer: deadlines.timer,
    onGuard: () => new Promise<never>(() => undefined),
  });
  await fixture.runtime.admit('only', text('slow'), 'tr_guard');
  const pumping = fixture.runtime.pump();
  await requested;
  assert.equal(fixture.runtime.snapshot().nodes['only']?.hover?.kind, 'guard');

  clock += 1_000;
  fireDeadline(deadlines);
  await pumping;

  assert.deepEqual(decisions, ['cancelled']);
  const trace = traceOf(fixture, 'tr_guard');
  assert.equal(trace.failures.length, 1);
  assert.equal(trace.outputs.length, 0);
  const snapshot = fixture.runtime.snapshot();
  assert.equal(snapshot.nodes['only']?.hover, undefined);
  assert.equal(snapshot.rest, true);
});

function parkedGraph(): CompositionDefinition {
  return fastDefinition(
    'trace-duration-parked',
    {
      start: forager('start {{input}}'),
      fan: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'work-a' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      'work-a': forager('work {{input}}'),
      ask: { kind: 'user', config: { modality: 'text', prompt: 'answer?' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    [
      { id: 'e1', from: 'start', to: 'fan' },
      { id: 'e2', from: 'work-a', to: 'merge' },
      { id: 'e3', from: 'ask', to: 'merge' },
    ],
  );
}

function assertParked(fixture: Fixture): void {
  const parked = fixture.runtime.snapshot();
  assert.ok(parked.nodes['ask']?.hover !== undefined, 'the user branch is parked');
  const joins = parked.nodes['merge']?.joins;
  assert.ok(joins !== undefined && Object.keys(joins).length > 0, 'the merge join is waiting');
  assert.equal(parked.rest, false);
}

function assertParkedCancelled(fixture: Fixture): void {
  const trace = traceOf(fixture, 'tr_parked');
  assert.equal(trace.failures.length, 1);
  const failure = trace.failures[0];
  assert.ok(failure instanceof TraceLimitError);
  assert.equal(failure.limit, 'duration');
  assert.equal(trace.outputs.length, 0);
  const after = fixture.runtime.snapshot();
  assert.equal(after.nodes['ask']?.hover, undefined, 'the hover was cancelled');
  assert.equal(after.nodes['merge']?.joins, undefined, 'the incomplete join was dropped');
  assert.deepEqual(after.pheromones, []);
  assert.equal(after.rest, true);
}

test('duration starts at admission, and cancellation purges parked hovers and joins', async () => {
  let clock = START;
  const fixture = buildFixture(parkedGraph(), foragerExecutor(), {
    now: () => clock,
    maxDurationPerTraceMs: 1_000,
    // No timer: the pump entry is the scheduling point this test exercises.
    traceDeadlineTimer: () => () => undefined,
  });
  await fixture.runtime.admit('start', text('seed'), 'tr_parked');
  clock += 900;
  await fixture.runtime.pump();
  assertParked(fixture);

  // 100ms after the first activation, but 1000ms after admission: the trace
  // is over its duration budget and only that trace is cancelled.
  clock += 100;
  await fixture.runtime.pump();
  assertParkedCancelled(fixture);
});

test('trace limit options have the documented defaults and reject non-positive values', () => {
  assert.deepEqual(readTraceLimitOptions({}), {
    maxHopsPerTrace: 256,
    maxDurationPerTraceMs: 1_800_000,
  });
  assert.throws(
    () => readTraceLimitOptions({ maxHopsPerTrace: 0 }),
    /maxHopsPerTrace must be a positive integer/,
  );
  assert.throws(
    () => readTraceLimitOptions({ maxDurationPerTraceMs: 1.5 }),
    /maxDurationPerTraceMs must be a positive integer/,
  );
});
