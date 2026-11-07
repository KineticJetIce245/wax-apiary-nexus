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

const FIXED_NOW = '2026-11-06T22:00:00.000Z';

/**
 * The shared FakeAdapter does not implement resume. This local subclass only
 * adds the parts this slice needs; the public fake is intentionally untouched.
 */
class ResumableFakeAdapter extends FakeAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    rename: false,
    resume: true,
  };
  readonly resumes: Array<{ readonly nativeId: string; readonly cwd: string }> = [];
  readonly createOptions: Array<ConversationOptions | undefined> = [];
  readonly closed: string[] = [];
  resumeGate: Promise<void> | undefined;
  resumeError: Error | undefined;
  closeError: Error | undefined;

  async resume(nativeId: string, cwd: string): Promise<void> {
    this.resumes.push({ nativeId, cwd });
    if (this.resumeGate !== undefined) {
      await this.resumeGate;
    }
    if (this.resumeError !== undefined) {
      throw this.resumeError;
    }
  }

  async createConversation(project: Project, options?: ConversationOptions): Promise<string> {
    this.createOptions.push(options === undefined ? undefined : { ...options });
    return super.createConversation(project, options);
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

function makeProject(): Project {
  return { id: `project-${Date.now()}`, directory: mkdtempSync(join(tmpdir(), 'wax-m3a-')) };
}

/** Returns the same native id for every create, to exercise duplicate checks. */
class SharedNativeAdapter extends FakeAdapter {
  readonly closed: string[] = [];
  closeError: Error | undefined;

  async createConversation(_project: Project, _options?: ConversationOptions): Promise<string> {
    return 'native-shared';
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

/** Store whose write path can be switched to fail after hydration. */
class FailingUpsertStore extends ConversationStore {
  failUpsert = false;

  override upsert(record: ConversationRecord): void {
    if (this.failUpsert) {
      throw new Error('store write failed');
    }
    super.upsert(record);
  }
}

interface Harness {
  readonly adapter: ResumableFakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
}

function setup(store?: ConversationStore): Harness {
  const adapter = new ResumableFakeAdapter();
  const workspace = new Workspace(adapter);
  const project = makeProject();
  const registry = new SessionRegistry({
    workspace,
    harness: 'dsh-acp',
    now: () => FIXED_NOW,
    ...(store === undefined ? {} : { store }),
  });
  return { adapter, workspace, registry, project };
}

function makeStore(): ConversationStore {
  return new ConversationStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-store-')), 'sessions.json'),
  );
}

/** A fresh process view: new adapter/workspace/registry over the same store. */
function rehydrate(
  store: ConversationStore,
  project: Project,
): Harness {
  const adapter = new ResumableFakeAdapter();
  const workspace = new Workspace(adapter);
  const registry = new SessionRegistry({
    workspace,
    harness: 'dsh-acp',
    now: () => FIXED_NOW,
    store,
  });
  return { adapter, workspace, registry, project };
}

function waitForExecutionSettled(workspace: Workspace, executionId: string): Promise<void> {
  const execution = workspace.getExecution(executionId);
  if (execution !== undefined && execution.state !== 'running') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = workspace.onEvent((event) => {
      if (event.type === 'execution/state' && event.executionId === executionId) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function makeDefinition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'registry-binding-test',
    nodes: {
      run: { kind: 'forager', config: { connection: 'codex', prompt: 'go' } },
    },
    edges: [],
  });
}

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
  assert.equal(record.model, 'deepseek-chat');
  assert.equal(record.reasoning, 'high');
  assert.equal(workspace.getConversation(record.sessionId)?.displayName, 'wax-session-apiary');
  assert.deepEqual(adapter.displayNames, ['wax-session-apiary']);
});

test('create rejects a duplicate native id and closes the new conversation', async (t) => {
  const adapter = new SharedNativeAdapter();
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({
    workspace,
    harness: 'codex',
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
  assert.equal(registry.has(first.sessionId), true);
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
  assert.equal(registry.has(record.sessionId), false);
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
  const registry = new SessionRegistry({ workspace, harness: 'codex' });

  const record = await registry.create(makeProject());

  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(Number.isNaN(Date.parse(record.createdAt)), false);
});

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
  assert.equal(record.model, 'deepseek-chat');
  assert.equal(record.reasoning, 'high');
  assert.equal(second.registry.list().length, 1);
  assert.equal(second.registry.has(created.sessionId), true);
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
});

test('skips hydrated records from another harness', async (t) => {
  const store = makeStore();
  const project = makeProject();
  store.upsert({
    conversationId: 'foreign-session',
    harness: 'codex',
    nativeId: 'foreign-native',
    projectId: project.id,
    projectDirectory: project.directory,
    updatedAt: FIXED_NOW,
  });

  const { adapter, workspace, registry } = rehydrate(store, project);
  t.after(() => workspace.stop());

  assert.equal(registry.get('foreign-session'), undefined);
  assert.equal(registry.list().length, 0);
  await assert.rejects(
    registry.ensureAttached('foreign-session'),
    (error: unknown) => error instanceof SessionNotFoundError,
  );
  assert.equal(adapter.resumes.length, 0);
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
  assert.equal(registry.has('session-old'), false);
  assert.deepEqual(store.load(), []);
  assert.deepEqual(adapter.closed, ['native-old']);
});
