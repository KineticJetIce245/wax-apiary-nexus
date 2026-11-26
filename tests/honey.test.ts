import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { HoneyStore, honeyPaths } from '../src/storage/honey.js';
import {
  createMemoryLog,
  FieldRestoreError,
  parseComposition,
  PheromoneRuntime,
  type NodeExecutor,
  type PersistedField,
  type Pheromone,
} from '../src/runtime/index.js';

const START = Date.parse('2026-02-01T00:00:00.000Z');

function executor(): NodeExecutor {
  return {
    async execute() {
      return { kind: 'text', text: 'ok' };
    },
  };
}

function askComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'ask',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'plan {{input}}' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Approve?' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'ask' },
      { id: 'e2', from: 'ask', to: 'done' },
    ],
  });
}

function conditionComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'branch',
    nodes: {
      check: { kind: 'condition', config: { mode: 'text', contains: 'go' } },
      yes: { kind: 'forager', config: { connection: 'codex', prompt: 'yes' } },
      no: { kind: 'forager', config: { connection: 'codex', prompt: 'no' } },
    },
    edges: [
      { id: 'e1', from: 'check', to: 'yes', when: 'true' },
      { id: 'e2', from: 'check', to: 'no', when: 'false' },
    ],
  });
}

function spreadGatherComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'spread-gather',
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
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

function optionalSpreadGatherComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-spread-gather',
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
      gather: { kind: 'gather', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'ask', to: 'gather' },
      { id: 'e3', from: 'gather', to: 'done' },
    ],
  });
}

function pheromone(id = 'ph_1'): Pheromone {
  return {
    id,
    value: { kind: 'text', text: 'x' },
    at: new Date(START).toISOString(),
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wax-honey-'));
}

test('honeyPaths follows the contract layout', () => {
  const paths = honeyPaths('C:/state', 'apiary-1', 'comp-1');

  assert.equal(
    paths.directory,
    join('C:/state', 'apiaries', 'apiary-1', 'compositions', 'comp-1'),
  );
  assert.equal(paths.field, join(paths.directory, 'honey', 'field.json'));
});

test('ids that could escape the state root are rejected', () => {
  assert.throws(() => honeyPaths('C:/state', '../escape', 'comp'), /invalid apiary id/);
  assert.throws(() => honeyPaths('C:/state', 'apiary', 'a/b'), /invalid composition id/);
  assert.throws(() => honeyPaths('C:/state', '', 'comp'), /invalid apiary id/);
});

test('save then load returns the same field', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');
  const runtime = new PheromoneRuntime(askComposition(), { executeForager: executor(), now: () => START });

  runtime.admit('start', { kind: 'text', text: 'one' });
  runtime.admit('start', { kind: 'text', text: 'two' });
  const field = runtime.exportField();
  store.save(field);

  assert.deepEqual(store.load(), field);
});

test('save leaves no temporary field file behind', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');
  const runtime = new PheromoneRuntime(askComposition(), { executeForager: executor(), now: () => START });

  runtime.admit('start', { kind: 'text', text: 'one' });
  store.save(runtime.exportField());

  assert.deepEqual(
    readdirSync(dirname(store.paths.field)).filter((entry) => entry.includes('.tmp-')),
    [],
  );
});

test('load returns undefined for a missing field and rejects broken JSON', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');
  assert.equal(store.load(), undefined);

  store.save({
    schemaVersion: 1,
    compositionId: 'ask',
    graphRevision: 'rev',
    rest: true,
    nodes: {},
  });
  writeFileSync(store.paths.field, '{ not json');

  assert.throws(() => store.load(), /not valid JSON/);
});

test('a loaded field with a bad node shape is rejected', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');
  store.save({
    schemaVersion: 1,
    compositionId: 'ask',
    graphRevision: 'rev',
    rest: true,
    nodes: {},
  });
  writeFileSync(
    store.paths.field,
    JSON.stringify({ schemaVersion: 1, compositionId: 'ask', graphRevision: 'rev', rest: true, nodes: { start: { receptor: 'not-an-array' } } }),
  );

  assert.throws(() => store.load(), /receptor: expected an array/);
});

test('restore keeps queue, pending and a user hover', async () => {
  const definition = askComposition();
  const first = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START });

  await first.admit('start', { kind: 'text', text: 'x' });
  await first.pump();
  const hoverToken = first.snapshot().nodes['ask']?.hover?.token;
  assert.ok(hoverToken !== undefined);

  const field = first.exportField();
  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor(),
    now: () => START,
  });

  assert.deepEqual(report, { resumedHovers: ['ask'], unknownActive: [], stuckActive: [] });
  assert.equal(runtime.snapshot().nodes['ask']?.hover?.token, hoverToken);
  assert.equal(runtime.snapshot().rest, false);

  runtime.answerHover('ask', { kind: 'text', text: 'yes' }, hoverToken);
  await runtime.pump();
  assert.equal(runtime.snapshot().rest, true);
});

test('an active forager after a crash becomes unknown and is never replayed', () => {
  const definition = askComposition();
  const field = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START }).exportField();
  field.nodes['start'] = { receptor: [], active: pheromone('ph_crash') };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor(),
    now: () => START,
  });

  assert.deepEqual(report.unknownActive, ['start']);
  assert.deepEqual(report.stuckActive, []);
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.active, undefined);
  assert.equal(start.state['needsAttention'], true);
  assert.equal(start.state['lastOutcome'], 'unknown');
  assert.deepEqual(runtime.snapshot().pheromones, []);
});

test('an active control node becomes stuck instead of unknown', () => {
  const definition = conditionComposition();
  const field = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START }).exportField();
  field.nodes['check'] = { receptor: [], active: pheromone('ph_check') };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor(),
    now: () => START,
  });

  assert.deepEqual(report.stuckActive, ['check']);
  assert.equal(runtime.snapshot().nodes['check']?.state['needsAttention'], true);
});

test('a hover without its Pheromone is treated as stuck', () => {
  const definition = askComposition();
  const field = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START }).exportField();
  field.nodes['ask'] = {
    receptor: [],
    hover: {
      token: 'hv_x',
      kind: 'user',
      compositionId: 'ask',
      nodeId: 'ask',
      pheromoneId: 'ph_missing',
    },
  };

  const { report, runtime } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor(),
    now: () => START,
  });

  assert.deepEqual(report.stuckActive, ['ask']);
  assert.equal(runtime.snapshot().nodes['ask']?.hover, undefined);
  assert.equal(runtime.snapshot().nodes['ask']?.state['needsAttention'], true);
});

test('restore keeps a pending slot and a queue', () => {
  const definition = askComposition();
  const field = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START }).exportField();
  field.nodes['start'] = { receptor: [pheromone('ph_queue')], pending: pheromone('ph_pending') };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor(),
    now: () => START,
  });

  assert.deepEqual(report, { resumedHovers: [], unknownActive: [], stuckActive: [] });
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.receptor.length, 1);
  assert.equal(start.pending?.id, 'ph_pending');
  assert.equal(runtime.snapshot().rest, false);
});

test('an answer without an open hover is rejected and is not persisted', () => {
  const runtime = new PheromoneRuntime(askComposition(), {
    executeForager: executor(),
    now: () => START,
  });

  assert.throws(
    () => runtime.answerHover('ask', { kind: 'text', text: 'early' }),
    /has no open hover/,
  );
  const field = runtime.exportField();
  assert.deepEqual(field.nodes['ask'] ?? {}, {});
});

test('a bee last output is a memory-only field cache, never persisted', async () => {
  const definition = askComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor(),
    now: () => START,
  });

  await runtime.admit('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.nodes['start']?.lastOutput, {
    kind: 'text',
    text: 'ok',
  });
  const field = runtime.exportField();
  assert.equal(
    (field.nodes['start'] as { lastOutput?: unknown } | undefined)?.lastOutput,
    undefined,
  );
  assert.equal(JSON.stringify(field).includes('lastOutput'), false);
});

test('a guard hover cannot be resumed and is marked stuck', () => {
  const definition = askComposition();
  const field = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START }).exportField();
  field.nodes['start'] = {
    receptor: [],
    active: pheromone('ph_active'),
    hover: {
      token: 'gd_1',
      kind: 'guard',
      compositionId: 'ask',
      nodeId: 'start',
      pheromoneId: 'ph_active',
      meta: { requestId: 'r1', executionId: 'e1' },
    },
  };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor(),
    now: () => START,
  });

  assert.deepEqual(report.resumedHovers, []);
  assert.ok(report.stuckActive.includes('start'));
  assert.ok(report.unknownActive.includes('start'));
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.hover, undefined);
  assert.equal(start.state['needsAttention'], true);
});

test('restore refuses a different graph revision or an unknown node', () => {
  const definition = askComposition();
  const field = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START }).exportField();

  assert.throws(
    () =>
      PheromoneRuntime.restore(
        definition,
        { ...field, graphRevision: 'other' },
        { executeForager: executor(), now: () => START },
      ),
    FieldRestoreError,
  );

  assert.throws(
    () =>
      PheromoneRuntime.restore(
        definition,
        { ...field, nodes: { ...field.nodes, ghost: { receptor: [] } } },
        { executeForager: executor(), now: () => START },
      ),
    /unknown node 'ghost'/,
  );
});

test('honey persists and restores a pending gather join without replaying branches', async () => {
  let clock = START;
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push(node.id);
      return input;
    },
  };
  const definition = spreadGatherComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.admit('start', { kind: 'text', text: 'seed' });
  await runtime.pump();

  const before = runtime.snapshot();
  assert.equal(before.rest, false);
  const gathers = before.nodes['gather']?.gathers ?? {};
  assert.equal(Object.keys(gathers).length, 1);
  const token = before.nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  assert.deepEqual(calls, ['start']);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'spread-gather');
  const field = runtime.exportField();
  store.save(field);
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded, field);

  const { runtime: restored, report } = PheromoneRuntime.restore(definition, loaded, {
    executeForager: executor,
    now: () => clock,
  });

  assert.deepEqual(report, { resumedHovers: ['ask'], unknownActive: [], stuckActive: [] });
  assert.deepEqual(calls, ['start'], 'restoring a join does not replay the arrived branches');
  const restoredSnapshot = restored.snapshot();
  assert.equal(restoredSnapshot.rest, false);
  assert.equal(Object.keys(restoredSnapshot.nodes['gather']?.gathers ?? {}).length, 1);
  assert.equal(restoredSnapshot.nodes['ask']?.hover?.token, token);

  restored.answerHover('ask', { kind: 'text', text: 'reply' }, token);
  clock += 1000;
  await restored.pump();

  assert.deepEqual(calls, ['start', 'done']);
  assert.equal(restored.snapshot().rest, true);
  // The completed join is kept as a persisted tombstone for late optional
  // branches, so it survives the round-trip instead of disappearing.
  const completedGather = Object.values(restored.snapshot().nodes['gather']?.gathers ?? {})[0];
  assert.ok(completedGather !== undefined);
  assert.ok(completedGather.completedAt !== undefined);
  assert.deepEqual(completedGather.arrived, []);
});

test('honey persists a completed join and drops a late optional after restart', async () => {
  let clock = START;
  const log = createMemoryLog();
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push(node.id);
      return input;
    },
  };
  const definition = optionalSpreadGatherComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.admit('start', { kind: 'text', text: 'seed' });
  await runtime.pump();
  assert.equal(calls.filter((nodeId) => nodeId === 'done').length, 1);
  const before = runtime.snapshot();
  assert.equal(before.rest, false, 'the optional branch still hovers');
  const beforeGather = Object.values(before.nodes['gather']?.gathers ?? {})[0];
  assert.ok(beforeGather !== undefined);
  assert.ok(beforeGather.completedAt !== undefined);
  assert.deepEqual(beforeGather.arrived, []);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'optional-spread-gather');
  const field = runtime.exportField();
  store.save(field);
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  const persistedGather = Object.values(loaded.nodes['gather']?.gathers ?? {})[0];
  assert.ok(persistedGather !== undefined);
  assert.equal(persistedGather.completedAt, beforeGather.completedAt);
  assert.deepEqual(persistedGather.arrived, []);

  const restored = PheromoneRuntime.restore(definition, loaded, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });
  const token = restored.runtime.snapshot().nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  restored.runtime.answerHover('ask', { kind: 'text', text: 'late' }, token);
  clock += 1000;
  await restored.runtime.pump();

  assert.equal(
    calls.filter((nodeId) => nodeId === 'done').length,
    1,
    'the restored completed join never emits a second time',
  );
  assert.equal(restored.runtime.snapshot().rest, true);
  assert.ok(log.entries.some((entry) => entry.event === 'gather.optional-dropped'));
  const afterGather = Object.values(restored.runtime.snapshot().nodes['gather']?.gathers ?? {})[0];
  assert.ok(afterGather !== undefined);
  assert.ok(afterGather.completedAt !== undefined);
});

test('a resting node may omit the mailbox key', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'rest');
  store.save({
    schemaVersion: 1,
    compositionId: 'rest',
    graphRevision: 'rev',
    rest: true,
    nodes: {},
  });
  writeFileSync(
    store.paths.field,
    JSON.stringify({
      schemaVersion: 1,
      compositionId: 'rest',
      graphRevision: 'rev',
      rest: true,
      nodes: { start: {} },
    }),
  );

  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded.nodes['start'], {});
});
