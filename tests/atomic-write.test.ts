import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  atomicWriteJson,
  nodeAtomicWriteBackend,
  type AtomicWriteBackend,
} from '../src/storage/atomic-write.js';

function tempFile(name = 'field.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wax-atomic-'));
  return join(dir, name);
}

function tempEntries(path: string): string[] {
  return readdirSync(dirname(path)).filter((entry) => entry.includes('.tmp-'));
}

test('atomicWriteJson writes pretty JSON and leaves no temp file', () => {
  const path = tempFile();

  atomicWriteJson(path, { ok: true, count: 2 });

  assert.equal(readFileSync(path, 'utf8'), '{\n  "ok": true,\n  "count": 2\n}\n');
  assert.deepEqual(tempEntries(path), []);
});

test('a sync failure leaves the previous target intact and removes the temp file', () => {
  const path = tempFile();
  writeFileSync(path, 'old target\n');
  const failing: AtomicWriteBackend = {
    ...nodeAtomicWriteBackend,
    create(tempPath, mode) {
      const inner = nodeAtomicWriteBackend.create(tempPath, mode);
      return {
        write: (data) => inner.write(data),
        sync: () => {
          throw new Error('sync failed');
        },
        close: () => inner.close(),
      };
    },
  };

  assert.throws(() => atomicWriteJson(path, { new: true }, failing), /sync failed/);
  assert.equal(readFileSync(path, 'utf8'), 'old target\n');
  assert.deepEqual(tempEntries(path), []);
});

test('a rename failure leaves the previous target intact and removes the temp file', () => {
  const path = tempFile();
  writeFileSync(path, 'old target\n');
  const failing: AtomicWriteBackend = {
    ...nodeAtomicWriteBackend,
    rename: () => {
      throw new Error('rename failed');
    },
  };

  assert.throws(() => atomicWriteJson(path, { new: true }, failing), /rename failed/);
  assert.equal(readFileSync(path, 'utf8'), 'old target\n');
  assert.deepEqual(tempEntries(path), []);
});

test('a directory-sync failure does not report a committed rename as failed', () => {
  const path = tempFile();
  const failing: AtomicWriteBackend = {
    ...nodeAtomicWriteBackend,
    fsyncDirectory: () => {
      throw new Error('directory sync failed');
    },
  };

  atomicWriteJson(path, { committed: true }, failing);

  assert.equal(readFileSync(path, 'utf8'), '{\n  "committed": true\n}\n');
  assert.deepEqual(tempEntries(path), []);
});
