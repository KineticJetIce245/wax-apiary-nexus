import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HoneyStore, honeyPaths } from '../src/honey.js';
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

function forkMergeComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'fork-merge',
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
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

function optionalForkMergeComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'optional-fork-merge',
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
      merge: { kind: 'merge', config: { required: ['a'], optional: ['b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'merge', to: 'done' },
    ],
  });
}

function pheromone(id = 'ph_1'): Pheromone {
  return {
    id,
    traceId: `tr_${id}`,
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
  assert.equal(paths.log, join(paths.directory, 'log.jsonl'));
  assert.equal(paths.transcripts, join(paths.directory, 'honey', 'transcripts'));
});

test('ids that could escape the state root are rejected', () => {
  assert.throws(() => honeyPaths('C:/state', '../escape', 'comp'), /invalid apiary id/);
  assert.throws(() => honeyPaths('C:/state', 'apiary', 'a/b'), /invalid composition id/);
  assert.throws(() => honeyPaths('C:/state', '', 'comp'), /invalid apiary id/);
});

test('save then load returns the same field', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');
  const runtime = new PheromoneRuntime(askComposition(), { executeForager: executor(), now: () => START });

  runtime.trigger('start', { kind: 'text', text: 'one' });
  runtime.trigger('start', { kind: 'text', text: 'two' });
  const field = runtime.exportField();
  store.save(field);

  assert.deepEqual(store.load(), field);
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
    JSON.stringify({ schemaVersion: 1, compositionId: 'ask', graphRevision: 'rev', rest: true, nodes: { start: {} } }),
  );

  assert.throws(() => store.load(), /expected a node state/);
});

test('appendLog writes one metadata line per entry', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');
  const entries = [
    {
      at: new Date(START).toISOString(),
      event: 'node.completed' as const,
      compositionId: 'ask',
      graphRevision: 'rev',
      nodeId: 'start',
      outcome: 'ok',
    },
  ];

  store.appendLog(entries);

  const lines = readFileSync(store.paths.log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(parsed['event'], 'node.completed');
  assert.equal(parsed['nodeId'], 'start');
  assert.ok(!('prompt' in parsed));
  assert.ok(!('output' in parsed));
});

test('transcript paths stay inside the transcripts directory', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');

  assert.equal(
    store.transcriptPath('conv-1'),
    join(store.paths.transcripts, 'conv-1.jsonl'),
  );
  assert.throws(() => store.transcriptPath('../escape'), /invalid conversation id/);
});

test('restore keeps queue, pending and a user hover', async () => {
  const definition = askComposition();
  const first = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START });

  first.trigger('start', { kind: 'text', text: 'x' });
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
  field.nodes['start'] = { queue: [], active: pheromone('ph_crash') };

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
  field.nodes['check'] = { queue: [], active: pheromone('ph_check') };

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
    queue: [],
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
  field.nodes['start'] = { queue: [pheromone('ph_queue')], pending: pheromone('ph_pending') };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: executor(),
    now: () => START,
  });

  assert.deepEqual(report, { resumedHovers: [], unknownActive: [], stuckActive: [] });
  const start = runtime.snapshot().nodes['start'];
  assert.ok(start !== undefined);
  assert.equal(start.queue.length, 1);
  assert.equal(start.pending?.id, 'ph_pending');
  assert.equal(runtime.snapshot().rest, false);
});

test('restore keeps early user answers that arrived before any hover', async () => {
  const definition = askComposition();
  const calls: string[] = [];
  const runThrough: NodeExecutor = {
    async execute(node) {
      calls.push(node.id);
      return { kind: 'text', text: 'ok' };
    },
  };
  const first = new PheromoneRuntime(definition, { executeForager: runThrough, now: () => START });
  first.answerHover('ask', { kind: 'text', text: 'early' });

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');
  store.save(first.exportField());
  const loaded = store.load();
  assert.ok(loaded !== undefined);

  const { runtime } = PheromoneRuntime.restore(definition, loaded, {
    executeForager: runThrough,
    now: () => START,
  });
  runtime.trigger('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  assert.deepEqual(calls, ['start', 'done']);
  assert.equal(runtime.snapshot().nodes['ask']?.hover, undefined);
  assert.equal(runtime.snapshot().rest, true);
});

test('a guard hover cannot be resumed and is marked stuck', () => {
  const definition = askComposition();
  const field = new PheromoneRuntime(definition, { executeForager: executor(), now: () => START }).exportField();
  field.nodes['start'] = {
    queue: [],
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

test('transcripts keep bodies that the metadata log does not', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'ask');

  store.appendTranscript('conv-1', [
    { at: new Date(START).toISOString(), type: 'output', text: 'SECRET-BODY' },
  ]);
  store.appendLog([
    {
      at: new Date(START).toISOString(),
      event: 'node.completed',
      compositionId: 'ask',
      graphRevision: 'rev',
      transcriptRef: 'conv-1',
    },
  ]);

  const transcript = readFileSync(store.transcriptPath('conv-1'), 'utf8');
  const log = readFileSync(store.paths.log, 'utf8');
  assert.match(transcript, /SECRET-BODY/);
  assert.ok(!log.includes('SECRET-BODY'));
  assert.match(log, /transcriptRef/);
});

test('the log and transcripts rotate when they grow past the limit', () => {
  const root = tempRoot();
  const store = new HoneyStore(honeyPaths(root, 'apiary', 'ask'), {
    maxLogBytes: 160,
    maxTranscriptBytes: 160,
    keepSegments: 2,
  });
  const entry = {
    at: new Date(START).toISOString(),
    event: 'runtime.rest' as const,
    compositionId: 'ask',
    graphRevision: 'rev',
  };

  for (let index = 0; index < 6; index += 1) {
    store.appendLog([entry]);
    store.appendTranscript('conv-1', [{ at: new Date(START).toISOString(), type: 'output', text: 'x'.repeat(40) }]);
  }

  assert.ok(existsSync(`${store.paths.log}.1`));
  assert.ok(existsSync(`${store.transcriptPath('conv-1')}.1`));
  assert.ok(!existsSync(`${store.paths.log}.3`), 'only keepSegments segments are kept');
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
        { ...field, nodes: { ...field.nodes, ghost: { queue: [] } } },
        { executeForager: executor(), now: () => START },
      ),
    /unknown node 'ghost'/,
  );
});

test('honey persists and restores a pending merge join without replaying branches', async () => {
  let clock = START;
  const calls: string[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push(node.id);
      return input;
    },
  };
  const definition = forkMergeComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', { kind: 'text', text: 'seed' });
  await runtime.pump();

  const before = runtime.snapshot();
  assert.equal(before.rest, false);
  const joins = before.nodes['merge']?.joins ?? {};
  assert.equal(Object.keys(joins).length, 1);
  const token = before.nodes['ask']?.hover?.token;
  assert.ok(token !== undefined);
  assert.deepEqual(calls, ['start']);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'fork-merge');
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
  assert.equal(Object.keys(restoredSnapshot.nodes['merge']?.joins ?? {}).length, 1);
  assert.equal(restoredSnapshot.nodes['ask']?.hover?.token, token);

  restored.answerHover('ask', { kind: 'text', text: 'reply' }, token);
  clock += 1000;
  await restored.pump();

  assert.deepEqual(calls, ['start', 'done']);
  assert.equal(restored.snapshot().rest, true);
  // The completed join is kept as a persisted tombstone for late optional
  // branches, so it survives the round-trip instead of disappearing.
  const completedJoin = Object.values(restored.snapshot().nodes['merge']?.joins ?? {})[0];
  assert.ok(completedJoin !== undefined);
  assert.ok(completedJoin.completedAt !== undefined);
  assert.deepEqual(completedJoin.arrived, []);
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
  const definition = optionalForkMergeComposition();
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
  });

  runtime.trigger('start', { kind: 'text', text: 'seed' });
  await runtime.pump();
  assert.equal(calls.filter((nodeId) => nodeId === 'done').length, 1);
  const before = runtime.snapshot();
  assert.equal(before.rest, false, 'the optional branch still hovers');
  const beforeJoin = Object.values(before.nodes['merge']?.joins ?? {})[0];
  assert.ok(beforeJoin !== undefined);
  assert.ok(beforeJoin.completedAt !== undefined);
  assert.deepEqual(beforeJoin.arrived, []);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'optional-fork-merge');
  const field = runtime.exportField();
  store.save(field);
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  const persistedJoin = Object.values(loaded.nodes['merge']?.joins ?? {})[0];
  assert.ok(persistedJoin !== undefined);
  assert.equal(persistedJoin.completedAt, beforeJoin.completedAt);
  assert.deepEqual(persistedJoin.arrived, []);

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
  assert.ok(log.entries.some((entry) => entry.event === 'merge.optional-dropped'));
  const afterJoin = Object.values(restored.runtime.snapshot().nodes['merge']?.joins ?? {})[0];
  assert.ok(afterJoin !== undefined);
  assert.ok(afterJoin.completedAt !== undefined);
});
