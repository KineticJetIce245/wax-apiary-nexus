import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  QueueFullError,
  serializeValue,
  type NodeExecutor,
  type PersistedField,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-08-01T00:00:00.000Z');
const TTL = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function forager(): unknown {
  return { kind: 'forager', config: { connection: 'codex', prompt: 'run {{input}}' } };
}

function compose(
  id: string,
  nodes: Record<string, unknown>,
  defaults: Record<string, number> = {},
  edges: unknown[] = [],
): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id,
    defaults: { queueTtlMs: TTL, ...defaults },
    nodes,
    edges,
  });
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

function persisted(id: string, value: string, at: number): Pheromone {
  return { id, traceId: `tr_${id}`, value: text(value), at: iso(at) };
}

test('pump drops an expired queue entry, logs pheromone.expired and leaves the field at Rest', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(compose('ttl-queue', { start: forager() }), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('stale'));
  const queued = runtime.snapshot().nodes['start']?.queue[0];
  assert.ok(queued !== undefined, 'the input is queued before the TTL');

  // Persistence is never rewritten by the TTL: only pump/restore clean.
  clock += TTL;
  assert.equal(runtime.exportField().nodes['start']?.queue.length, 1);

  await runtime.pump();

  assert.deepEqual(calls, [], 'an expired entry is never activated');
  const after = runtime.snapshot();
  assert.equal(after.nodes['start']?.queue.length, 0);
  assert.equal(after.nodes['start']?.pending, undefined);
  assert.equal(after.rest, true);

  const expired = log.entries.filter((entry) => entry.event === 'pheromone.expired');
  assert.equal(expired.length, 1);
  const entry = expired[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.nodeId, 'start');
  assert.equal(entry.nodeKind, 'forager');
  assert.equal(entry.pheromoneId, queued.id);
  assert.equal(entry.traceId, queued.traceId);
  assert.equal(entry.queueDepth, 0);
  assert.equal(entry.outcome, 'ttl');
  assert.equal(
    log.entries.some((candidate) => candidate.event === 'node.activated'),
    false,
  );
});

test('pump removes an expired pending entry instead of activating it', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(compose('ttl-pending', { start: forager() }), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('first'));
  await runtime.pump();
  runtime.trigger('start', text('second'));
  await runtime.pump();

  const waiting = runtime.snapshot().nodes['start']?.pending;
  assert.ok(waiting !== undefined, 'the second input waits in pending during minIntervalMs');
  assert.equal(serializeValue(waiting.value), 'second');
  assert.deepEqual(calls.map((call) => call.value), ['first']);

  clock += TTL;
  await runtime.pump();

  assert.deepEqual(
    calls.map((call) => call.value),
    ['first'],
    'the expired pending entry is never activated',
  );
  const after = runtime.snapshot();
  assert.equal(after.nodes['start']?.pending, undefined);
  assert.equal(after.rest, true);

  const expired = log.entries.filter((entry) => entry.event === 'pheromone.expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.pheromoneId, waiting.id);
  assert.equal(expired[0]?.nodeId, 'start');
  assert.equal(expired[0]?.nodeKind, 'forager');
  assert.equal(expired[0]?.outcome, 'ttl');
});

test('unexpired queue entries survive TTL cleanup and keep FIFO order', async () => {
  let clock = START;
  const log = createMemoryLog();
  const started: string[] = [];
  let release: ((value: Value) => void) | undefined;
  const executor: NodeExecutor = {
    execute(_node, input) {
      started.push(serializeValue(input));
      if (started.length === 1) {
        return new Promise<Value>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve<Value>({ kind: 'text', text: `out:${serializeValue(input)}` });
    },
  };
  const runtime = new PheromoneRuntime(compose('ttl-fifo', { start: forager() }), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('start', text('blocker'));
  const pumping = runtime.pump();
  await Promise.resolve();
  assert.ok(release !== undefined, 'the first activation is running');

  // Queue [old1, old2, fresh1, fresh2] while the first activation holds the node.
  runtime.trigger('start', text('old1'));
  clock += 5_000;
  runtime.trigger('start', text('old2'));
  clock += TTL; // START + 65s: old1/old2 are due, fresh* are brand new.
  runtime.trigger('start', text('fresh1'));
  runtime.trigger('start', text('fresh2'));

  const before = runtime.snapshot().nodes['start']?.queue ?? [];
  assert.deepEqual(
    before.map((pheromone) => serializeValue(pheromone.value)),
    ['old1', 'old2', 'fresh1', 'fresh2'],
  );

  release({ kind: 'text', text: 'blocker-done' });
  await pumping;

  assert.deepEqual(
    started,
    ['blocker', 'fresh1'],
    'the expired prefix is gone and the survivors keep their relative order',
  );
  const after = runtime.snapshot().nodes['start'];
  assert.ok(after?.pending !== undefined);
  assert.equal(serializeValue(after.pending.value), 'fresh2');

  const expired = log.entries.filter((entry) => entry.event === 'pheromone.expired');
  assert.deepEqual(
    expired.map((entry) => entry.pheromoneId),
    [before[0]?.id, before[1]?.id],
    'the two aged-out entries are logged in queue order, once each',
  );
  assert.equal(expired.every((entry) => entry.outcome === 'ttl'), true);
  assert.equal(expired.every((entry) => entry.nodeId === 'start'), true);
  assert.equal(expired[0]?.queueDepth, 2, 'the reported depth excludes the expired entries');

  clock += 1000;
  await runtime.pump();
  assert.deepEqual(started, ['blocker', 'fresh1', 'fresh2']);
  assert.equal(runtime.snapshot().rest, true);
});

test('restore drops queue entries older than queueTtlMs before returning', async () => {
  const clock = START + 61_000;
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const definition = compose('ttl-restore', { start: forager() });
  const field: PersistedField = {
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      start: {
        queue: [
          persisted('ph_old', 'old', START),
          persisted('ph_fresh', 'fresh', START + 30_000),
        ],
      },
    },
  };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  assert.deepEqual(report.resumedHovers, []);
  assert.deepEqual(
    runtime.snapshot().nodes['start']?.queue.map((pheromone) => serializeValue(pheromone.value)),
    ['fresh'],
    'only the entry that outlived the TTL is gone',
  );
  assert.equal(runtime.snapshot().rest, false);

  const expired = log.entries.filter((entry) => entry.event === 'pheromone.expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.pheromoneId, 'ph_old');
  assert.equal(expired[0]?.nodeId, 'start');
  assert.equal(expired[0]?.queueDepth, 1);
  assert.equal(expired[0]?.outcome, 'ttl');

  await runtime.pump();
  assert.deepEqual(calls.map((call) => call.value), ['fresh']);
  assert.equal(runtime.snapshot().rest, true);
});

test('expiry frees a queueMax slot so a later trigger is accepted', async () => {
  let clock = START;
  const { executor, calls } = recorder();
  const definition = compose('ttl-queue-max', { start: forager() }, { queueMax: 1 });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', text('stale'));
  assert.throws(() => runtime.trigger('start', text('rejected')), QueueFullError);

  clock += TTL;
  await runtime.pump();
  assert.equal(runtime.snapshot().nodes['start']?.queue.length, 0);
  assert.equal(runtime.snapshot().rest, true);

  runtime.trigger('start', text('fresh'));
  assert.equal(runtime.snapshot().nodes['start']?.queue.length, 1);

  await runtime.pump();
  assert.deepEqual(calls.map((call) => call.value), ['fresh']);
  assert.equal(runtime.snapshot().rest, true);
});

test('TTL cleanup never removes an open hover or its parked Pheromone', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor } = recorder();
  const definition = compose('ttl-hover', {
    ask: { kind: 'user', config: { modality: 'text', prompt: 'Answer?' } },
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  const id = runtime.trigger('ask', text('question'));
  await runtime.pump();

  const hovered = runtime.snapshot().nodes['ask']?.hover;
  assert.ok(hovered !== undefined);
  assert.equal(hovered.pheromoneId, id);

  clock += TTL * 2;
  await runtime.pump();

  const after = runtime.snapshot();
  assert.equal(after.nodes['ask']?.hover?.token, hovered.token, 'the hover survives the TTL');
  assert.equal(after.rest, false, 'a waiting hover still keeps the field out of Rest');
  assert.equal(
    log.entries.some((entry) => entry.event === 'pheromone.expired'),
    false,
    'the hovered Pheromone is never expired',
  );

  runtime.answerHover('ask', text('reply'), hovered.token);
  await runtime.pump();
  assert.equal(runtime.snapshot().nodes['ask']?.hover, undefined);
  assert.equal(runtime.snapshot().rest, true);
});
