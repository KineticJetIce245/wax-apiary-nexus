import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type NodeExecutor,
  type PersistedField,
} from '../src/runtime/index.js';
import { text } from './support/m19-runtime.js';

const START = Date.parse('2026-07-01T00:00:00.000Z');
const TTL = 1_000;

function definition(id = 'ttl', minIntervalMs = 1_000): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    defaults: { minIntervalMs, queueMax: 8, queueTtlMs: TTL },
    nodes: {
      start: { kind: 'forager', config: { connection: 'fake', prompt: 'p' } },
    },
    edges: [],
  });
}

const executor: NodeExecutor = {
  async execute(_node, input) {
    return input;
  },
};

function runtimeAt(clock: () => number, log = createMemoryLog()): PheromoneRuntime {
  return new PheromoneRuntime(definition(), {
    executeForager: executor,
    now: clock,
    onLog: log.sink,
  });
}

test('queueTtlMs is measured from the queue entry enqueuedAt', async () => {
  let clock = START;
  const log = createMemoryLog();
  const runtime = runtimeAt(() => clock, log);
  // Warm the pacing clock so the next input waits in pending.
  await runtime.admit('start', text('warm'));
  await runtime.settle();
  await runtime.admit('start', text('one'));
  await runtime.settle();

  clock = START + TTL - 1;
  await runtime.settle();
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['start']?.receptor.length, 0);
  assert.ok(snapshot.nodes['start']?.pending !== undefined, 'a pending entry is not a queue wait');
  assert.equal(log.entries.some((entry) => entry.event === 'pheromone.expired'), false);
});

/** One user Bee keeps its receptor queued behind an open hover. */
function hoverDefinition(id: string): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    defaults: { minIntervalMs: 1_000, queueMax: 8, queueTtlMs: TTL },
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: '?' } },
    },
    edges: [],
  });
}

test('an entry older than the TTL is dropped and logged with enqueuedAt', async () => {
  let clock = START;
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(hoverDefinition('ttl-expire'), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });
  await runtime.admit('ask', text('open'));
  await runtime.settle();
  await runtime.admit('ask', text('old'));
  await runtime.settle();
  assert.equal(runtime.snapshot().nodes['ask']?.receptor.length, 1);

  clock = START + TTL;
  await runtime.settle();

  const expired = log.entries.find((entry) => entry.event === 'pheromone.expired');
  assert.ok(expired !== undefined);
  assert.equal(expired.enqueuedAt, new Date(START).toISOString());
  assert.equal(expired.queueDepth, 0);
  assert.equal('pheromoneId' in expired, false);
  assert.equal(runtime.snapshot().nodes['ask']?.receptor.length, 0);
  assert.equal(runtime.snapshot().nodes['ask']?.hover?.kind, 'user');
});

test('TTL cleanup keeps FIFO order for the surviving entries', async () => {
  let clock = START;
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(hoverDefinition('ttl-fifo'), {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });
  await runtime.admit('ask', text('open'));
  await runtime.settle();
  await runtime.admit('ask', text('old'));
  clock = START + 500;
  await runtime.admit('ask', text('new'));
  await runtime.settle();
  assert.deepEqual(
    runtime.snapshot().nodes['ask']?.receptor.map((entry) => entry.value),
    [{ message: 'old' }, { message: 'new' }],
  );

  clock = START + TTL;
  await runtime.settle();

  const receptor = runtime.snapshot().nodes['ask']?.receptor ?? [];
  assert.deepEqual(receptor.map((entry) => entry.value), [{ message: 'new' }]);
  assert.ok(log.entries.some((entry) => entry.event === 'pheromone.expired'));
});

test('pending and active are never expired: only receptor entries have a clock', async () => {
  let clock = START;
  const runtime = new PheromoneRuntime(definition('ttl-pending', 5_000), {
    executeForager: executor,
    now: () => clock,
  });
  await runtime.admit('start', text('warm'));
  await runtime.settle();
  await runtime.admit('start', text('parked'));
  await runtime.settle();
  assert.ok(runtime.snapshot().nodes['start']?.pending !== undefined);

  clock = START + 4_000;
  await runtime.settle();
  // The pacing slot still holds the value; the TTL applies to receptor waits.
  assert.equal(runtime.snapshot().rest, false);
});

test('restore ages out an entry that outlived the TTL while the process was down', async () => {
  const definitionWithStart = definition('ttl-restore');
  const field: PersistedField = {
    schemaVersion: 2,
    compositionId: definitionWithStart.id,
    graphRevision: definitionWithStart.graphRevision,
    rest: false,
    nodes: {
      start: {
        receptor: [
          { value: { message: 'stale' }, enqueuedAt: new Date(START).toISOString() },
        ],
      },
    },
  };
  const log = createMemoryLog();
  const { runtime } = PheromoneRuntime.restore(definitionWithStart, field, {
    executeForager: executor,
    now: () => START + TTL,
    onLog: log.sink,
  });
  assert.equal(runtime.snapshot().nodes['start']?.receptor.length, 0);
  assert.ok(log.entries.some((entry) => entry.event === 'pheromone.expired'));
});

test('a queue entry with an unparseable enqueuedAt is never expired', async () => {
  const definitionWithStart = definition('ttl-bad-clock');
  const field: PersistedField = {
    schemaVersion: 2,
    compositionId: definitionWithStart.id,
    graphRevision: definitionWithStart.graphRevision,
    rest: false,
    nodes: {
      start: { receptor: [{ value: { message: 'x' }, enqueuedAt: 'not-a-date' }] },
    },
  };
  const { runtime } = PheromoneRuntime.restore(definitionWithStart, field, {
    executeForager: executor,
    now: () => START + TTL * 10,
  });
  assert.equal(runtime.snapshot().nodes['start']?.receptor.length, 1);
});
