import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationStore, expandHomePath, type ConversationRecord } from '../src/conversation-store.js';

function store(): ConversationStore {
  return new ConversationStore(join(mkdtempSync(join(tmpdir(), 'uw-conv-store-')), 'conversations.json'));
}

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    conversationId: 'conversation-1',
    harness: 'codex',
    nativeId: 'native-1',
    projectId: 'project-1',
    projectDirectory: 'C:/work/project',
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

test('returns an empty list when the store file does not exist', () => {
  assert.deepEqual(store().load(), []);
});

test('upserts, finds and preserves the latest record per conversation', () => {
  const conversations = store();
  conversations.upsert(record());
  conversations.upsert(record({ updatedAt: '2026-11-02T01:00:00.000Z', nativeId: 'native-2' }));

  const loaded = conversations.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.nativeId, 'native-2');
  assert.equal(conversations.find('conversation-1')?.nativeId, 'native-2');
  assert.equal(conversations.find('missing'), undefined);
});

test('finds the latest record for a project directory', () => {
  const conversations = store();
  conversations.upsert(record({ conversationId: 'a', updatedAt: '2026-11-02T00:00:00.000Z' }));
  conversations.upsert(
    record({ conversationId: 'b', updatedAt: '2026-11-02T02:00:00.000Z' }),
  );
  conversations.upsert(record({ conversationId: 'c', projectDirectory: 'C:/other' }));

  assert.equal(conversations.latestForProject('C:/work/project')?.conversationId, 'b');
  assert.equal(conversations.latestForProject('C:/missing'), undefined);
});

test('writes the file as JSON and ignores malformed entries', () => {
  const conversations = store();
  conversations.upsert(record());
  const raw = JSON.parse(readFileSync(conversations.filePath, 'utf8')) as unknown[];
  assert.equal(raw.length, 1);

  writeFileSync(conversations.filePath, JSON.stringify([record(), { bad: true }]), 'utf8');
  assert.equal(conversations.load().length, 1);
});

test('throws on a file that is not a JSON array', () => {
  const conversations = store();
  writeFileSync(conversations.filePath, JSON.stringify({ nope: true }), 'utf8');
  assert.throws(() => conversations.load(), /must contain an array/);
});


test('blocks a second writer until the lock file is removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-conv-lock-'));
  const filePath = join(dir, 'conversations.json');
  const storePath = fileURLToPath(new URL('../src/conversation-store.js', import.meta.url));
  writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: process.pid }), 'utf8');

  const storeUrl = pathToFileURL(storePath).href;
  const script = `import { ConversationStore } from ${JSON.stringify(storeUrl)};\nnew ConversationStore(process.argv[1]).upsert(JSON.parse(process.argv[2]));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, filePath, JSON.stringify(record())], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let exited = false;
  const exitPromise = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      exited = true;
      resolveExit();
    });
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  assert.equal(exited, false, 'writer should wait for the lock');
  unlinkSync(`${filePath}.lock`);
  await exitPromise;
  assert.equal(new ConversationStore(filePath).load().length, 1);
});

test('recovers a stale lock file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-conv-stale-'));
  const filePath = join(dir, 'conversations.json');
  writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: 1 }), 'utf8');
  utimesSync(`${filePath}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const conversations = new ConversationStore(filePath);
  conversations.upsert(record());
  assert.equal(conversations.load().length, 1);
});

test('compares project paths case-insensitively on Windows', () => {
  const conversations = store();
  conversations.upsert(record({ projectDirectory: 'C:/Work/Project' }));
  const found = conversations.latestForProject(process.platform === 'win32' ? 'C:/work/project' : 'C:/Work/Project');
  assert.equal(found?.conversationId, 'conversation-1');
});




test('expands a leading ~ in store paths', () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  assert.equal(expandHomePath('~'), home);
  assert.equal(expandHomePath('~/state.json'), join(home, 'state.json'));
  assert.equal(expandHomePath('C:/state.json'), 'C:/state.json');
});

test('removes stale temp files but keeps fresh ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-conv-tmp-'));
  const filePath = join(dir, 'conversations.json');
  const stale = `${filePath}.1.dead.tmp`;
  const fresh = `${filePath}.2.dead.tmp`;
  writeFileSync(stale, '{}', 'utf8');
  writeFileSync(fresh, '{}', 'utf8');
  utimesSync(stale, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000));

  new ConversationStore(filePath).upsert(record());
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

