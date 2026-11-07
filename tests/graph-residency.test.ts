import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GraphResidency,
  GraphUnloadingError,
  type ResidencySnapshot,
} from '../src/graph/residency.js';

test('a new residency starts loaded with a 30 minute default idle TTL', () => {
  const residency = new GraphResidency(1_000);

  assert.equal(residency.loadedAt, 1_000);
  assert.equal(residency.lastAccessAt, 1_000);
  assert.equal(residency.idleTtlMs, 1_800_000);
  assert.equal(residency.pinned, false);
  assert.equal(residency.refCount, 0);
  assert.equal(residency.state, 'loaded');
  assert.equal(residency.nextEvictionAt(), 1_801_000);
  assert.deepEqual(residency.snapshot(5_000), {
    loadedAt: 1_000,
    lastAccessAt: 1_000,
    idleTtlMs: 1_800_000,
    pinned: false,
    refCount: 0,
    state: 'loaded',
    nextEvictionAt: 1_801_000,
  });
});

test('invalid idle TTLs are rejected', () => {
  for (const idleTtlMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new GraphResidency(0, { idleTtlMs }),
      /idleTtlMs must be a non-negative integer/,
    );
  }
});

test('idleTtlMs 0 disables automatic eviction and yields no deadline', () => {
  const residency = new GraphResidency(10, { idleTtlMs: 0 });

  assert.equal(residency.idleTtlMs, 0);
  assert.equal(residency.nextEvictionAt(), undefined);
  assert.equal(residency.snapshot(10).nextEvictionAt, undefined);
  assert.equal(residency.isExpired(Number.MAX_SAFE_INTEGER), false);
});

test('touch moves the access time; the TTL boundary is inclusive', () => {
  const residency = new GraphResidency(100, { idleTtlMs: 50 });

  assert.equal(residency.isExpired(149), false);
  assert.equal(residency.isExpired(150), true);

  residency.touch(200);
  assert.equal(residency.lastAccessAt, 200);
  assert.equal(residency.isExpired(249), false);
  assert.equal(residency.isExpired(250), true);
});

test('pin hides the deadline and unpin refreshes the access time', () => {
  const residency = new GraphResidency(0, { idleTtlMs: 100 });

  assert.equal(residency.nextEvictionAt(), 100);
  residency.pin(40);
  assert.equal(residency.pinned, true);
  assert.equal(residency.lastAccessAt, 40);
  assert.equal(residency.nextEvictionAt(), undefined);
  assert.equal(residency.snapshot(40).nextEvictionAt, undefined);

  residency.unpin(70);
  assert.equal(residency.pinned, false);
  assert.equal(residency.lastAccessAt, 70);
  assert.equal(residency.nextEvictionAt(), 170);
});

test('acquire counts references and release never drops below zero', () => {
  const residency = new GraphResidency(0, { idleTtlMs: 100 });

  residency.acquire();
  residency.acquire();
  assert.equal(residency.refCount, 2);
  assert.equal(residency.lastAccessAt, 0);

  residency.release();
  assert.equal(residency.refCount, 1);
  residency.release();
  assert.equal(residency.refCount, 0);
  residency.release();
  assert.equal(residency.refCount, 0);
  assert.equal(residency.state, 'loaded');
});

test('an unloading graph rejects access until the flush is cancelled', () => {
  const residency = new GraphResidency(0, { idleTtlMs: 100 });

  residency.beginUnload();
  assert.equal(residency.state, 'unloading');
  assert.equal(residency.nextEvictionAt(), undefined);
  assert.throws(() => residency.acquire(), GraphUnloadingError);
  assert.throws(() => residency.touch(10), GraphUnloadingError);
  assert.throws(() => residency.pin(10), GraphUnloadingError);
  assert.throws(() => residency.unpin(10), GraphUnloadingError);

  residency.cancelUnload(80);
  assert.equal(residency.state, 'loaded');
  assert.equal(residency.lastAccessAt, 80);
  assert.equal(residency.nextEvictionAt(), 180);
  residency.acquire();
  assert.equal(residency.refCount, 1);
});

test('cancelUnload rejects a graph that is not unloading', () => {
  const residency = new GraphResidency(0);
  assert.throws(() => residency.cancelUnload(10), /not unloading/);
  assert.equal(residency.state, 'loaded');
  assert.equal(residency.lastAccessAt, 0);
});

test('snapshots are fresh values and cannot mutate the residency', () => {
  const residency = new GraphResidency(0, { idleTtlMs: 100 });
  residency.acquire();

  const first = residency.snapshot(0);
  const second = residency.snapshot(0);
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, second);

  (first as { lastAccessAt: number }).lastAccessAt = 999;
  (first as { refCount: number }).refCount = 99;
  assert.equal(residency.lastAccessAt, 0);
  assert.equal(residency.refCount, 1);
  assert.deepEqual(residency.snapshot(0), second);
});

test('snapshot omits nextEvictionAt for pinned and disabled graphs', () => {
  const pinned: ResidencySnapshot = new GraphResidency(5, {
    idleTtlMs: 100,
    pinned: true,
  }).snapshot(10);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.nextEvictionAt, undefined);

  const disabled: ResidencySnapshot = new GraphResidency(5, { idleTtlMs: 0 }).snapshot(10);
  assert.equal(disabled.idleTtlMs, 0);
  assert.equal(disabled.nextEvictionAt, undefined);
});
