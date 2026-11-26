import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HoneyStore, honeyPaths } from '../src/storage/honey.js';
import {
  createMemoryLog,
  ReceptorBlockTimeoutError,
  parseComposition,
  PheromoneRuntime,
  ReceptorFullError,
  serializeValue,
  type CompositionDefinition,
  type NodeExecutor,
  type PersistedField,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-03-01T00:00:00.000Z');

function text(value: string): Value {
  return { message: value };
}

function oneBeeComposition(id: string, queueMax: number): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      a: { kind: 'forager', config: { connection: 'codex', prompt: 'run {{message}}' } },
    },
    edges: [],
    defaults: { queueMax },
  });
}

interface GatedExecutor {
  readonly executor: NodeExecutor;
  readonly started: string[];
  readonly release: (key: string) => void;
}

/** Each activation records its input and stays pending until released. */
function gatedExecutor(): GatedExecutor {
  const started: string[] = [];
  const waiters = new Map<string, () => void>();
  return {
    started,
    executor: {
      execute(_node, input) {
        const key = serializeValue(input);
        started.push(key);
        return new Promise<Value>((resolve) => {
          waiters.set(key, () => {
            waiters.delete(key);
            resolve({ message: `done:${key}` });
          });
        });
      },
    },
    release(key: string): void {
      const release = waiters.get(key);
      assert.ok(release !== undefined, `input '${key}' was not started`);
      release();
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('reject policy throws a structured ReceptorFullError and logs limit/policy', async () => {
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(oneBeeComposition('mbx-reject', 1), {
    executeForager: { async execute() { return text('ok'); } },
    now: () => START,
    onLog: log.sink,
  });

  await runtime.admit('a', text('first'));
  await assert.rejects(
    runtime.admit('a', text('second')),
    (error: unknown) => {
      assert.ok(error instanceof ReceptorFullError);
      assert.equal(error.liveId, 'mbx-reject');
      assert.equal(error.beeId, 'a');
      assert.equal(error.nodeId, 'a');
      assert.equal(error.pending, 1);
      assert.equal(error.limit, 1);
      assert.equal(error.policy, 'reject');
      assert.equal(error.queueMax, 1);
      assert.equal(error.queueDepth, 1);
      return true;
    },
  );

  const rejected = log.entries.filter((entry) => entry.event === 'pheromone.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.nodeId, 'a');
  assert.equal(rejected[0]?.queueDepth, 1);
  assert.equal(rejected[0]?.limit, 1);
  assert.equal(rejected[0]?.policy, 'reject');
  assert.equal(rejected[0]?.outcome, 'queue-max');
});

test('a resting bee omits the receptor; an awake bee snapshots active plus queue', async () => {
  let clock = START;
  const gated = gatedExecutor();
  const runtime = new PheromoneRuntime(oneBeeComposition('mbx-snapshot', 4), {
    executeForager: gated.executor,
    now: () => clock,
  });

  await runtime.admit('a', text('first'));
  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 1, 'the first activation');
  await runtime.admit('a', text('second'));

  const field = runtime.exportField();
  const node = field.nodes['a'];
  assert.ok(node !== undefined);
  assert.equal(serializeValue(node.active?.value as Value), 'first');
  assert.equal(node.receptor?.length, 1);
  assert.equal(serializeValue(node.receptor?.[0]?.value as Value), 'second');
  assert.equal(field.rest, false);

  // Real Honey JSON on disk: the awake receptor survives a save/load cycle.
  const root = mkdtempSync(join(tmpdir(), 'wax-m18-receptor-'));
  const store = new HoneyStore(honeyPaths(root, 'apiary', 'mbx-snapshot'));
  store.save(field);
  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded, field);

  await assertRestoredReceptor(loaded);

  clock += 1_000;
  gated.release('first');
  await waitFor(() => gated.started.includes('second'), 'the second activation');
  gated.release('second');
  await pumping;
  assert.deepEqual(gated.started, ['first', 'second']);
  assert.equal(runtime.snapshot().rest, true);
  const restingField = runtime.exportField();
  assert.equal(Object.hasOwn(restingField.nodes['a'] ?? {}, 'receptor'), false);
});
test('block policy admits FIFO waiters without holding the field lock', async () => {
  let clock = START;
  const gated = gatedExecutor();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(oneBeeComposition('mbx-block-fifo', 1), {
    executeForager: gated.executor,
    now: () => clock,
    onLog: log.sink,
    receptorOverflowPolicy: 'block',
    receptorBlockTimeoutMs: 5_000,
  });

  await runtime.admit('a', text('first'));
  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 1, 'the first activation');
  await runtime.admit('a', text('second'));
  const third = runtime.admit('a', text('third'));
  const fourth = runtime.admit('a', text('fourth'));
  let fourthSettled = false;
  void fourth.then(() => {
    fourthSettled = true;
  });

  const blocked = log.entries.filter((entry) => entry.event === 'bee-receptor-blocked');
  assert.equal(blocked.length, 2, 'one blocked event per waiting admission');
  assert.equal(blocked[0]?.queueDepth, 1);
  assert.equal(blocked[0]?.limit, 1);
  assert.equal(blocked[0]?.policy, 'block');

  clock += 1_000;
  gated.release('first');
  await third;
  assert.equal(fourthSettled, false, 'the second waiter keeps its FIFO turn');

  await waitFor(() => gated.started.includes('second'), 'the second activation');
  clock += 1_000;
  gated.release('second');
  await fourth;
  await waitFor(() => gated.started.includes('third'), 'the third activation');
  clock += 1_000;
  gated.release('third');
  await waitFor(() => gated.started.includes('fourth'), 'the fourth activation');
  gated.release('fourth');
  await pumping;

  assert.deepEqual(gated.started, ['first', 'second', 'third', 'fourth']);
  assert.equal(runtime.snapshot().rest, true);
});

test('block timeout reports pending/limit/waitedMs and never enqueues the input', async () => {
  const gated = gatedExecutor();
  const log = createMemoryLog();
  const runtime = new PheromoneRuntime(oneBeeComposition('mbx-block-timeout', 1), {
    executeForager: gated.executor,
    now: () => Date.now(),
    onLog: log.sink,
    receptorOverflowPolicy: 'block',
    receptorBlockTimeoutMs: 25,
  });

  await runtime.admit('a', text('first'));
  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 1, 'the first activation');
  await runtime.admit('a', text('second'));

  await assert.rejects(
    runtime.admit('a', text('third')),
    (error: unknown) => {
      assert.ok(error instanceof ReceptorBlockTimeoutError);
      assert.equal(error.liveId, 'mbx-block-timeout');
      assert.equal(error.beeId, 'a');
      assert.equal(error.pending, 1);
      assert.equal(error.limit, 1);
      assert.equal(error.policy, 'block');
      assert.ok(error.waitedMs >= 0);
      return true;
    },
  );

  const blocked = log.entries.filter((entry) => entry.event === 'bee-receptor-blocked');
  assert.equal(blocked.length, 1);
  const timedOut = log.entries.filter(
    (entry) => entry.event === 'bee-receptor-block-timeout',
  );
  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0]?.queueDepth, 1);
  assert.equal(timedOut[0]?.limit, 1);
  assert.equal(timedOut[0]?.policy, 'block');
  assert.equal(typeof timedOut[0]?.waitedMs, 'number');
  const node = runtime.snapshot().nodes['a'];
  assert.equal(node?.receptor.length, 1, 'the timed-out input never entered the receptor');
  assert.equal(serializeValue(node?.receptor[0]?.value as Value), 'second');

  gated.release('first');
  await pumping;
  assert.deepEqual(gated.started, ['first'], 'the timed-out input is never retried');
  assert.equal(serializeValue(runtime.snapshot().nodes['a']?.pending?.value as Value), 'second');
  assert.equal(runtime.snapshot().nodes['a']?.receptor.length, 0);
});

test('block policy queues every later admission behind earlier waiters (no jump)', async () => {
  let clock = START;
  const gated = gatedExecutor();
  const runtime = new PheromoneRuntime(oneBeeComposition('mbx-block-sync', 1), {
    executeForager: gated.executor,
    now: () => clock,
    receptorOverflowPolicy: 'block',
    receptorBlockTimeoutMs: 5_000,
  });

  await runtime.admit('a', text('first'));
  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 1, 'the first activation');
  await runtime.admit('a', text('second'));
  const third = runtime.admit('a', text('third'));
  const jump = runtime.admit('a', text('jump'));
  let jumpSettled = false;
  void jump.then(() => {
    jumpSettled = true;
  });

  // The receptor is full: the later delivery waits behind the registered
  // waiters instead of overtaking them.
  assert.equal(jumpSettled, false);

  clock += 1_000;
  gated.release('first');
  await third;
  assert.equal(jumpSettled, false, 'the later waiter keeps its FIFO turn');
  await waitFor(() => gated.started.includes('second'), 'the second activation');
  clock += 1_000;
  gated.release('second');
  await waitFor(() => gated.started.includes('third'), 'the waiter activation');
  clock += 1_000;
  gated.release('third');
  await jump;
  await waitFor(() => gated.started.includes('jump'), 'the last activation');
  gated.release('jump');
  await pumping;
  assert.deepEqual(gated.started, ['first', 'second', 'third', 'jump']);
});

/** A restored receptor must survive without replaying the persisted active input. */
async function assertRestoredReceptor(field: PersistedField): Promise<void> {
  const calls: string[] = [];
  const restored = PheromoneRuntime.restore(oneBeeComposition('mbx-snapshot', 4), field, {
    executeForager: {
      async execute(_node, input) {
        calls.push(serializeValue(input));
        return text('restored');
      },
    },
    now: () => START + 60_000,
  });
  assert.deepEqual(restored.report, {
    resumedHovers: [],
    unknownActive: ['a'],
    stuckActive: [],
  });
  const node = restored.runtime.snapshot().nodes['a'];
  assert.equal(node?.active, undefined, 'active is never replayed');
  assert.equal(node?.receptor.length, 1, 'the receptor is restored');
  assert.equal(serializeValue(node?.receptor[0]?.value as Value), 'second');
  assert.equal(node?.state['needsAttention'], true);
  assert.deepEqual(calls, [], 'restore itself executes nothing');

  await restored.runtime.pump();
  assert.deepEqual(calls, ['second'], 'the restored receptor drains only queued input');
  assert.equal(restored.runtime.snapshot().rest, true);
}
