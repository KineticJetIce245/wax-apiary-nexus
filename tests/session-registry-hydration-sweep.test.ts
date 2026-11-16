import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions, HarnessCapabilities } from '../src/adapters/harness.js';
import { validateBindings, type GraphBindings } from '../src/graph/binding.js';
import type { Project } from '../src/project/kernel.js';
import { parseComposition } from '../src/runtime/index.js';
import {
  SessionAlreadyRegisteredError,
  SessionAttachError,
  SessionBusyError,
  SessionNotFoundError,
  SessionRegistry,
  type SessionRecord,
} from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import {
  ConversationStore,
  type ConversationRecord,
} from '../src/storage/conversation-store.js';
import { FakeAdapter } from './support/fake-adapter.js';

import {
  FIXED_NOW,
  ResumableFakeAdapter,
  makeProject,
  SharedNativeAdapter,
  FailingUpsertStore,
  SelectiveCloseFailureAdapter,
  setup,
  makeStore,
  rehydrate,
  isoClock,
  waitForExecutionSettled,
  makeDefinition,
} from './support/session-registry-fixtures.js';

test('hydrates persisted sessions without resuming them and keeps them idle', async (t) => {
  const store = makeStore();
  const first = setup(store);
  const created = await first.registry.create(first.project, {
    displayName: 'persisted-session',
    model: 'deepseek-chat',
    reasoning: 'high',
  });
  await first.workspace.stop();

  const second = rehydrate(store, first.project);
  t.after(() => second.workspace.stop());

  assert.equal(second.adapter.resumes.length, 0);
  const record = second.registry.get(created.sessionId);
  assert.ok(record !== undefined);
  assert.equal(record.nativeId, created.nativeId);
  assert.equal(record.displayName, 'persisted-session');
  assert.equal(record.createdAt, FIXED_NOW);
  assert.equal(record.lastAccessAt, FIXED_NOW);
  assert.equal(record.model, 'deepseek-chat');
  assert.equal(record.reasoning, 'high');
  assert.equal(second.registry.list().length, 1);
  assert.ok(second.registry.get(created.sessionId) !== undefined);
  assert.equal(second.workspace.getConversation(created.sessionId), undefined);
  assert.equal(second.registry.isBusy(created.sessionId), false);
});

test('hydrates old records using nativeId and updatedAt as fallbacks', async (t) => {
  const store = makeStore();
  const project = makeProject();
  store.upsert({
    conversationId: 'legacy-session',
    harness: 'dsh-acp',
    nativeId: 'legacy-native',
    projectId: project.id,
    projectDirectory: project.directory,
    updatedAt: '2026-01-02T03:04:05.000Z',
  });

  const { workspace, registry } = rehydrate(store, project);
  t.after(() => workspace.stop());

  const record = registry.get('legacy-session');
  assert.ok(record !== undefined);
  assert.equal(record.displayName, 'legacy-native');
  assert.equal(record.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(record.lastAccessAt, '2026-01-02T03:04:05.000Z');
});

test('ensureAttached resumes once, then reuses the attached conversation', async (t) => {
  const store = makeStore();
  const first = setup(store);
  const created = await first.registry.create(first.project);
  await first.workspace.stop();

  const second = rehydrate(store, first.project);
  t.after(() => second.workspace.stop());

  const attached = await second.registry.ensureAttached(created.sessionId);
  assert.equal(attached.sessionId, created.sessionId);
  assert.equal(attached.nativeId, created.nativeId);
  assert.deepEqual(second.adapter.resumes, [
    { nativeId: created.nativeId, cwd: first.project.directory },
  ]);
  assert.equal(second.workspace.getConversation(created.sessionId)?.nativeId, created.nativeId);

  const again = await second.registry.ensureAttached(created.sessionId);
  assert.deepEqual(again, attached);
  assert.equal(second.adapter.resumes.length, 1);
});

test('concurrent ensureAttached calls share one native resume', async (t) => {
  const store = makeStore();
  const first = setup(store);
  const created = await first.registry.create(first.project);
  await first.workspace.stop();

  const second = rehydrate(store, first.project);
  t.after(() => second.workspace.stop());
  let releaseResume!: () => void;
  second.adapter.resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });

  const firstCall = second.registry.ensureAttached(created.sessionId);
  const secondCall = second.registry.ensureAttached(created.sessionId);
  try {
    // Both calls run synchronously up to the adapter await; the in-flight map
    // must make the second call reuse the first resume.
    assert.equal(second.adapter.resumes.length, 1);
  } finally {
    releaseResume();
  }
  const [firstRecord, secondRecord] = await Promise.all([firstCall, secondCall]);
  assert.deepEqual(firstRecord, secondRecord);
  assert.equal(second.adapter.resumes.length, 1);
  assert.ok(second.workspace.getConversation(created.sessionId) !== undefined);
});

test('ensureAttached failure is typed, keeps the record, and can be retried', async (t) => {
  const store = makeStore();
  const first = setup(store);
  const created = await first.registry.create(first.project);
  await first.workspace.stop();

  const second = rehydrate(store, first.project);
  t.after(() => second.workspace.stop());
  const nativeFailure = new Error('native resume failed');
  second.adapter.resumeError = nativeFailure;

  await assert.rejects(
    second.registry.ensureAttached(created.sessionId),
    (error: unknown) => {
      assert.ok(error instanceof SessionAttachError);
      assert.equal(error.sessionId, created.sessionId);
      assert.equal(error.nativeId, created.nativeId);
      assert.equal(error.cause, nativeFailure);
      return true;
    },
  );
  assert.ok(second.registry.get(created.sessionId) !== undefined);
  assert.ok(store.find(created.sessionId) !== undefined);
  assert.equal(second.workspace.getConversation(created.sessionId), undefined);

  second.adapter.resumeError = undefined;
  const record = await second.registry.ensureAttached(created.sessionId);
  assert.equal(record.sessionId, created.sessionId);
  assert.equal(second.adapter.resumes.length, 2);
  assert.ok(second.workspace.getConversation(created.sessionId) !== undefined);
});

test('create and resume persist mappings and close removes them', async (t) => {
  const store = makeStore();
  const { adapter, workspace, registry, project } = setup(store);
  t.after(() => workspace.stop());

  const created = await registry.create(project, {
    displayName: 'persisted',
    model: 'deepseek-chat',
    reasoning: 'low',
  });
  const createdEntry = store.find(created.sessionId);
  assert.ok(createdEntry !== undefined);
  assert.equal(createdEntry.displayName, 'persisted');
  assert.equal(createdEntry.createdAt, FIXED_NOW);
  assert.equal(createdEntry.updatedAt, FIXED_NOW);
  assert.equal(createdEntry.model, 'deepseek-chat');
  assert.equal(createdEntry.reasoning, 'low');

  const resumed = await registry.resume(project, 'native-old', { sessionId: 'session-old' });
  const resumedEntry = store.find('session-old');
  assert.ok(resumedEntry !== undefined);
  assert.equal(resumedEntry.nativeId, 'native-old');
  assert.equal(resumedEntry.displayName, 'native-old');

  await registry.close(created.sessionId);
  assert.equal(store.find(created.sessionId), undefined);
  assert.equal(workspace.getConversation(created.sessionId), undefined);

  await registry.close(resumed.sessionId);
  assert.deepEqual(store.load(), []);
  assert.deepEqual(adapter.resumes, [
    { nativeId: 'native-old', cwd: project.directory },
  ]);
});

test('closing a hydrated but unattached session only removes its mapping', async (t) => {
  const store = makeStore();
  const first = setup(store);
  const created = await first.registry.create(first.project);
  await first.workspace.stop();

  const second = rehydrate(store, first.project);
  t.after(() => second.workspace.stop());

  await second.registry.close(created.sessionId);

  assert.equal(second.registry.get(created.sessionId), undefined);
  assert.equal(store.find(created.sessionId), undefined);
  // No workspace or native close was attempted: nothing was attached.
  assert.deepEqual(second.adapter.closed, []);
});

test('a create whose mapping cannot be persisted closes the conversation and registers nothing', async (t) => {
  const store = new FailingUpsertStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-failing-')), 'sessions.json'),
  );
  const { adapter, workspace, registry, project } = setup(store);
  t.after(() => workspace.stop());
  store.failUpsert = true;

  await assert.rejects(registry.create(project), /store write failed/);
  assert.equal(registry.list().length, 0);
  assert.deepEqual(store.load(), []);
  assert.deepEqual(adapter.closed, ['native-1']);
});

test('a resume whose mapping cannot be persisted closes the conversation and registers nothing', async (t) => {
  const store = new FailingUpsertStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-failing-')), 'sessions.json'),
  );
  const { adapter, workspace, registry, project } = setup(store);
  t.after(() => workspace.stop());
  store.failUpsert = true;

  await assert.rejects(
    registry.resume(project, 'native-old', { sessionId: 'session-old' }),
    /store write failed/,
  );
  assert.equal(registry.get('session-old'), undefined);
  assert.deepEqual(store.load(), []);
  assert.deepEqual(adapter.closed, ['native-old']);
});

test('create, resume and ensureAttached stamp lastAccessAt from the registry clock', async (t) => {
  const clock = isoClock();
  const store = makeStore();
  const { workspace, registry, project } = setup(store, clock.now);
  t.after(() => workspace.stop());

  const created = await registry.create(project);
  assert.equal(created.lastAccessAt, FIXED_NOW);
  assert.equal(store.find(created.sessionId)?.updatedAt, FIXED_NOW);

  clock.set('2026-11-06T22:00:30.000Z');
  const resumed = await registry.resume(project, 'native-old', { sessionId: 'session-old' });
  assert.equal(resumed.lastAccessAt, '2026-11-06T22:00:30.000Z');
  assert.equal(store.find('session-old')?.updatedAt, '2026-11-06T22:00:30.000Z');

  // Already attached: ensureAttached still refreshes the access clock.
  clock.set('2026-11-06T22:01:00.000Z');
  const attached = await registry.ensureAttached(created.sessionId);
  assert.equal(attached.lastAccessAt, '2026-11-06T22:01:00.000Z');
  assert.equal(store.find(created.sessionId)?.updatedAt, '2026-11-06T22:01:00.000Z');
});

test('ensureAttached refreshes lastAccessAt after a lazy native resume', async (t) => {
  const store = makeStore();
  const first = setup(store);
  const created = await first.registry.create(first.project);
  await first.workspace.stop();

  const clock = isoClock('2026-11-06T23:00:00.000Z');
  const second = rehydrate(store, first.project, clock.now);
  t.after(() => second.workspace.stop());
  // Hydration itself does not access the session.
  assert.equal(second.registry.get(created.sessionId)?.lastAccessAt, FIXED_NOW);

  clock.set('2026-11-06T23:30:00.000Z');
  const attached = await second.registry.ensureAttached(created.sessionId);
  assert.equal(attached.lastAccessAt, '2026-11-06T23:30:00.000Z');
  assert.equal(second.adapter.resumes.length, 1);
  assert.equal(store.find(created.sessionId)?.updatedAt, '2026-11-06T23:30:00.000Z');
});

test('touch refreshes lastAccessAt in memory and in the store', async (t) => {
  const clock = isoClock();
  const store = makeStore();
  const { workspace, registry, project } = setup(store, clock.now);
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  clock.set('2026-11-06T22:05:00.000Z');
  registry.touch(record.sessionId);

  assert.equal(registry.get(record.sessionId)?.lastAccessAt, '2026-11-06T22:05:00.000Z');
  assert.equal(store.find(record.sessionId)?.updatedAt, '2026-11-06T22:05:00.000Z');
  assert.equal(registry.get(record.sessionId)?.createdAt, FIXED_NOW);

  assert.throws(
    () => registry.touch('missing-session'),
    (error: unknown) => {
      assert.ok(error instanceof SessionNotFoundError);
      assert.equal(error.sessionId, 'missing-session');
      return true;
    },
  );
});

test('a touch whose store write fails is best effort and keeps the new in-memory clock', async (t) => {
  const store = new FailingUpsertStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-touch-')), 'sessions.json'),
  );
  const clock = isoClock();
  const { workspace, registry, project } = setup(store, clock.now);
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  store.failUpsert = true;
  clock.set('2026-11-06T22:10:00.000Z');

  assert.doesNotThrow(() => registry.touch(record.sessionId));
  assert.equal(registry.get(record.sessionId)?.lastAccessAt, '2026-11-06T22:10:00.000Z');
  // The durable timestamp could not be rewritten; the old one remains.
  assert.equal(store.find(record.sessionId)?.updatedAt, FIXED_NOW);
});

test('sweepIdle closes sessions idle past the TTL and leaves recent ones', async (t) => {
  const clock = isoClock();
  const store = makeStore();
  const { adapter, workspace, registry, project } = setup(store, clock.now);
  t.after(() => workspace.stop());

  const old = await registry.create(project);
  clock.set('2026-11-06T22:00:01.000Z');
  const fresh = await registry.create(project);

  clock.set('2026-11-06T22:00:02.000Z');
  const report = await registry.sweepIdle({ idleTtlMs: 1_500 });

  assert.deepEqual(report, {
    closed: [old.sessionId],
    skipped: [fresh.sessionId],
    failed: [],
  });
  assert.equal(registry.get(old.sessionId), undefined);
  assert.deepEqual(adapter.closed, [old.nativeId]);
  assert.deepEqual(
    registry.list().map((record) => record.sessionId),
    [fresh.sessionId],
  );
  assert.deepEqual(
    store.load().map((entry) => entry.conversationId),
    [fresh.sessionId],
  );
});

test('sweepIdle skips excluded, busy and invalid-timestamp sessions', async (t) => {
  const clock = isoClock();
  const { adapter, workspace, registry, project } = setup(undefined, clock.now);
  t.after(() => workspace.stop());

  // Busy first: its check is synchronous and must not be expired by the await
  // that closes the idle session later in the pass.
  const busy = await registry.create(project);
  await workspace.submit(busy.sessionId, 'hold');
  const idle = await registry.create(project);
  const excluded = await registry.create(project);
  assert.equal(registry.isBusy(busy.sessionId), true);

  const invalidStore = makeStore();
  invalidStore.upsert({
    conversationId: 'invalid-session',
    harness: 'dsh-acp',
    nativeId: 'invalid-native',
    projectId: project.id,
    projectDirectory: project.directory,
    updatedAt: 'not-a-timestamp',
  });
  const invalidHarness = rehydrate(invalidStore, project, clock.now);
  t.after(() => invalidHarness.workspace.stop());

  clock.set('2026-11-07T22:00:00.000Z');
  const report = await registry.sweepIdle({
    idleTtlMs: 1,
    exclude: new Set([excluded.sessionId]),
  });
  assert.deepEqual(report.closed, [idle.sessionId]);
  assert.deepEqual(report.skipped, [busy.sessionId, excluded.sessionId]);
  assert.deepEqual(report.failed, []);
  assert.equal(adapter.closed.length, 1);

  const invalidReport = await invalidHarness.registry.sweepIdle({
    idleTtlMs: 1,
    now: () => '2026-11-07T22:00:00.000Z',
  });
  assert.deepEqual(invalidReport, {
    closed: [],
    skipped: ['invalid-session'],
    failed: [],
  });
  assert.ok(invalidHarness.registry.get('invalid-session') !== undefined);
});

test('sweepIdle reports a close failure without aborting the pass', async (t) => {
  const clock = isoClock();
  const adapter = new SelectiveCloseFailureAdapter();
  const workspace = new Workspace(adapter);
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]), now: clock.now });
  t.after(() => workspace.stop());

  const failing = await registry.create(project);
  const closing = await registry.create(project);
  adapter.failNativeId = failing.nativeId;
  clock.set('2026-11-07T22:00:00.000Z');

  const report = await registry.sweepIdle({ idleTtlMs: 1 });

  // The first close fails and is kept; the second still closes.
  assert.deepEqual(report.closed, [closing.sessionId]);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.failed, [{ sessionId: failing.sessionId, error: 'close failed' }]);
  assert.equal(JSON.stringify(report).includes('NATIVE_CLOSE_SECRET'), false);
  assert.ok(registry.get(failing.sessionId) !== undefined);
  assert.equal(registry.get(closing.sessionId), undefined);
  assert.deepEqual(adapter.closed, [failing.nativeId, closing.nativeId]);
});

test('sweepIdle is a no-op for a disabled TTL and never writes the store', async (t) => {
  const clock = isoClock();
  const store = new FailingUpsertStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-sweep-')), 'sessions.json'),
  );
  const { adapter, workspace, registry, project } = setup(store, clock.now);
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  store.failUpsert = true;
  clock.set('2027-01-01T00:00:00.000Z');

  for (const idleTtlMs of [0, -1]) {
    const report = await registry.sweepIdle({ idleTtlMs });
    assert.deepEqual(report, { closed: [], skipped: [], failed: [] });
  }
  assert.ok(registry.get(record.sessionId) !== undefined);
  assert.deepEqual(adapter.closed, []);
});

test('sweepIdle uses an explicit pass clock over the registry clock', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  const report = await registry.sweepIdle({
    idleTtlMs: 1,
    now: () => '2026-11-06T22:00:01.000Z',
  });

  assert.deepEqual(report.closed, [record.sessionId]);
  assert.deepEqual(adapter.closed, [record.nativeId]);
});
