import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  FieldRestoreError,
  HoneyIncompatibleError,
  PheromoneRuntime,
  createMemoryLog,
  type CompositionDefinition,
  type GatherStateSnapshot,
  type PersistedField,
} from '../src/runtime/index.js';
import { HoneyStore } from '../src/storage/honey.js';
import {
  failureMessages,
  fastDefinition,
  recorder,
  runtimeOf,
} from './support/m19-runtime.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wax-m19-gather-'));
}

function writeField(store: HoneyStore, value: unknown): void {
  mkdirSync(dirname(store.paths.field), { recursive: true });
  writeFileSync(store.paths.field, JSON.stringify(value));
}

function assembleDefinition(id = 'gather-persist'): CompositionDefinition {
  return fastDefinition(id, {
    gather: {
      kind: 'gather',
      config: {
        strategy: 'assemble',
        groupBy: 'topic',
        types: {
          a: { match: { path: 'role', equals: 'a' }, count: 1, reads: ['message'] },
          b: { match: { path: 'role', equals: 'b' }, count: 1, reads: ['message'] },
        },
      },
    },
  });
}

function batchDefinition(id = 'gather-batch-persist'): CompositionDefinition {
  return fastDefinition(id, {
    gather: {
      kind: 'gather',
      config: {
        strategy: 'batch',
        batch: { signal: { path: 'secrete', equals: true } },
        types: {
          t: { match: { path: 'role', equals: 't' }, reads: ['message'] },
        },
      },
    },
  });
}

function fieldOf(definition: CompositionDefinition, node: Record<string, unknown>): PersistedField {
  return {
    schemaVersion: 2,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: { gather: node },
  };
}

function expectRestoreError(
  definition: CompositionDefinition,
  field: PersistedField,
  error: RegExp,
  label = 'restore',
): void {
  assert.throws(
    () =>
      PheromoneRuntime.restore(definition, field, {
        executeForager: recorder().executor,
        now: () => NOW,
      }),
    (thrown: unknown) => {
      assert.ok(thrown instanceof FieldRestoreError, label);
      assert.match(thrown.message, error, label);
      return true;
    },
  );
}

function expectMalformedGather(id: string, gather: unknown, error: RegExp): void {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', id);
  writeField(store, {
    schemaVersion: 2,
    compositionId: id,
    graphRevision: 'rev',
    rest: false,
    nodes: { gather: { gather } },
  });
  assert.throws(
    () => store.load(),
    (thrown: unknown) => {
      assert.ok(thrown instanceof HoneyIncompatibleError, id);
      assert.match(thrown.message, error, id);
      return true;
    },
  );
}

/** Opens one group and closes another on the same keyed gather. */
async function keyedState(definition: CompositionDefinition) {
  const log = createMemoryLog();
  const runtime = runtimeOf(definition, recorder().executor, { now: () => NOW, onLog: log.sink });
  await runtime.admit('gather', { role: 'a', topic: 'closed', message: 'a-closed' });
  await runtime.admit('gather', { role: 'b', topic: 'closed', message: 'b-closed' });
  await runtime.settle();
  await runtime.admit('gather', { role: 'a', topic: 'open', message: 'a-open' });
  await runtime.settle();
  return { runtime, log };
}

test('field.json v2 roundtrips an open assemble group and a closed tombstone', async () => {
  const definition = assembleDefinition();
  const { runtime } = await keyedState(definition);
  const saved = runtime.exportField();
  const savedGather = saved.nodes['gather']?.gather;
  assert.equal(savedGather?.strategy, 'assemble');
  assert.equal(savedGather?.groups.length, 1);
  assert.deepEqual(savedGather?.groups[0]?.entries, { a: ['a-open'], b: [] });
  assert.equal(savedGather?.tombstones.length, 1);
  assert.equal(savedGather?.tombstones[0]?.key, 'closed');
  assert.equal(JSON.stringify(saved).includes('lastOutput'), false);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'gather-persist');
  store.save(saved);
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded, saved);

  const log = createMemoryLog();
  const restored = PheromoneRuntime.restore(definition, loaded, {
    executeForager: recorder().executor,
    now: () => NOW,
    onLog: log.sink,
  });
  const snapshot = restored.runtime.snapshot();
  assert.equal(snapshot.rest, false);
  assert.deepEqual(snapshot.nodes['gather']?.gather, savedGather);

  // The restored open group continues waiting for its missing type.
  await restored.runtime.admit('gather', { role: 'b', topic: 'open', message: 'b-open' });
  await restored.runtime.settle();
  assert.deepEqual(restored.runtime.snapshot().nodes['gather']?.lastOutput, {
    a: ['a-open'],
    b: ['b-open'],
  });
  assert.equal(restored.runtime.snapshot().rest, true);

  // The restored tombstone still closes its key.
  await restored.runtime.admit('gather', { role: 'a', topic: 'closed', message: 'late' });
  await restored.runtime.settle();
  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /group 'closed' is closed/);
});

test('restore resumes accumulated batch queues and a later signal flushes them', async () => {
  const definition = batchDefinition();
  const runtime = runtimeOf(definition, recorder().executor, { now: () => NOW });
  await runtime.admit('gather', { role: 't', message: 'one' });
  await runtime.admit('gather', { role: 't', message: 'two' });
  await runtime.settle();
  const saved = runtime.exportField();
  assert.deepEqual(saved.nodes['gather']?.gather?.batch, { t: ['one', 'two'] });
  assert.equal(saved.rest, false);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'gather-batch-persist');
  store.save(saved);
  const loaded = store.load();
  assert.ok(loaded !== undefined);

  const restored = PheromoneRuntime.restore(definition, loaded, {
    executeForager: recorder().executor,
    now: () => NOW,
  });
  assert.equal(restored.runtime.snapshot().rest, false);
  assert.deepEqual(restored.runtime.snapshot().nodes['gather']?.gather?.batch, {
    t: ['one', 'two'],
  });

  await restored.runtime.admit('gather', { secrete: true });
  await restored.runtime.settle();
  assert.deepEqual(restored.runtime.snapshot().nodes['gather']?.lastOutput, {
    t: ['one', 'two'],
  });
  assert.equal(restored.runtime.snapshot().rest, true);
  assert.equal(restored.runtime.exportField().nodes['gather']?.gather, undefined);
});

test('restore prunes tombstones past retention but keeps a recent key closed', async () => {
  const definition = assembleDefinition('gather-prune');
  const old = new Date(NOW - 3_600_001).toISOString();
  const recent = new Date(NOW - 1_000).toISOString();
  const field = fieldOf(definition, {
    gather: {
      strategy: 'assemble',
      groups: [],
      tombstones: [
        { key: 'old', closedAt: old },
        { key: 'recent', closedAt: recent },
      ],
    },
  });

  const log = createMemoryLog();
  const restored = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    now: () => NOW,
    onLog: log.sink,
  });
  const tombstones = restored.runtime.snapshot().nodes['gather']?.gather?.tombstones ?? [];
  assert.deepEqual(tombstones.map((tombstone) => tombstone.key), ['recent']);

  await restored.runtime.admit('gather', { role: 'a', topic: 'old', message: 'a' });
  await restored.runtime.settle();
  assert.deepEqual(failureMessages(log.entries, 'gather'), []);
  assert.equal(restored.runtime.snapshot().nodes['gather']?.gather?.groups.length, 1);

  await restored.runtime.admit('gather', { role: 'a', topic: 'recent', message: 'late' });
  await restored.runtime.settle();
  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /group 'recent' is closed/);
});

test('restore fails closed when the saved gather state contradicts its config', () => {
  const definition = assembleDefinition('gather-contradiction');
  const cases: readonly { readonly label: string; readonly state: unknown; readonly error: RegExp }[] = [
    {
      label: 'unknown type',
      state: { strategy: 'assemble', groups: [{ entries: { x: ['v'] } }], tombstones: [] },
      error: /expected one queue per declared type/,
    },
    {
      label: 'strategy mismatch',
      state: { strategy: 'batch', groups: [], tombstones: [], batch: { a: [], b: [] } },
      error: /does not match its config/,
    },
    {
      label: 'complete group',
      state: {
        strategy: 'assemble',
        groups: [{ key: 'k', entries: { a: ['x'], b: ['y'] } }],
        tombstones: [],
      },
      error: /never persisted/,
    },
    {
      label: 'missing group key',
      state: { strategy: 'assemble', groups: [{ entries: { a: [], b: [] } }], tombstones: [] },
      error: /missing or duplicate group key/,
    },
    {
      label: 'type beyond count',
      state: {
        strategy: 'assemble',
        groups: [{ key: 'k', entries: { a: ['x', 'y'], b: [] } }],
        tombstones: [],
      },
      error: /2 entries exceed count 1/,
    },
  ];
  for (const entry of cases) {
    const field = fieldOf(definition, { gather: entry.state as GatherStateSnapshot });
    expectRestoreError(definition, field, entry.error, entry.label);
  }
});

test('restore fails closed when open groups exceed the per-type queue total', () => {
  const definition = fastDefinition('gather-restore-total', {
    gather: {
      kind: 'gather',
      config: {
        strategy: 'assemble',
        groupBy: 'topic',
        typeQueueMax: 1,
        types: {
          a: { match: { path: 'role', equals: 'a' }, count: 2, reads: ['message'] },
          b: { match: { path: 'role', equals: 'b' }, count: 1, reads: ['message'] },
        },
      },
    },
  });
  const field: PersistedField = {
    schemaVersion: 2,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      gather: {
        gather: {
          strategy: 'assemble',
          groups: [
            { key: 'k1', entries: { a: ['x'], b: [] } },
            { key: 'k2', entries: { a: ['y'], b: [] } },
          ],
          tombstones: [],
        },
      },
    },
  };
  expectRestoreError(definition, field, /across open groups, over typeQueueMax 1/);
});

test('restore fails closed for an active gather and for gather state on another kind', () => {
  const definition = assembleDefinition('gather-contradiction-kind');
  expectRestoreError(
    definition,
    fieldOf(definition, {
      active: { value: { role: 'a', topic: 'open', message: 'x' } },
    }),
    /never replayed/,
    'active gather',
  );

  const forager = fastDefinition('gather-non-gather', {
    start: { kind: 'forager', config: { connection: 'fake', prompt: 'p' } },
  });
  const nonGather: PersistedField = {
    schemaVersion: 2,
    compositionId: forager.id,
    graphRevision: forager.graphRevision,
    rest: false,
    nodes: { start: { gather: { strategy: 'assemble', groups: [], tombstones: [] } } },
  };
  expectRestoreError(forager, nonGather, /non-gather node/, 'gather on a forager');
});

test('field.json v2 rejects malformed gather state instead of dropping it', () => {
  expectMalformedGather(
    'gather-bad-extra',
    { strategy: 'assemble', groups: [], tombstones: [], extra: true },
    /unknown field 'extra'/,
  );
  expectMalformedGather(
    'gather-bad-strategy',
    { strategy: 'join', groups: [] },
    /expected 'assemble' or 'batch'/,
  );
  expectMalformedGather(
    'gather-bad-entries',
    { strategy: 'assemble', groups: [{ entries: { a: 'nope' } }] },
    /expected an entry array/,
  );
  expectMalformedGather(
    'gather-bad-tombstone',
    { strategy: 'assemble', groups: [], tombstones: [{ key: 'k', closedAt: 'not-a-time' }] },
    /ISO timestamp/,
  );
  expectMalformedGather(
    'gather-bad-batch',
    { strategy: 'batch' },
    /expected a type -> entry-array object/,
  );
  expectMalformedGather(
    'gather-bad-truncated',
    { strategy: 'assemble', groups: [] },
    /expected an array of tombstones/,
  );
});

test('snapshot exposes a frozen, independent gather view', async () => {
  const definition = assembleDefinition('gather-snapshot');
  const runtime = runtimeOf(definition, recorder().executor, { now: () => NOW });
  await runtime.admit('gather', { role: 'a', topic: 'open', message: 'a' });
  await runtime.settle();

  const snapshot = runtime.snapshot();
  const gather = snapshot.nodes['gather']?.gather;
  assert.ok(gather !== undefined);
  assert.equal(Object.isFrozen(gather), true);
  assert.equal(Object.isFrozen(gather.groups), true);
  assert.equal(Object.isFrozen(gather.groups[0]?.entries), true);

  await runtime.admit('gather', { role: 'b', topic: 'open', message: 'b' });
  await runtime.settle();
  assert.equal(gather.groups.length, 1);
  assert.equal(snapshot.rest, false);
  assert.equal(runtime.snapshot().nodes['gather']?.gather?.groups.length, 0);
  assert.equal(runtime.snapshot().rest, true);
});
