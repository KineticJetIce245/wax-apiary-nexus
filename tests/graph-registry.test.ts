import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GraphAlreadyLoadedError,
  GraphNotLoadedError,
  GraphRegistry,
  GraphUnloadingError,
  type GraphRegistryEvent,
} from '../src/graph/registry.js';

class FakeClock {
  time: number;

  constructor(time = 0) {
    this.time = time;
  }

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => {
      settle?.();
    },
  };
}

test('load records timestamps and rejects a duplicate id', () => {
  const clock = new FakeClock(1_000);
  const events: GraphRegistryEvent<string>[] = [];
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onEvent: (event) => events.push(event),
  });

  registry.load('alpha', 'value-a');

  assert.deepEqual(registry.peek('alpha'), {
    id: 'alpha',
    value: 'value-a',
    residency: {
      loadedAt: 1_000,
      lastAccessAt: 1_000,
      idleTtlMs: 1_800_000,
      pinned: false,
      refCount: 0,
      state: 'loaded',
      nextEvictionAt: 1_801_000,
    },
  });
  assert.deepEqual(events, [{ type: 'graph.loaded', id: 'alpha', at: 1_000 }]);

  assert.throws(() => registry.load('alpha', 'replacement'), GraphAlreadyLoadedError);
  assert.equal(registry.peek('alpha')?.value, 'value-a');
  assert.equal(registry.size(), 1);

  assert.throws(() => registry.load('bad-ttl', 'x', { idleTtlMs: -1 }), /non-negative integer/);
  assert.equal(registry.peek('bad-ttl'), undefined);
  assert.equal(events.length, 1);
});

test('acquire refreshes access time; release is idempotent and does not go negative', async () => {
  const clock = new FakeClock();
  const registry = new GraphRegistry<string>({ now: clock.now });
  registry.load('alpha', 'a', { idleTtlMs: 100 });
  clock.advance(60);

  const lease = registry.acquire('alpha');
  assert.equal(lease.id, 'alpha');
  assert.equal(lease.value, 'a');
  assert.equal(registry.peek('alpha')?.residency.refCount, 1);
  assert.equal(registry.peek('alpha')?.residency.lastAccessAt, 60);

  lease.release();
  lease.release();
  assert.equal(registry.peek('alpha')?.residency.refCount, 0);

  clock.advance(80); // 140: the original deadline (100) would have passed
  let report = await registry.sweep();
  assert.deepEqual(report.skipped, [{ id: 'alpha', reason: 'not-expired' }]);
  assert.equal(registry.size(), 1);

  clock.advance(20); // exactly the refreshed deadline
  report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['alpha']);
});

test('peek and list do not refresh access and do not affect nextEvictionAt', async () => {
  const clock = new FakeClock();
  const registry = new GraphRegistry<string>({ now: clock.now });
  registry.load('alpha', 'a', { idleTtlMs: 100 });
  registry.load('beta', 'b', { idleTtlMs: 200 });
  clock.advance(50);

  const peeked = registry.peek('alpha');
  assert.ok(peeked);
  (peeked.residency as { lastAccessAt: number }).lastAccessAt = 999;

  const listed = registry.list();
  assert.equal(peeked.residency.lastAccessAt, 999); // this copy was mutated by the test
  assert.equal(registry.peek('alpha')?.residency.lastAccessAt, 0);
  assert.deepEqual(
    listed.map((entry) => entry.id),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    listed.map((entry) => entry.residency.lastAccessAt),
    [0, 0],
  );
  assert.equal(registry.nextEvictionAt(), 100);

  clock.advance(50); // alpha is due; peek/list must not have moved it
  const report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['alpha']);
  assert.deepEqual(report.skipped, [{ id: 'beta', reason: 'not-expired' }]);
  assert.equal(registry.nextEvictionAt(), 200);
});

test('TTL expiry flushes the value and emits an unloaded event', async () => {
  interface GraphValue {
    readonly name: string;
  }
  const clock = new FakeClock();
  const value: GraphValue = { name: 'alpha' };
  const flushed: Array<{ readonly id: string; readonly value: GraphValue }> = [];
  const events: GraphRegistryEvent<GraphValue>[] = [];
  const registry = new GraphRegistry<GraphValue>({
    now: clock.now,
    onUnload: (id, graph) => {
      flushed.push({ id, value: graph });
    },
    onEvent: (event) => events.push(event),
  });
  registry.load('alpha', value, { idleTtlMs: 100 });

  clock.advance(99);
  const early = await registry.sweep();
  assert.deepEqual(early, {
    unloaded: [],
    skipped: [{ id: 'alpha', reason: 'not-expired' }],
    failed: [],
  });
  assert.equal(flushed.length, 0);

  clock.advance(1);
  const report = await registry.sweep();
  assert.deepEqual(report, { unloaded: ['alpha'], skipped: [], failed: [] });
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.id, 'alpha');
  assert.equal(flushed[0]?.value, value);
  assert.equal(registry.size(), 0);
  assert.equal(registry.peek('alpha'), undefined);
  assert.deepEqual(events, [
    { type: 'graph.loaded', id: 'alpha', at: 0 },
    { type: 'graph.unloaded', id: 'alpha', at: 100, reason: 'ttl' },
  ]);
});

test('a pinned graph is skipped until unpin resets the idle deadline', async () => {
  const clock = new FakeClock();
  const registry = new GraphRegistry<string>({ now: clock.now });
  registry.load('alpha', 'a', { idleTtlMs: 100, pinned: true });
  clock.advance(1_000);

  let report = await registry.sweep();
  assert.deepEqual(report.skipped, [{ id: 'alpha', reason: 'pinned' }]);
  assert.equal(registry.size(), 1);
  assert.equal(registry.nextEvictionAt(), undefined);

  registry.unpin('alpha');
  assert.equal(registry.peek('alpha')?.residency.pinned, false);
  assert.equal(registry.peek('alpha')?.residency.lastAccessAt, 1_000);
  assert.equal(registry.nextEvictionAt(), 1_100);

  clock.advance(99);
  report = await registry.sweep();
  assert.deepEqual(report.skipped, [{ id: 'alpha', reason: 'not-expired' }]);

  clock.advance(1);
  report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['alpha']);
});

test('a positive refCount blocks eviction and release does not extend the deadline', async () => {
  const clock = new FakeClock();
  const registry = new GraphRegistry<string>({ now: clock.now });
  registry.load('alpha', 'a', { idleTtlMs: 100 });
  const lease = registry.acquire('alpha');
  clock.advance(100);

  let report = await registry.sweep();
  assert.deepEqual(report.skipped, [{ id: 'alpha', reason: 'busy' }]);
  assert.equal(registry.size(), 1);

  lease.release();
  report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['alpha']);
});

test('isSafeToUnload gates eviction', async () => {
  const clock = new FakeClock();
  const seen: Array<{ readonly id: string; readonly value: string }> = [];
  let safe = false;
  const registry = new GraphRegistry<string>({
    now: clock.now,
    isSafeToUnload: (id, value) => {
      seen.push({ id, value });
      return safe;
    },
  });
  registry.load('alpha', 'a', { idleTtlMs: 100 });
  clock.advance(100);

  let report = await registry.sweep();
  assert.deepEqual(report.skipped, [{ id: 'alpha', reason: 'unsafe' }]);
  assert.deepEqual(seen, [{ id: 'alpha', value: 'a' }]);
  assert.equal(registry.size(), 1);

  safe = true;
  report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['alpha']);
  assert.equal(seen.length, 2);
});

test('per-graph TTL overrides the default and zero disables eviction', async () => {
  const clock = new FakeClock();
  const registry = new GraphRegistry<string>({ now: clock.now, defaultIdleTtlMs: 100 });
  registry.load('disabled', 'd', { idleTtlMs: 0 });
  registry.load('defaulted', 'x');
  registry.load('long', 'l', { idleTtlMs: 500 });
  assert.equal(registry.nextEvictionAt(), 100);

  clock.advance(100);
  let report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['defaulted']);
  assert.deepEqual(report.skipped, [
    { id: 'disabled', reason: 'disabled' },
    { id: 'long', reason: 'not-expired' },
  ]);
  assert.equal(registry.nextEvictionAt(), 500);

  clock.advance(400);
  report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['long']);
  assert.deepEqual(report.skipped, [{ id: 'disabled', reason: 'disabled' }]);
  assert.equal(registry.nextEvictionAt(), undefined);
  assert.equal(registry.size(), 1);
});

test('a failed flush keeps the graph loaded and delays the retry', async () => {
  const clock = new FakeClock();
  const events: GraphRegistryEvent<string>[] = [];
  let fail = true;
  let flushes = 0;
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onUnload: async () => {
      flushes += 1;
      if (fail) {
        throw new Error('flush failed');
      }
    },
    onEvent: (event) => events.push(event),
  });
  registry.load('alpha', 'a', { idleTtlMs: 100 });
  clock.advance(100);

  const report = await registry.sweep();
  assert.deepEqual(report.unloaded, []);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.failed, [{ id: 'alpha', error: 'flush failed' }]);
  assert.equal(registry.size(), 1);
  assert.equal(registry.peek('alpha')?.residency.state, 'loaded');
  assert.equal(registry.peek('alpha')?.residency.lastAccessAt, 100);
  assert.deepEqual(events.at(-1), {
    type: 'graph.unload-failed',
    id: 'alpha',
    at: 100,
    reason: 'ttl',
    error: 'flush failed',
  });

  const immediate = await registry.sweep();
  assert.deepEqual(immediate.skipped, [{ id: 'alpha', reason: 'not-expired' }]);
  assert.equal(flushes, 1);

  fail = false;
  clock.advance(100);
  const retried = await registry.sweep();
  assert.deepEqual(retried.unloaded, ['alpha']);
  assert.equal(flushes, 2);
});

test('a non-Error flush rejection is reported as a string', async () => {
  const clock = new FakeClock();
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onUnload: () => {
      // A foreign flush implementation may reject with a non-Error value.
      throw 'flush exploded';
    },
  });
  registry.load('alpha', 'a', { idleTtlMs: 100 });
  clock.advance(100);

  const report = await registry.sweep();
  assert.deepEqual(report.failed, [{ id: 'alpha', error: 'flush exploded' }]);
  assert.equal(registry.peek('alpha')?.residency.state, 'loaded');
});

test('a failed flush does not stop the sweep from unloading another graph', async () => {
  const clock = new FakeClock();
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onUnload: async (id) => {
      if (id === 'broken') {
        throw new Error('flush failed');
      }
    },
  });
  registry.load('broken', 'b', { idleTtlMs: 100 });
  registry.load('healthy', 'h', { idleTtlMs: 100 });
  clock.advance(100);

  const report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['healthy']);
  assert.deepEqual(report.failed, [{ id: 'broken', error: 'flush failed' }]);
  assert.equal(registry.size(), 1);
  assert.equal(registry.peek('broken')?.residency.state, 'loaded');
  assert.equal(registry.peek('healthy'), undefined);
});

test('concurrent sweeps never flush the same graph twice', async () => {
  const clock = new FakeClock();
  const gate = deferred();
  let flushes = 0;
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onUnload: async () => {
      flushes += 1;
      await gate.promise;
    },
  });
  registry.load('alpha', 'a', { idleTtlMs: 100 });
  clock.advance(100);

  const first = registry.sweep();
  const second = registry.sweep();
  assert.equal(registry.peek('alpha')?.residency.state, 'unloading');

  gate.resolve();
  const [firstReport, secondReport] = await Promise.all([first, second]);

  assert.equal(flushes, 1);
  assert.deepEqual(firstReport.unloaded, ['alpha']);
  assert.deepEqual(firstReport.skipped, []);
  assert.deepEqual(secondReport.unloaded, []);
  assert.deepEqual(secondReport.skipped, [{ id: 'alpha', reason: 'unloading' }]);
  assert.equal(registry.size(), 0);
});

test('acquire during unload throws and the id can be loaded again afterwards', async () => {
  const clock = new FakeClock();
  const gate = deferred();
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onUnload: () => gate.promise,
  });
  registry.load('alpha', 'first', { idleTtlMs: 100 });
  clock.advance(100);

  const sweepPromise = registry.sweep();
  assert.equal(registry.peek('alpha')?.residency.state, 'unloading');
  assert.throws(() => registry.acquire('alpha'), GraphUnloadingError);

  gate.resolve();
  const report = await sweepPromise;
  assert.deepEqual(report.unloaded, ['alpha']);
  assert.equal(registry.size(), 0);

  registry.load('alpha', 'second', { idleTtlMs: 100 });
  assert.equal(registry.peek('alpha')?.value, 'second');
  assert.equal(registry.peek('alpha')?.residency.loadedAt, 100);
  assert.equal(registry.peek('alpha')?.residency.state, 'loaded');
});

test('explicit unload ignores TTL but respects pin, refCount and safety', async () => {
  const clock = new FakeClock();
  const flushes: string[] = [];
  const events: GraphRegistryEvent<string>[] = [];
  const unsafe = new Set<string>();
  const registry = new GraphRegistry<string>({
    now: clock.now,
    isSafeToUnload: (id) => !unsafe.has(id),
    onUnload: (id) => {
      flushes.push(id);
    },
    onEvent: (event) => events.push(event),
  });
  registry.load('never-expires', 'a', { idleTtlMs: 0 });
  registry.load('pinned', 'p', { idleTtlMs: 100, pinned: true });
  registry.load('busy', 'b', { idleTtlMs: 100 });
  registry.load('unsafe', 'u', { idleTtlMs: 100 });
  unsafe.add('unsafe');
  const lease = registry.acquire('busy');

  assert.equal(await registry.unload('never-expires'), true);
  assert.equal(await registry.unload('pinned'), false);
  assert.equal(await registry.unload('busy'), false);
  assert.equal(await registry.unload('unsafe'), false);
  assert.equal(await registry.unload('missing'), false);
  assert.equal(registry.size(), 3);

  lease.release();
  assert.equal(await registry.unload('busy'), true);
  registry.unpin('pinned');
  assert.equal(await registry.unload('pinned'), true);
  unsafe.delete('unsafe');
  assert.equal(await registry.unload('unsafe'), true);
  assert.equal(registry.size(), 0);

  assert.deepEqual(flushes, ['never-expires', 'busy', 'pinned', 'unsafe']);
  assert.deepEqual(
    events.filter((event) => event.type === 'graph.unloaded'),
    [
      { type: 'graph.unloaded', id: 'never-expires', at: 0, reason: 'explicit' },
      { type: 'graph.unloaded', id: 'busy', at: 0, reason: 'explicit' },
      { type: 'graph.unloaded', id: 'pinned', at: 0, reason: 'explicit' },
      { type: 'graph.unloaded', id: 'unsafe', at: 0, reason: 'explicit' },
    ],
  );
});

test('a failed explicit flush returns false and leaves the graph loaded', async () => {
  const clock = new FakeClock();
  const events: GraphRegistryEvent<string>[] = [];
  let fail = true;
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onUnload: async () => {
      if (fail) {
        throw new Error('flush failed');
      }
    },
    onEvent: (event) => events.push(event),
  });
  registry.load('alpha', 'a', { idleTtlMs: 0 });
  clock.advance(10);

  assert.equal(await registry.unload('alpha'), false);
  assert.equal(registry.peek('alpha')?.residency.state, 'loaded');
  assert.equal(registry.peek('alpha')?.residency.lastAccessAt, 10);
  assert.deepEqual(events.at(-1), {
    type: 'graph.unload-failed',
    id: 'alpha',
    at: 10,
    reason: 'explicit',
    error: 'flush failed',
  });

  fail = false;
  assert.equal(await registry.unload('alpha'), true);
  assert.equal(registry.size(), 0);
});

test('events carry metadata only and a throwing listener cannot break state', async () => {
  const clock = new FakeClock();
  const events: GraphRegistryEvent<string>[] = [];
  const registry = new GraphRegistry<string>({
    now: clock.now,
    onEvent: (event) => {
      events.push(event);
      throw new Error('listener failed');
    },
  });
  registry.load('alpha', 'secret-value', { idleTtlMs: 100 });
  assert.equal(registry.size(), 1);

  clock.advance(100);
  const report = await registry.sweep();
  assert.deepEqual(report.unloaded, ['alpha']);
  assert.equal(registry.size(), 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ['graph.loaded', 'graph.unloaded'],
  );
  for (const event of events) {
    assert.equal(Object.hasOwn(event, 'value'), false);
    assert.equal(Object.hasOwn(event, 'id'), true);
  }
});

test('unknown ids are rejected by mutating accessors and absent from reads', async () => {
  const registry = new GraphRegistry<string>({ now: () => 0 });

  assert.throws(() => registry.acquire('missing'), GraphNotLoadedError);
  assert.throws(() => registry.touch('missing'), GraphNotLoadedError);
  assert.throws(() => registry.pin('missing'), GraphNotLoadedError);
  assert.throws(() => registry.unpin('missing'), GraphNotLoadedError);
  assert.equal(registry.peek('missing'), undefined);
  assert.deepEqual(registry.list(), []);
  assert.equal(await registry.unload('missing'), false);
  assert.equal(registry.nextEvictionAt(), undefined);
  assert.equal(registry.size(), 0);
});
