import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationStore, type ConversationRecord } from '../src/conversation-store.js';

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
