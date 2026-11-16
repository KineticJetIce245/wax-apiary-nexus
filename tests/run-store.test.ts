import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RunStore, RunStoreError, type RunRecord } from '../src/storage/run-store.js';

function runStore(): string {
  return mkdtempSync(join(tmpdir(), 'wax-m9d-runs-'));
}

function record(
  runId: string,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    requestId: `request-${runId}`,
    liveId: 'live',
    operation: 'trigger',
    status: 'completed',
    outputs: [{ nodeId: 'only', value: { kind: 'text', text: 'ok' } }],
    startedAt: `2026-11-15T12:00:0${runId.slice(-1)}.000Z`,
    finishedAt: `2026-11-15T12:00:0${runId.slice(-1)}.500Z`,
    ...overrides,
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test('save, get, list and latestForLive round-trip without temp files', () => {
  const root = runStore();
  const store = new RunStore(root);
  store.save(record('run-1'));
  store.save(record('run-2'));

  assert.deepEqual(store.get('run-2')?.outputs, [
    { nodeId: 'only', value: { kind: 'text', text: 'ok' } },
  ]);
  assert.equal(store.get('missing'), undefined);
  assert.equal(store.get('bad/id'), undefined);
  assert.equal(store.list().length, 2);
  assert.equal(store.latestForLive('live')?.runId, 'run-2');
  assert.equal(store.latestForLive('other'), undefined);

  const directory = join(root);
  const files = readdirSync(directory);
  assert.deepEqual(files.filter((name) => name.endsWith('.json')).sort(), [
    'run-1.json',
    'run-2.json',
  ]);
  assert.equal(files.some((name) => name.includes('.tmp-')), false);
  assert.equal(existsSync(join(directory, 'run-1.json')), true);
});

test('the retained-run limit removes oldest records first', async () => {
  const root = runStore();
  const store = new RunStore(root, { maxRuns: 2 });
  store.save(record('run-1'));
  await delay(20);
  store.save(record('run-2'));
  await delay(20);
  store.save(record('run-3'));

  assert.deepEqual(
    store.list().map((entry) => entry.runId),
    ['run-3', 'run-2'],
  );
  assert.equal(existsSync(join(root, 'run-1.json')), false);
});

test('a record over the byte limit is rejected and not written', () => {
  const root = runStore();
  const store = new RunStore(root, { maxRecordBytes: 200 });
  assert.throws(
    () =>
      store.save(
        record('big', {
          outputs: [{ nodeId: 'only', value: { kind: 'text', text: 'x'.repeat(500) } }],
        }),
      ),
    RunStoreError,
  );
  assert.equal(store.get('big'), undefined);
});

test('a malformed run file is ignored by list and get', () => {
  const root = runStore();
  writeFileSync(join(root, 'bad.json'), '{"not":"a run"}');
  const store = new RunStore(root);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('bad'), undefined);
});

test('invalid identifiers and record fields are rejected', () => {
  const root = runStore();
  const store = new RunStore(root);
  assert.throws(() => store.save(record('bad/id')), RunStoreError);
  assert.throws(
    () => store.save(record('run-1', { liveId: '' })),
    RunStoreError,
  );
  assert.throws(
    () => store.save(record('run-2', { startedAt: 'not-a-time' })),
    RunStoreError,
  );
});
