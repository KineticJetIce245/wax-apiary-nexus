import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DaemonLock, DaemonLockError } from '../src/daemon/daemon-lock.js';

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wax-daemon-lock-')), 'daemon.lock');
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid !== undefined);
  return child.pid;
}

test('a lock can be acquired and released once', () => {
  const path = lockPath();
  const lock = DaemonLock.acquire(path, 'comp');

  assert.equal(existsSync(path), true);
  const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; compositionId: string };
  assert.equal(record.pid, process.pid);
  assert.equal(record.compositionId, 'comp');

  lock.release();
  assert.equal(existsSync(path), false);
  lock.release();
});

test('a second active lock is refused', () => {
  const path = lockPath();
  const lock = DaemonLock.acquire(path, 'comp');
  try {
    assert.throws(
      () => DaemonLock.acquire(path, 'comp'),
      (error: unknown) =>
        error instanceof DaemonLockError && /another daemon is already running/.test(error.message),
    );
  } finally {
    lock.release();
  }
});

test('a deterministic stale lock is replaced only after its pid is dead', () => {
  const path = lockPath();
  const pid = deadPid();
  writeFileSync(
    path,
    `${JSON.stringify({ pid, nonce: 'stale', startedAt: new Date().toISOString(), compositionId: 'comp' })}\n`,
  );

  const lock = DaemonLock.acquire(path, 'comp');
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    assert.equal(record.pid, process.pid);
  } finally {
    lock.release();
  }
});

test('a malformed lock is never stolen', () => {
  const path = lockPath();
  writeFileSync(path, '{ not json');

  assert.throws(
    () => DaemonLock.acquire(path, 'comp'),
    (error: unknown) =>
      error instanceof DaemonLockError && /malformed/.test(error.message),
  );
  assert.equal(existsSync(path), true);
});

test('a lock without a pid is never stolen', () => {
  const path = lockPath();
  writeFileSync(path, `${JSON.stringify({ nonce: 'x' })}\n`);

  assert.throws(
    () => DaemonLock.acquire(path, 'comp'),
    (error: unknown) => error instanceof DaemonLockError && /no usable pid/.test(error.message),
  );
  assert.equal(existsSync(path), true);
});
