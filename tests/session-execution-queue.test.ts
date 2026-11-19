import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  SessionExecutionQueue,
  SessionQueueDisposedError,
  SessionQueueFullError,
  isQueuedRun,
  type SessionQueueMeta,
  type SessionQueueTimers,
} from '../src/daemon/session-execution-queue.js';

function meta(liveId: string, beeId = 'only'): SessionQueueMeta {
  return { liveId, beeId };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    settle = resolvePromise;
  });
  return {
    promise,
    resolve: (value: T) => {
      settle?.(value);
    },
  };
}

/** Deterministic timer seam: nothing fires until the test says so. */
class FakeTimers implements SessionQueueTimers {
  private nextHandle = 1;
  private readonly pending = new Map<number, () => void>();

  get size(): number {
    return this.pending.size;
  }

  setTimeout(callback: () => void): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.pending.delete(handle);
    }
  }

  fireAll(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await delay(2);
  }
}

test('an idle session runs the job immediately and returns its result', async () => {
  const queue = new SessionExecutionQueue();
  const order: string[] = [];

  const result = await queue.start('session-1', meta('live-a'), async () => {
    order.push('a');
    return { runId: 'run-a' };
  });

  assert.equal(isQueuedRun(result), false);
  assert.deepEqual(result, { runId: 'run-a' });
  assert.deepEqual(order, ['a']);
});

test('a busy session queues FIFO and reports positions while waiting', async () => {
  const queue = new SessionExecutionQueue();
  const gate = deferred<{ readonly runId: string }>();
  const order: string[] = [];

  const first = queue.start('session-1', meta('live-a'), () => {
    order.push('a');
    return gate.promise;
  });
  const second = await queue.start('session-1', meta('live-b'), async () => {
    order.push('b');
    return { runId: 'run-b' };
  });
  const third = await queue.start('session-1', meta('live-c'), async () => {
    order.push('c');
    return { runId: 'run-c' };
  });

  assert.ok(isQueuedRun(second));
  assert.ok(isQueuedRun(third));
  assert.equal(second.position, 1);
  assert.equal(third.position, 2);
  assert.equal(second.liveId, 'live-b');
  assert.equal(second.sessionId, 'session-1');
  assert.equal(queue.get(second.queueId)?.position, 1);

  gate.resolve({ runId: 'run-a' });
  assert.deepEqual(await first, { runId: 'run-a' });
  await until(() => queue.get(third.queueId)?.status === 'completed', 'third completion');

  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(queue.get(second.queueId)?.runId, 'run-b');
  assert.equal(queue.get(second.queueId)?.position, undefined);
});

test('the queue depth limit rejects the next waiting wake', async () => {
  const queue = new SessionExecutionQueue({ maxPending: 2 });
  const gate = deferred<{ readonly runId: string }>();
  const first = queue.start('session-1', meta('live-a'), () => gate.promise);
  await queue.start('session-1', meta('live-a'), async () => ({ runId: 'run-b' }));
  await queue.start('session-1', meta('live-a'), async () => ({ runId: 'run-c' }));

  await assert.rejects(
    queue.start('session-1', meta('live-a'), async () => ({ runId: 'run-d' })),
    (error: unknown) => {
      assert.ok(error instanceof SessionQueueFullError);
      assert.equal(error.sessionId, 'session-1');
      assert.equal(error.capacity, 2);
      assert.equal(error.message.includes('capacity 2'), true);
      return true;
    },
  );

  gate.resolve({ runId: 'run-a' });
  await first;
});

test('a waiting item times out, stays queryable, and never executes', async () => {
  const timers = new FakeTimers();
  const queue = new SessionExecutionQueue({ timers, waitTimeoutMs: 60_000 });
  const gate = deferred<{ readonly runId: string }>();
  const ran: string[] = [];
  const first = queue.start('session-1', meta('live-a'), () => gate.promise);
  const queued = await queue.start('session-1', meta('live-b'), async () => {
    ran.push('b');
    return { runId: 'run-b' };
  });
  assert.ok(isQueuedRun(queued));
  assert.equal(timers.size, 1);

  timers.fireAll();

  const view = queue.get(queued.queueId);
  assert.equal(view?.status, 'timeout');
  assert.equal(view?.error, 'queue-timeout');
  assert.equal(view?.position, undefined);
  assert.equal(timers.size, 0);

  gate.resolve({ runId: 'run-a' });
  await first;
  await delay(5);
  assert.deepEqual(ran, []);

  // The timed-out item left the session slot free for the next caller.
  const next = await queue.start('session-1', meta('live-c'), async () => ({
    runId: 'run-c',
  }));
  assert.equal(isQueuedRun(next), false);
});

test('an unload drops only that live waiting items and leaves running work alone', async () => {
  const queue = new SessionExecutionQueue();
  const gateA = deferred<{ readonly runId: string }>();
  const ran: string[] = [];

  const first = queue.start('session-1', meta('live-a'), () => gateA.promise);
  const other = await queue.start('session-1', meta('live-b'), async () => {
    ran.push('b');
    return { runId: 'run-b' };
  });
  const dropped = await queue.start('session-1', meta('live-a'), async () => {
    ran.push('a2');
    return { runId: 'run-a2' };
  });
  assert.ok(isQueuedRun(other) && isQueuedRun(dropped));

  // `other` is waiting behind `first`; live-a's second item must go away while
  // live-b's item keeps its place.
  assert.equal(queue.dropByLive('live-a'), 1);
  assert.equal(queue.get(dropped.queueId)?.status, 'dropped');
  assert.equal(queue.get(other.queueId)?.status, 'queued');
  assert.equal(queue.get(other.queueId)?.position, 1);

  gateA.resolve({ runId: 'run-a' });
  await first;
  await until(() => queue.get(other.queueId)?.status === 'completed', 'live-b completion');
  assert.deepEqual(ran, ['b']);
});

test('a promoted item is running, so unload leaves it untouched', async () => {
  const queue = new SessionExecutionQueue();
  const gateA = deferred<{ readonly runId: string }>();
  const gateB = deferred<{ readonly runId: string }>();

  const first = queue.start('session-1', meta('live-a'), () => gateA.promise);
  const promoted = await queue.start('session-1', meta('live-b'), () => gateB.promise);
  assert.ok(isQueuedRun(promoted));

  gateA.resolve({ runId: 'run-a' });
  await first;
  await until(() => queue.get(promoted.queueId)?.status === 'running', 'promotion');

  assert.equal(queue.dropByLive('live-b'), 0);
  assert.equal(queue.get(promoted.queueId)?.status, 'running');

  gateB.resolve({ runId: 'run-b' });
  await until(() => queue.get(promoted.queueId)?.status === 'completed', 'promoted completion');
  assert.equal(queue.get(promoted.queueId)?.runId, 'run-b');
});

test('a failed queued job is recorded without leaking its message and advances', async () => {
  const queue = new SessionExecutionQueue();
  const gate = deferred<{ readonly runId: string }>();
  const first = queue.start('session-1', meta('live-a'), () => gate.promise);
  const failing = await queue.start('session-1', meta('live-b'), async () => {
    throw new Error('native detail SECRET-SHOULD-NOT-LEAK');
  });
  if (!isQueuedRun(failing)) {
    assert.fail('expected a queued handle for the failing run');
  }
  const failingId = failing.queueId;

  gate.resolve({ runId: 'run-a' });
  await first;
  await until(() => queue.get(failingId)?.status === 'failed', 'failure recording');

  const view = queue.get(failingId);
  assert.equal(view?.error, 'run failed');
  assert.equal(JSON.stringify(view).includes('SECRET'), false);

  const next = await queue.start('session-1', meta('live-c'), async () => ({
    runId: 'run-c',
  }));
  assert.equal(isQueuedRun(next), false);
});

test('dispose clears timers, drops waiting items and refuses new work', async () => {
  const timers = new FakeTimers();
  const queue = new SessionExecutionQueue({ timers });
  const gate = deferred<{ readonly runId: string }>();
  const ran: string[] = [];
  const first = queue.start('session-1', meta('live-a'), () => gate.promise);
  const second = await queue.start('session-1', meta('live-b'), async () => {
    ran.push('b');
    return { runId: 'run-b' };
  });
  if (!isQueuedRun(second)) {
    assert.fail('expected a queued handle');
  }
  assert.equal(timers.size, 1);

  queue.dispose();
  assert.equal(timers.size, 0);
  assert.equal(queue.get(second.queueId)?.status, 'dropped');
  await assert.rejects(
    queue.start('session-1', meta('live-c'), async () => ({ runId: 'run-c' })),
    SessionQueueDisposedError,
  );

  gate.resolve({ runId: 'run-a' });
  await first;
  await delay(5);
  assert.deepEqual(ran, []);
});

test('an unknown queue id is not visible', () => {
  const queue = new SessionExecutionQueue();
  assert.equal(queue.get('missing-queue'), undefined);
});
