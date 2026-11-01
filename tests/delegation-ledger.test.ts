import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DelegationLedger,
  LedgerCorruptError,
  LedgerLockStaleError,
  LedgerLockedError,
  LedgerTornTailError,
  defaultDelegationStateDirectory,
  readLedgerFile,
} from '../src/delegation-ledger.js';

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'uw-g010-ledger-'));
}

function line(seq: number, id: string): string {
  return JSON.stringify({
    seq,
    writer: 'test-writer',
    at: '2026-11-01T00:00:00.000Z',
    type: 'work-item/created',
    data: { id, mandateId: 'm', requester: 'operator', basis: 'policy', policyVersion: 'v1', worker: 'dsh' },
  });
}

test('appends facts in order and replays them from disk', () => {
  const directory = stateDirectory();
  const ledger = DelegationLedger.open({ directory });
  try {
    ledger.append('work-item/created', { id: 'w1' });
    ledger.append('delivery/intent', { id: 'w1' });
    ledger.append('delivery/settled', { id: 'w1', state: 'completed' });
  } finally {
    ledger.close();
  }
  const read = readLedgerFile(join(directory, 'ledger.jsonl'));
  assert.equal(read.tornTail, false);
  assert.deepEqual(
    read.entries.map((entry) => [entry.seq, entry.type]),
    [
      [1, 'work-item/created'],
      [2, 'delivery/intent'],
      [3, 'delivery/settled'],
    ],
  );
  const reopened = DelegationLedger.open({ directory });
  try {
    assert.equal(reopened.readAll().entries.length, 3);
  } finally {
    reopened.close();
  }
});

test('refuses a second writer while the first holds the lock', () => {
  const directory = stateDirectory();
  const first = DelegationLedger.open({ directory });
  try {
    assert.throws(() => DelegationLedger.open({ directory }), LedgerLockedError);
  } finally {
    first.close();
  }
});

test('refuses a stale lock unless the caller confirms takeover', () => {
  const directory = stateDirectory();
  writeFileSync(join(directory, 'writer.lock'), JSON.stringify({ pid: 999_999 }), 'utf8');
  assert.throws(() => DelegationLedger.open({ directory }), LedgerLockStaleError);
  const recovered = DelegationLedger.open({ directory, allowStaleLock: true });
  recovered.close();
});

test('refuses to append over an incomplete tail and leaves the bytes untouched', () => {
  const directory = stateDirectory();
  const ledgerPath = join(directory, 'ledger.jsonl');
  writeFileSync(ledgerPath, `${line(1, 'w1')}\n{"seq":2,"writer":"test-writer"`, 'utf8');
  const before = readFileSync(ledgerPath, 'utf8');
  const ledger = DelegationLedger.open({ directory });
  try {
    assert.equal(ledger.hasTornTail, true);
    assert.equal(ledger.tornTailBlocksAppend, true);
    assert.throws(() => ledger.append('delivery/intent', { id: 'w1' }), LedgerTornTailError);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before);
  } finally {
    ledger.close();
  }
});

test('accepts a complete record that only lost its newline and starts a new line', () => {
  const directory = stateDirectory();
  const ledgerPath = join(directory, 'ledger.jsonl');
  writeFileSync(ledgerPath, line(1, 'w1'), 'utf8');
  const ledger = DelegationLedger.open({ directory });
  try {
    assert.equal(ledger.hasTornTail, true);
    assert.equal(ledger.tornTailBlocksAppend, false);
    ledger.append('delivery/intent', { id: 'w1' });
  } finally {
    ledger.close();
  }
  const read = readLedgerFile(ledgerPath);
  assert.equal(read.tornTail, false);
  assert.deepEqual(
    read.entries.map((entry) => entry.seq),
    [1, 2],
  );
});

test('rejects a corrupt line in the middle and keeps the file intact', () => {
  const directory = stateDirectory();
  const ledgerPath = join(directory, 'ledger.jsonl');
  writeFileSync(ledgerPath, `${line(1, 'w1')}\nnot json\n${line(3, 'w2')}\n`, 'utf8');
  const before = readFileSync(ledgerPath, 'utf8');
  assert.throws(() => readLedgerFile(ledgerPath), LedgerCorruptError);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);
});

test('keeps project ids out of the state path unless they match the whitelist', () => {
  const env = { UW_STATE_DIR: join(tmpdir(), 'uw-state-root') };
  assert.equal(defaultDelegationStateDirectory('project-1', env), join(env.UW_STATE_DIR, 'project-1'));
  const escaped = defaultDelegationStateDirectory('../../evil', env);
  assert.match(escaped, /[\\/]id-[0-9a-f]{16}$/);
  assert.equal(escaped.includes('evil'), false);
});
