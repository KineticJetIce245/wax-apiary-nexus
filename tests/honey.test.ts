import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  HoneyIncompatibleError,
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type NodeExecutor,
  type PersistedField,
} from '../src/runtime/index.js';
import { HoneyStore } from '../src/storage/honey.js';
import { text } from './support/m19-runtime.js';

const START = Date.parse('2026-11-26T12:00:00.000Z');

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wax-m19-honey-'));
}

/** Writes one field fixture, creating the contract directory first. */
function writeField(store: HoneyStore, value: unknown): void {
  mkdirSync(dirname(store.paths.field), { recursive: true });
  writeFileSync(store.paths.field, JSON.stringify(value));
}

function definition(id = 'honey-v2'): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    defaults: { minIntervalMs: 1_000, queueMax: 8, queueTtlMs: 60_000 },
    nodes: {
      start: { kind: 'forager', config: { connection: 'fake', prompt: 'p' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: '?' } },
    },
    edges: [{ id: 'start-ask', from: 'start', to: 'ask' }],
  });
}

const passthrough: NodeExecutor = {
  async execute(_node, input) {
    return input;
  },
};

test('field.json v2 roundtrips queue entries, pending and a user hover', async () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'honey-v2');
  const runtime = new PheromoneRuntime(definition(), {
    executeForager: passthrough,
    now: () => START,
  });
  await runtime.admit('start', { message: 'one', attachments: [] });
  await runtime.admit('start', { message: 'two' });
  await runtime.admit('start', { message: 'three' });
  // Stage the second entry into pending; the third stays queued.
  await runtime.pump();

  const saved = runtime.exportField();
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(Object.keys(saved).sort(), [
    'compositionId',
    'graphRevision',
    'nodes',
    'rest',
    'schemaVersion',
  ]);
  const node = saved.nodes['start'];
  assert.ok(node !== undefined);
  assert.deepEqual(Object.keys(node.receptor?.[0] ?? {}).sort(), ['enqueuedAt', 'value']);
  assert.equal(node.receptor?.[0]?.enqueuedAt, new Date(START).toISOString());
  assert.deepEqual(Object.keys(node.pending ?? {}), ['value']);

  store.save(saved);
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded, saved);
  assert.equal(JSON.stringify(loaded).includes('lastOutput'), false);
});

test('v2 saves and restores a user hover without a Pheromone id', async () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'honey-hover');
  const definitionWithUser = definition('honey-hover');
  const runtime = new PheromoneRuntime(definitionWithUser, {
    executeForager: { async execute() { return { message: 'reply' }; } },
    now: () => START,
  });
  await runtime.admit('start', text('go'));
  await runtime.pump();
  const hover = runtime.snapshot().nodes['ask']?.hover;
  assert.ok(hover !== undefined);
  store.save(runtime.exportField());

  const loaded = store.load();
  assert.ok(loaded !== undefined);
  const savedHover = loaded.nodes['ask']?.hover;
  assert.ok(savedHover !== undefined);
  assert.deepEqual(Object.keys(savedHover).sort(), [
    'compositionId',
    'kind',
    'nodeId',
    'token',
  ]);
  const restored = PheromoneRuntime.restore(definitionWithUser, loaded, {
    executeForager: passthrough,
    now: () => START,
  });
  assert.equal(restored.report.resumedHovers[0], 'ask');
  assert.ok(restored.runtime.snapshot().nodes['ask']?.hoverPheromone !== undefined);
});

test('the last output is memory-only and never written to Honey', async () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'honey-output');
  // A terminal bee keeps its reply only in the field-owned last output.
  const terminal = parseComposition({
    schemaVersion: 1,
    id: 'honey-output',
    nodes: { start: { kind: 'forager', config: { connection: 'fake', prompt: 'p' } } },
    edges: [],
  });
  const runtime = new PheromoneRuntime(terminal, {
    executeForager: { async execute() { return { message: 'SECRET-OUTPUT' }; } },
    now: () => START,
  });
  await runtime.admit('start', text('go'));
  await runtime.pump();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, { message: 'SECRET-OUTPUT' });

  const saved = runtime.exportField();
  store.save(saved);
  assert.equal(JSON.stringify(saved).includes('SECRET-OUTPUT'), false);

  const loaded = store.load();
  assert.ok(loaded !== undefined);
  const restored = PheromoneRuntime.restore(terminal, loaded, {
    executeForager: passthrough,
    now: () => START,
  });
  assert.equal(restored.runtime.snapshot().nodes['start']?.lastOutput, undefined);
});

test('a schemaVersion 1 field is rejected as incompatible', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'old-schema');
  writeField(store, {
    schemaVersion: 1,
    compositionId: 'old-schema',
    graphRevision: 'rev',
    rest: false,
    nodes: {},
  });
  assert.throws(() => store.load(), HoneyIncompatibleError);
  assert.throws(() => store.load(), /schemaVersion 1/);
});

test('a v2 field with the old Pheromone shape is rejected', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'old-pheromone');
  writeField(store, {
    schemaVersion: 2,
    compositionId: 'old-pheromone',
    graphRevision: 'rev',
    rest: false,
    nodes: {
      start: {
        receptor: [
          {
            id: 'ph_old',
            at: '2026-01-01T00:00:00.000Z',
            value: { kind: 'text', text: 'legacy' },
          },
        ],
      },
    },
  });
  assert.throws(() => store.load(), HoneyIncompatibleError);
  assert.throws(() => store.load(), /unknown field 'id'/);
});

test('a v2 field with lastOutput or unknown node state is rejected', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'old-output');
  writeField(store, {
    schemaVersion: 2,
    compositionId: 'old-output',
    graphRevision: 'rev',
    rest: false,
    nodes: { start: { lastOutput: { message: 'x' } } },
  });
  assert.throws(() => store.load(), HoneyIncompatibleError);
  assert.throws(() => store.load(), /unknown field 'lastOutput'/);
});

test('a malformed v2 pending Pheromone is rejected instead of silently dropped', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'bad-pending');
  writeField(store, {
    schemaVersion: 2,
    compositionId: 'bad-pending',
    graphRevision: 'rev',
    rest: false,
    nodes: { start: { pending: { value: { message: 'x' }, at: 'now' } } },
  });
  assert.throws(() => store.load(), HoneyIncompatibleError);
});

test('an exported field matches the persisted contract', () => {
  const runtime = new PheromoneRuntime(definition('contract'), {
    executeForager: passthrough,
    now: () => START,
  });
  const field: PersistedField = runtime.exportField();
  assert.equal(field.schemaVersion, 2);
  assert.equal(field.compositionId, 'contract');
  assert.equal(typeof field.graphRevision, 'string');
  assert.equal(field.rest, true);
  assert.deepEqual(field.nodes, { start: {}, ask: {} });
});
