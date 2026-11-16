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

test('create records the conversation identity and injected metadata', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project, {
    displayName: 'wax-session-apiary',
    model: 'deepseek-chat',
    reasoning: 'high',
  });

  assert.ok(record.sessionId.length > 0);
  assert.notEqual(record.sessionId, record.nativeId);
  assert.equal(record.nativeId, 'native-1');
  assert.equal(record.harness, 'dsh-acp');
  assert.equal(record.projectId, project.id);
  assert.equal(record.projectDirectory, project.directory);
  assert.equal(record.displayName, 'wax-session-apiary');
  assert.equal(record.createdAt, FIXED_NOW);
  assert.equal(record.lastAccessAt, FIXED_NOW);
  assert.equal(record.model, 'deepseek-chat');
  assert.equal(record.reasoning, 'high');
  assert.equal(workspace.getConversation(record.sessionId)?.displayName, 'wax-session-apiary');
  assert.deepEqual(adapter.displayNames, ['wax-session-apiary']);
});

test('create rejects a duplicate native id and closes the new conversation', async (t) => {
  const adapter = new SharedNativeAdapter();
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({ workspaces: new Map([['codex', workspace]]),
    now: () => FIXED_NOW,
  });
  const project = makeProject();

  const first = await registry.create(project);
  assert.equal(first.nativeId, 'native-shared');

  await assert.rejects(registry.create(project), (error: unknown) => {
    assert.ok(error instanceof SessionAlreadyRegisteredError);
    assert.equal(error.nativeId, 'native-shared');
    return true;
  });
  assert.equal(registry.list().length, 1);
  assert.ok(registry.get(first.sessionId) !== undefined);
  assert.ok(workspace.getConversation(first.sessionId) !== undefined);
  // The duplicate conversation was closed through the workspace; the adapter
  // sees a close for its native id (proving the WAX id, not nativeId, was used).
  assert.deepEqual(adapter.closed, ['native-shared']);

  // Best effort: a failing cleanup must not mask the duplicate rejection or
  // register the second conversation.
  adapter.closeError = new Error('cleanup failed');
  await assert.rejects(registry.create(project), SessionAlreadyRegisteredError);
  assert.equal(registry.list().length, 1);
  assert.equal(adapter.closed.length, 2);
});

test('get and list return snapshots that cannot mutate the registry', async (t) => {
  const { workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const created = await registry.create(project);
  const first = registry.get(created.sessionId);
  const second = registry.get(created.sessionId);
  assert.ok(first !== undefined && second !== undefined);
  assert.notEqual(first, second);

  Reflect.set(first, 'displayName', 'tampered');
  Reflect.set(first, 'model', 'tampered-model');
  assert.equal(registry.get(created.sessionId)?.displayName, 'native-1');
  assert.equal(registry.get(created.sessionId)?.model, undefined);

  const listed = registry.list() as SessionRecord[];
  assert.equal(listed.length, 1);
  Reflect.set(listed[0] as object, 'nativeId', 'tampered-native');
  listed.push({ ...created, sessionId: 'injected' });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]?.nativeId, 'native-1');
});

test('isBusy follows an execution from submit to terminal state', async (t) => {
  const { workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  assert.equal(registry.isBusy(record.sessionId), false);
  assert.equal(registry.isBusy('unknown-session'), false);

  const execution = await workspace.submit(record.sessionId, 'work');
  assert.equal(registry.isBusy(record.sessionId), true);
  assert.equal(registry.isBusy('unknown-session'), false);

  await waitForExecutionSettled(workspace, execution.id);
  assert.equal(registry.isBusy(record.sessionId), false);
  assert.equal(workspace.getExecution(execution.id)?.state, 'completed');
});

test('resume reattaches a native id and records the preserved WAX id', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.resume(project, 'native-old', {
    sessionId: 'session-old',
    model: 'deepseek-reasoner',
    reasoning: 'low',
  });

  assert.equal(record.sessionId, 'session-old');
  assert.equal(record.nativeId, 'native-old');
  // Workspace.resumeConversation names the conversation after the native id.
  assert.equal(record.displayName, 'native-old');
  assert.equal(record.harness, 'dsh-acp');
  assert.equal(record.projectId, project.id);
  assert.equal(record.projectDirectory, project.directory);
  assert.equal(record.createdAt, FIXED_NOW);
  assert.equal(record.lastAccessAt, FIXED_NOW);
  assert.equal(record.model, 'deepseek-reasoner');
  assert.equal(record.reasoning, 'low');
  assert.deepEqual(adapter.resumes, [{ nativeId: 'native-old', cwd: project.directory }]);
  assert.equal(workspace.getConversation('session-old')?.nativeId, 'native-old');

  await assert.rejects(
    registry.resume(project, 'native-old'),
    (error: unknown) => {
      assert.ok(error instanceof SessionAlreadyRegisteredError);
      assert.equal(error.nativeId, 'native-old');
      return true;
    },
  );
  assert.equal(adapter.resumes.length, 1);
  assert.equal(registry.list().length, 1);
});

test('a concurrent resume of the same native id registers exactly one session', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  let releaseResume!: () => void;
  adapter.resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });

  const first = registry.resume(project, 'native-race');
  const second = registry.resume(project, 'native-race');
  const secondOutcome = second.then(
    (record) => ({ status: 'resolved' as const, record }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );

  try {
    // Both calls run synchronously up to their first await: the first call has
    // already reached the adapter, while the second must be refused by the
    // in-flight native-id reservation before it can call the adapter.
    assert.equal(adapter.resumes.length, 1);
    const outcome = await secondOutcome;
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.ok(outcome.error instanceof SessionAlreadyRegisteredError);
      assert.equal(outcome.error.nativeId, 'native-race');
    }
  } finally {
    releaseResume();
  }

  const record = await first;
  assert.equal(record.nativeId, 'native-race');
  assert.equal(adapter.resumes.length, 1);
  assert.equal(registry.list().length, 1);
});

test('close removes an idle session from both the registry and the workspace', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  assert.ok(workspace.getConversation(record.sessionId) !== undefined);

  await registry.close(record.sessionId);

  assert.equal(workspace.getConversation(record.sessionId), undefined);
  assert.equal(registry.get(record.sessionId), undefined);
  assert.equal(registry.get(record.sessionId), undefined);
  assert.deepEqual(adapter.closed, [record.nativeId]);
});

test('close rejects an unknown session', async (t) => {
  const { adapter, workspace, registry } = setup();
  t.after(() => workspace.stop());

  await assert.rejects(
    registry.close('missing-session'),
    (error: unknown) => {
      assert.ok(error instanceof SessionNotFoundError);
      assert.equal(error.sessionId, 'missing-session');
      return true;
    },
  );
  assert.equal(adapter.closed.length, 0);
});

test('close refuses a busy session and keeps the record', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  const execution = await workspace.submit(record.sessionId, 'working');
  const settled = waitForExecutionSettled(workspace, execution.id);

  await assert.rejects(
    registry.close(record.sessionId),
    (error: unknown) => {
      assert.ok(error instanceof SessionBusyError);
      assert.equal(error.sessionId, record.sessionId);
      return true;
    },
  );
  assert.ok(registry.get(record.sessionId) !== undefined);
  assert.ok(workspace.getConversation(record.sessionId) !== undefined);
  assert.equal(adapter.closed.length, 0);

  await settled;
  await registry.close(record.sessionId);
  assert.equal(registry.get(record.sessionId), undefined);
  assert.deepEqual(adapter.closed, [record.nativeId]);
});

test('close keeps the record when the workspace close fails', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  adapter.closeError = new Error('native close failed');

  await assert.rejects(registry.close(record.sessionId), /native close failed/);
  assert.ok(registry.get(record.sessionId) !== undefined);
  assert.ok(workspace.getConversation(record.sessionId) !== undefined);

  adapter.closeError = undefined;
  await registry.close(record.sessionId);
  assert.equal(registry.get(record.sessionId), undefined);
});

test('validateBindings against the registry creates no session and tracks busy', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project);
  const definition = makeDefinition();
  const bindings: GraphBindings = {
    run: { kind: 'session', sessionId: record.sessionId },
  };

  const clean = validateBindings(definition, bindings, registry);
  assert.deepEqual(clean, { ok: true, issues: [] });

  const execution = await workspace.submit(record.sessionId, 'busy');
  const busy = validateBindings(definition, bindings, registry);
  assert.equal(busy.ok, false);
  assert.deepEqual(busy.issues.map((issue) => issue.code), ['busy-session']);

  await waitForExecutionSettled(workspace, execution.id);
  assert.deepEqual(validateBindings(definition, bindings, registry), { ok: true, issues: [] });

  const unknown = validateBindings(
    definition,
    { run: { kind: 'session', sessionId: 'session-missing' } },
    registry,
  );
  assert.deepEqual(unknown.issues.map((issue) => issue.code), ['unknown-session']);

  // Validation only read through BindingLookup: no second conversation was
  // created and the registry still holds exactly the original record.
  assert.equal(registry.list().length, 1);
  assert.equal(adapter.createOptions.length, 1);
  assert.equal(adapter.displayNames.length, 1);
});

test('model and reasoning stay in the record and are not sent to the adapter', async (t) => {
  const { adapter, workspace, registry, project } = setup();
  t.after(() => workspace.stop());

  const record = await registry.create(project, {
    displayName: 'metadata-session',
    model: 'deepseek-chat',
    reasoning: 'high',
  });

  const captured = adapter.createOptions[0];
  assert.ok(captured !== undefined);
  // ConversationOptions currently has only displayName; pass-through of model
  // or reasoning would be silently dropped by the adapter contract.
  assert.deepEqual(Object.keys(captured), ['displayName']);
  assert.equal(captured.displayName, 'metadata-session');
  assert.equal('model' in captured, false);
  assert.equal('reasoning' in captured, false);
  assert.equal(record.model, 'deepseek-chat');
  assert.equal(record.reasoning, 'high');
});

test('createdAt defaults to an ISO timestamp when no clock is injected', async (t) => {
  const adapter = new ResumableFakeAdapter();
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({ workspaces: new Map([['codex', workspace]]) });

  const record = await registry.create(makeProject());

  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(Number.isNaN(Date.parse(record.createdAt)), false);
});
