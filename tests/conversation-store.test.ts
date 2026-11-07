import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationStore, expandHomePath, type ConversationRecord } from '../src/storage/conversation-store.js';

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

/** Raw JSON row for malformed-input tests; bypasses the record type. */
function malformed(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...record(), ...overrides };
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

test('loads old records without optional metadata and round-trips new fields', () => {
  const conversations = store();
  // Old record: exactly the original six fields.
  conversations.upsert(record());
  const old = conversations.find('conversation-1');
  assert.ok(old !== undefined);
  assert.equal(old.displayName, undefined);
  assert.equal(old.createdAt, undefined);
  assert.equal(old.model, undefined);
  assert.equal(old.reasoning, undefined);

  conversations.upsert(
    record({
      displayName: 'wax-session',
      createdAt: '2026-11-02T00:00:00.000Z',
      model: 'deepseek-chat',
      reasoning: 'high',
    }),
  );
  const loaded = conversations.load();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], {
    conversationId: 'conversation-1',
    harness: 'codex',
    nativeId: 'native-1',
    projectId: 'project-1',
    projectDirectory: 'C:/work/project',
    updatedAt: '2026-11-02T00:00:00.000Z',
    displayName: 'wax-session',
    createdAt: '2026-11-02T00:00:00.000Z',
    model: 'deepseek-chat',
    reasoning: 'high',
  });
});

test('filters records whose optional metadata has the wrong type', () => {
  const conversations = store();
  writeFileSync(
    conversations.filePath,
    JSON.stringify([
      record(),
      malformed({ conversationId: 'bad-display', displayName: 7 }),
      malformed({ conversationId: 'bad-created', createdAt: null }),
      malformed({ conversationId: 'bad-model', model: { name: 'x' } }),
      malformed({ conversationId: 'bad-reasoning', reasoning: false }),
    ]),
    'utf8',
  );

  // Same policy as any other malformed entry: the whole record is ignored,
  // instead of silently loading a partially usable mapping.
  assert.deepEqual(
    conversations.load().map((entry) => entry.conversationId),
    ['conversation-1'],
  );
});

test('remove deletes only the named record and is a no-op when absent', () => {
  const conversations = store();
  conversations.upsert(record({ conversationId: 'keep' }));
  conversations.upsert(record({ conversationId: 'drop' }));

  conversations.remove('drop');
  assert.deepEqual(
    conversations.load().map((entry) => entry.conversationId),
    ['keep'],
  );

  const before = readFileSync(conversations.filePath, 'utf8');
  conversations.remove('missing');
  assert.equal(readFileSync(conversations.filePath, 'utf8'), before);
  assert.deepEqual(
    conversations.load().map((entry) => entry.conversationId),
    ['keep'],
  );
});

test('remove preserves a record written by a concurrent upsert', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-conv-remove-race-'));
  const filePath = join(dir, 'conversations.json');
  const startedPath = join(dir, 'writer.started');
  const conversations = new ConversationStore(filePath);
  conversations.upsert(record({ conversationId: 'keep' }));
  conversations.upsert(record({ conversationId: 'drop' }));

  const storePath = fileURLToPath(new URL('../src/storage/conversation-store.js', import.meta.url));
  const storeUrl = pathToFileURL(storePath).href;
  const script =
    `import { writeFileSync } from 'node:fs';\n` +
    `import { ConversationStore } from ${JSON.stringify(storeUrl)};\n` +
    `writeFileSync(process.argv[3], 'started');\n` +
    `new ConversationStore(process.argv[1], { lockTimeoutMs: 10_000 }).upsert(JSON.parse(process.argv[2]));`;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      filePath,
      JSON.stringify(record({ conversationId: 'writer', nativeId: 'native-writer' })),
      startedPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exitPromise = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });

  const deadline = Date.now() + 5_000;
  while (!existsSync(startedPath)) {
    if (Date.now() >= deadline) {
      child.kill();
      assert.fail(`writer never started; stderr=${stderr}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  // Whatever the interleaving, the lock makes remove read the latest committed
  // file, so the writer's record must survive and the named record must not.
  conversations.remove('drop');
  const exitCode = await exitPromise;
  assert.equal(exitCode, 0, `writer failed; stderr=${stderr}`);

  const ids = new ConversationStore(filePath)
    .load()
    .map((entry) => entry.conversationId)
    .sort();
  assert.deepEqual(ids, ['keep', 'writer']);
});

test('throws on a file that is not a JSON array', () => {
  const conversations = store();
  writeFileSync(conversations.filePath, JSON.stringify({ nope: true }), 'utf8');
  assert.throws(() => conversations.load(), /must contain an array/);
});


test('blocks a second writer until the lock file is removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-conv-lock-'));
  const filePath = join(dir, 'conversations.json');
  const startedPath = join(dir, 'writer.started');
  const storePath = fileURLToPath(new URL('../src/storage/conversation-store.js', import.meta.url));
  writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: process.pid }), 'utf8');

  const storeUrl = pathToFileURL(storePath).href;
  const script =
    `import { writeFileSync } from 'node:fs';\n` +
    `import { ConversationStore } from ${JSON.stringify(storeUrl)};\n` +
    `writeFileSync(process.argv[3], 'started');\n` +
    `new ConversationStore(process.argv[1], { lockTimeoutMs: 10_000 }).upsert(JSON.parse(process.argv[2]));`;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', script, filePath, JSON.stringify(record()), startedPath],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let exited = false;
  let exitCode: number | null = null;
  let stderr = '';
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exitPromise = new Promise<void>((resolveExit) => {
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      resolveExit();
    });
  });

  const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (spawnError !== undefined) {
        assert.fail(`${label}: child failed to start: ${spawnError.message}`);
      }
      if (Date.now() >= deadline) {
        assert.fail(`${label}: timed out; exit=${String(exitCode)}, stderr=${stderr}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  };

  // Wait until the child has definitely started, then give it time to hit the
  // held lock. The previous fixed 800ms wait could race the child's 2s lock
  // timeout when the test runner was slow.
  await waitFor(() => existsSync(startedPath), 5_000, 'writer start');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  assert.equal(
    exited,
    false,
    `writer should wait for the lock (exit=${String(exitCode)}, stderr=${stderr})`,
  );
  unlinkSync(`${filePath}.lock`);
  await exitPromise;
  assert.equal(
    exitCode,
    0,
    `writer should exit cleanly after the lock is released (stderr=${stderr})`,
  );
  // The child exiting does not necessarily mean the file is immediately
  // visible to this process, especially on Windows. Poll for the record rather
  // than racing a single read.
  await waitFor(
    () => new ConversationStore(filePath).load().length === 1,
    3_000,
    'writer record visible',
  );
});

test('honors a configurable lock timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-conv-lock-timeout-'));
  const filePath = join(dir, 'conversations.json');
  writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: process.pid }), 'utf8');

  const strict = new ConversationStore(filePath, { lockTimeoutMs: 50 });
  assert.throws(() => strict.upsert(record()), /Conversation store is locked/);
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

