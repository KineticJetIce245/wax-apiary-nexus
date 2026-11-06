import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  QUEUE_RETRY_MS,
  QueueFullError,
  serializeValue,
  type NodeExecutor,
  type PersistedField,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-03-01T00:00:00.000Z');

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function forager(): unknown {
  return { kind: 'forager', config: { connection: 'codex', prompt: 'run {{input}}' } };
}

function user(): unknown {
  return { kind: 'user', config: { modality: 'text', prompt: 'Answer?' } };
}

function recorder(): { executor: NodeExecutor; calls: { nodeId: string; value: string }[] } {
  const calls: { nodeId: string; value: string }[] = [];
  return {
    calls,
    executor: {
      async execute(node, input) {
        calls.push({ nodeId: node.id, value: serializeValue(input) });
        return { kind: 'text', text: `out:${serializeValue(input)}` };
      },
    },
  };
}

function compose(
  id: string,
  queueMax: number,
  nodes: Record<string, unknown>,
  edges: unknown[] = [],
): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id,
    defaults: { queueMax },
    nodes,
    edges,
  });
}

// ---------------------------------------------------------------------------
// User hover
// ---------------------------------------------------------------------------

function hoverComposition(): ReturnType<typeof parseComposition> {
  return compose(
    'queue-hover',
    1,
    { ask: user(), sink: user(), done: forager() },
    [
      { id: 'e1', from: 'ask', to: 'sink' },
      { id: 'e2', from: 'sink', to: 'done' },
    ],
  );
}

test('a hover answer is refused before deletion when its target queue is full', async () => {
  let clock = START;
  const { executor } = recorder();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(hoverComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  // ask hovers first, then sink hovers with one input already queued.
  runtime.trigger('ask', text('question'));
  await runtime.pump();
  runtime.trigger('sink', text('seed'));
  await runtime.pump();
  runtime.trigger('sink', text('queued'));

  const askToken = runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(askToken !== undefined);

  assert.throws(
    () => runtime.answerHover('ask', text('reply'), askToken),
    (error: unknown) => {
      assert.ok(error instanceof QueueFullError);
      assert.equal(error.nodeId, 'sink');
      assert.equal(error.queueMax, 1);
      assert.equal(error.queueDepth, 1);
      return true;
    },
  );

  // The hover and its Pheromone are still there: nothing was consumed.
  const blockedSnapshot = runtime.snapshot();
  assert.equal(blockedSnapshot.nodes['ask']?.hover?.token, askToken);
  assert.equal(
    log.entries.some((entry) => entry.event === 'hover.resolved' && entry.nodeId === 'ask'),
    false,
  );
  const blocked = log.entries.find(
    (entry) => entry.event === 'hover.blocked' && entry.nodeId === 'ask',
  );
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome, 'answered:queue-max:sink');
  assert.equal(blocked.queueDepth, 1);
  const sinkQueue = blockedSnapshot.nodes['sink']?.queue ?? [];
  assert.equal(sinkQueue.length, 1);
  assert.equal(serializeValue(sinkQueue[0]?.value as Value), 'queued');

  // Free one slot: answer the sink's own hover, which drains its queue entry.
  const sinkToken = blockedSnapshot.nodes['sink']?.hover?.token;
  assert.ok(sinkToken !== undefined);
  runtime.answerHover('sink', text('sink-answer'), sinkToken);
  await runtime.pump();
  assert.equal(runtime.snapshot().nodes['sink']?.queue.length, 0);

  // Retry the preserved answer. It now reaches the target instead of vanishing.
  runtime.answerHover('ask', text('reply'), askToken);
  const sinkAfterRetry = runtime.snapshot().nodes['sink'];
  assert.ok(sinkAfterRetry !== undefined);
  assert.equal(sinkAfterRetry.queue.length, 1);
  assert.equal(serializeValue(sinkAfterRetry.queue[0]?.value as Value), 'reply');
  assert.ok(
    log.entries.some(
      (entry) =>
        entry.event === 'hover.resolved' &&
        entry.nodeId === 'ask' &&
        entry.outcome === 'answered',
    ),
    'the same answer retried later resolves the original hover',
  );
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergeComposition(): ReturnType<typeof parseComposition> {
  return compose(
    'queue-merge',
    1,
    {
      merge: {
        kind: 'merge',
        config: { required: ['a', 'b'], combine: 'text', timeoutMs: 600_000 },
      },
      sink: forager(),
    },
    [{ id: 'e1', from: 'merge', to: 'sink' }],
  );
}

function plainPheromone(id: string, value: string): Pheromone {
  return { id, traceId: `tr_${id}`, value: text(value), at: iso(START) };
}

function branchPheromone(forkId: string, branchId: string, value: string): Pheromone {
  return {
    id: `ph_${branchId}`,
    traceId: `tr_${branchId}`,
    forkId,
    branchId,
    lineage: [{ forkId, branchId }],
    value: text(value),
    at: iso(START),
  };
}

test('a complete merge join waits for downstream space without a tombstone or output loss', async () => {
  let clock = START;
  const definition = mergeComposition();
  const { executor, calls } = recorder();
  const log = createMemoryLog();
  const forkId = 'fk_restored';
  const field: PersistedField = {
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      merge: {
        queue: [],
        joins: {
          [forkId]: {
            arrived: [
              branchPheromone(forkId, 'a', 'A'),
              branchPheromone(forkId, 'b', 'B'),
            ],
            // Already past: a complete join must not time out or wake the
            // caller at 0ms just because its old deadline elapsed.
            deadlineAt: START - 1000,
          },
        },
      },
      sink: {
        queue: [plainPheromone('ph_queued', 'existing')],
        pending: plainPheromone('ph_pending', 'pending'),
        lastActivatedAt: iso(START),
      },
    },
  };

  const { runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  await runtime.pump();

  // The join is complete but its downstream queue is full: keep both.
  const blocked = runtime.snapshot();
  const join = Object.values(blocked.nodes['merge']?.joins ?? {})[0];
  assert.ok(join !== undefined);
  assert.equal(join.arrived.length, 2, 'the arrived branches are preserved');
  assert.equal(join.completedAt, undefined, 'no completed tombstone is written');
  assert.equal(join.timedOutAt, undefined);
  assert.equal(blocked.nodes['sink']?.queue.length, 1);
  assert.ok(blocked.nodes['sink']?.pending !== undefined);
  assert.equal(
    log.entries.some((entry) => entry.event === 'merge.completed'),
    false,
  );
  assert.equal(
    log.entries.filter(
      (entry) => entry.event === 'pheromone.emitted' && entry.nodeId === 'sink',
    ).length,
    0,
    'nothing is emitted while the target is full',
  );
  const mergeBlocked = log.entries.find(
    (entry) => entry.event === 'merge.blocked' && entry.nodeId === 'merge',
  );
  assert.ok(mergeBlocked !== undefined);
  assert.equal(mergeBlocked.outcome, 'queue-max:sink');
  assert.equal(mergeBlocked.queueDepth, 1);
  assert.equal(runtime.snapshot().rest, false);
  assert.equal(runtime.nextWakeAt(), START + QUEUE_RETRY_MS);
  assert.equal(log.entries.some((entry) => entry.event === 'node.failed'), false);

  // Drain the target; the restored complete join settles exactly once.
  clock += 1000;
  await runtime.pump();
  assert.ok(log.entries.some((entry) => entry.event === 'merge.completed'));
  const settled = runtime.snapshot();
  const settledJoin = Object.values(settled.nodes['merge']?.joins ?? {})[0];
  assert.ok(settledJoin !== undefined);
  assert.ok(settledJoin.completedAt !== undefined);
  assert.deepEqual(settledJoin.arrived, []);
  assert.equal(settled.nodes['sink']?.queue.length, 1);
  assert.equal(
    serializeValue(settled.nodes['sink']?.queue[0]?.value as Value),
    'A\nB',
    'the joined output is queued for the downstream node',
  );

  clock += 1000;
  await runtime.pump();
  clock += 1000;
  await runtime.pump();

  assert.deepEqual(calls, [
    { nodeId: 'sink', value: 'pending' },
    { nodeId: 'sink', value: 'existing' },
    { nodeId: 'sink', value: 'A\nB' },
  ]);
  assert.equal(
    calls.filter((call) => call.value === 'A\nB').length,
    1,
    'the merged output is delivered exactly once',
  );
  assert.equal(runtime.snapshot().rest, true);
});

// ---------------------------------------------------------------------------
// Condition and counter selection
// ---------------------------------------------------------------------------

function conditionTextComposition(): ReturnType<typeof parseComposition> {
  return compose(
    'queue-condition-text',
    1,
    {
      start: forager(),
      check: { kind: 'condition', config: { mode: 'text', contains: 'yes' } },
      yes: user(),
      no: user(),
    },
    [
      { id: 'e1', from: 'start', to: 'check' },
      { id: 'e2', from: 'check', to: 'yes', when: 'true' },
      { id: 'e3', from: 'check', to: 'no', when: 'false' },
    ],
  );
}

test('a text condition only preflights the branch it will take', async () => {
  let clock = START;
  const { executor } = recorder();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(conditionTextComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  // Fill the branch the condition will NOT take.
  runtime.trigger('no', text('held'));
  await runtime.pump();
  runtime.trigger('no', text('held-2'));

  runtime.trigger('start', text('yes please'));
  await runtime.pump();

  // The condition still ran and took the true edge despite the false queue.
  const yes = runtime.snapshot().nodes['yes'];
  assert.ok(yes !== undefined);
  assert.ok(yes.hover !== undefined);
  const no = runtime.snapshot().nodes['no'];
  assert.equal(no?.queue.length, 1, 'the unused branch queue is untouched');
  assert.ok(
    log.entries.some(
      (entry) =>
        entry.event === 'node.completed' &&
        entry.nodeId === 'check' &&
        entry.outcome === 'true',
    ),
  );
  assert.equal(
    log.entries.some(
      (entry) => entry.event === 'pheromone.blocked' && entry.nodeId === 'check',
    ),
    false,
  );
});

test('a text condition is paused when the branch it will take is full', async () => {
  let clock = START;
  const { executor } = recorder();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(conditionTextComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('yes', text('held'));
  await runtime.pump();
  runtime.trigger('yes', text('held-2'));

  runtime.trigger('start', text('yes please'));
  await runtime.pump();

  const check = runtime.snapshot().nodes['check'];
  assert.ok(check !== undefined);
  assert.ok(check.pending !== undefined, 'the condition input is preserved');
  assert.equal(serializeValue(check.pending.value), 'out:yes please');
  assert.equal(
    log.entries.some(
      (entry) => entry.event === 'node.completed' && entry.nodeId === 'check',
    ),
    false,
  );
  const blocked = log.entries.find(
    (entry) => entry.event === 'pheromone.blocked' && entry.nodeId === 'check',
  );
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome, 'queue-max:yes');

  // Free the selected branch and pump again: the condition now runs.
  const yesToken = runtime.snapshot().nodes['yes']?.hover?.token;
  assert.ok(yesToken !== undefined);
  runtime.answerHover('yes', text('free'), yesToken);
  clock += 1000;
  await runtime.pump();

  const after = runtime.snapshot();
  assert.ok(
    log.entries.some(
      (entry) =>
        entry.event === 'node.completed' &&
        entry.nodeId === 'check' &&
        entry.outcome === 'true',
    ),
  );
  assert.equal(after.nodes['check']?.pending, undefined);
  assert.equal(serializeValue(after.nodes['yes']?.queue[0]?.value as Value), 'out:yes please');
});

function counterComposition(): ReturnType<typeof parseComposition> {
  return compose(
    'queue-counter',
    1,
    {
      start: forager(),
      count: { kind: 'counter', config: { max: 2, step: 1 } },
      again: user(),
      end: user(),
    },
    [
      { id: 'e1', from: 'start', to: 'count' },
      { id: 'e2', from: 'count', to: 'again', when: 'continue' },
      { id: 'e3', from: 'count', to: 'end', when: 'done' },
    ],
  );
}

test('a counter only preflights the edge its count will select', async () => {
  let clock = START;
  const { executor } = recorder();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(counterComposition(), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('again', text('held'));
  await runtime.pump();
  runtime.trigger('again', text('held-2'));
  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const count = runtime.snapshot().nodes['count'];
  assert.ok(count !== undefined);
  assert.ok(count.pending !== undefined);
  assert.equal(count.state['count'], undefined, 'a blocked counter does not increment');
  const blocked = log.entries.find(
    (entry) => entry.event === 'pheromone.blocked' && entry.nodeId === 'count',
  );
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome, 'queue-max:again');

  const token = runtime.snapshot().nodes['again']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('again', text('free'), token);
  clock += 1000;
  await runtime.pump();

  assert.equal(runtime.snapshot().nodes['count']?.state['count'], 1);
  assert.equal(
    serializeValue(runtime.snapshot().nodes['again']?.queue[0]?.value as Value),
    'out:seed',
  );
});

function conditionWorkerComposition(): ReturnType<typeof parseComposition> {
  return compose(
    'queue-condition-worker',
    1,
    {
      start: forager(),
      check: {
        kind: 'condition',
        config: {
          mode: 'worker',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: '.',
          timeoutMs: 60_000,
        },
      },
      yes: user(),
      no: user(),
    },
    [
      { id: 'e1', from: 'start', to: 'check' },
      { id: 'e2', from: 'check', to: 'yes', when: 'true' },
      { id: 'e3', from: 'check', to: 'no', when: 'false' },
    ],
  );
}

test('a worker condition conservatively preflights both possible branches', async () => {
  let clock = START;
  const { executor } = recorder();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(conditionWorkerComposition(), {
    executeForager: executor,
    projectDirectory: process.cwd(),
    now: () => clock,
    onLog: log.sink,
  });

  // The worker would exit 0 (true), but the false target is full. The runtime
  // cannot know that before running, so it must wait for both targets.
  runtime.trigger('no', text('held'));
  await runtime.pump();
  runtime.trigger('no', text('held-2'));
  runtime.trigger('start', text('seed'));
  await runtime.pump();

  assert.equal(
    log.entries.some((entry) => entry.event === 'node.activated' && entry.nodeId === 'check'),
    false,
    'the worker condition did not run while one possible target was full',
  );
  const blocked = log.entries.find(
    (entry) => entry.event === 'pheromone.blocked' && entry.nodeId === 'check',
  );
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome, 'queue-max:no');

  const token = runtime.snapshot().nodes['no']?.hover?.token;
  assert.ok(token !== undefined);
  runtime.answerHover('no', text('free'), token);
  clock += 1000;
  await runtime.pump();

  assert.ok(
    log.entries.some(
      (entry) =>
        entry.event === 'node.completed' &&
        entry.nodeId === 'check' &&
        entry.outcome === 'true',
    ),
  );
  assert.ok(runtime.snapshot().nodes['yes']?.hover !== undefined);
});
