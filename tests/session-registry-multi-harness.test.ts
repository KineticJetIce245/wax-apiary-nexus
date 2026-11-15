import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions, HarnessCapabilities } from '../src/adapters/harness.js';
import type { Project } from '../src/project/kernel.js';
import {
  SessionAttachError,
  SessionBusyError,
  SessionRegistry,
  UnknownHarnessError,
} from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import {
  ConversationStore,
  type ConversationRecord,
} from '../src/storage/conversation-store.js';
import { FakeAdapter } from './support/fake-adapter.js';

const FIXED_NOW = '2026-11-06T22:00:00.000Z';

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

  override async createConversation(
    project: Project,
    options?: ConversationOptions,
  ): Promise<string> {
    this.createOptions.push(options === undefined ? undefined : { ...options });
    return super.createConversation(project, options);
  }

  async resume(nativeId: string, cwd: string): Promise<void> {
    this.resumes.push({ nativeId, cwd });
  }

  override async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
  }
}

function makeProject(): Project {
  return {
    id: `project-${String(Date.now())}-${String(Math.random())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9a-registry-')),
  };
}

function makeStore(): ConversationStore {
  return new ConversationStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m9a-registry-store-')), 'sessions.json'),
  );
}

interface MultiHarness {
  readonly codex: ResumableFakeAdapter;
  readonly dsh: ResumableFakeAdapter;
  readonly codexWorkspace: Workspace;
  readonly dshWorkspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly store: ConversationStore;
}

function makeMultiHarness(now: () => string = () => FIXED_NOW): MultiHarness {
  const codex = new ResumableFakeAdapter();
  const dsh = new ResumableFakeAdapter();
  const codexWorkspace = new Workspace(codex);
  const dshWorkspace = new Workspace(dsh);
  const project = makeProject();
  const store = makeStore();
  const registry = new SessionRegistry({
    workspaces: new Map([
      ['codex', codexWorkspace],
      ['dsh', dshWorkspace],
    ]),
    now,
    store,
  });
  return { codex, dsh, codexWorkspace, dshWorkspace, registry, project, store };
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

test('create requires a harness in multi-workspace mode and routes each record', async (t) => {
  const harness = makeMultiHarness();
  const { codex, dsh, codexWorkspace, dshWorkspace, registry, project } = harness;
  t.after(async () => {
    await codexWorkspace.stop();
    await dshWorkspace.stop();
  });

  assert.deepEqual(registry.harnesses(), ['codex', 'dsh']);
  assert.equal(registry.workspaceFor('dsh'), dshWorkspace);

  await assert.rejects(
    registry.create(project),
    (error: unknown) => error instanceof UnknownHarnessError,
  );
  await assert.rejects(
    registry.create(project, { harness: 'unknown' }),
    (error: unknown) => {
      assert.ok(error instanceof UnknownHarnessError);
      assert.equal(error.harness, 'unknown');
      return true;
    },
  );
  assert.throws(() => registry.workspaceFor('unknown'), UnknownHarnessError);

  const dshSession = await registry.create(project, { harness: 'dsh' });
  const codexSession = await registry.create(project, { harness: 'codex' });

  assert.equal(dshSession.harness, 'dsh');
  assert.equal(codexSession.harness, 'codex');
  // Native ids are per-harness: two fakes may both report native-1.
  assert.equal(dshSession.nativeId, 'native-1');
  assert.equal(codexSession.nativeId, 'native-1');
  assert.equal(registry.workspaceFor(dshSession.harness), dshWorkspace);
  assert.equal(registry.workspaceFor(codexSession.harness), codexWorkspace);
  assert.ok(dshWorkspace.getConversation(dshSession.sessionId) !== undefined);
  assert.equal(codexWorkspace.getConversation(dshSession.sessionId), undefined);
  assert.ok(codexWorkspace.getConversation(codexSession.sessionId) !== undefined);
  assert.equal(dshWorkspace.getConversation(codexSession.sessionId), undefined);

  await registry.close(dshSession.sessionId);
  assert.deepEqual(dsh.closed, [dshSession.nativeId]);
  assert.deepEqual(codex.closed, []);
  assert.equal(registry.get(dshSession.sessionId), undefined);
  assert.ok(registry.get(codexSession.sessionId) !== undefined);

  // Resuming an old native id uses the same explicit-harness routing.
  await assert.rejects(registry.resume(project, 'unrouted-native'), UnknownHarnessError);
  const resumed = await registry.resume(project, 'dsh-native-old', {
    harness: 'dsh',
    sessionId: 'dsh-resumed',
  });
  assert.equal(resumed.harness, 'dsh');
  assert.equal(registry.workspaceFor(resumed.harness), dshWorkspace);
  assert.deepEqual(dsh.resumes, [
    { nativeId: 'dsh-native-old', cwd: project.directory },
  ]);
  assert.deepEqual(codex.resumes, []);
});

test('hydrates and attaches records for multiple harnesses', async (t) => {
  const store = makeStore();
  const project = makeProject();
  const records: ConversationRecord[] = [
    {
      conversationId: 'codex-session',
      harness: 'codex',
      nativeId: 'codex-native',
      projectId: project.id,
      projectDirectory: project.directory,
      updatedAt: FIXED_NOW,
    },
    {
      conversationId: 'dsh-session',
      harness: 'dsh',
      nativeId: 'dsh-native',
      projectId: project.id,
      projectDirectory: project.directory,
      updatedAt: FIXED_NOW,
    },
    {
      conversationId: 'ghost-session',
      harness: 'ghost',
      nativeId: 'ghost-native',
      projectId: project.id,
      projectDirectory: project.directory,
      updatedAt: FIXED_NOW,
    },
  ];
  for (const record of records) {
    store.upsert(record);
  }

  const codex = new ResumableFakeAdapter();
  const dsh = new ResumableFakeAdapter();
  const codexWorkspace = new Workspace(codex);
  const dshWorkspace = new Workspace(dsh);
  t.after(async () => {
    await codexWorkspace.stop();
    await dshWorkspace.stop();
  });
  const registry = new SessionRegistry({
    workspaces: new Map([
      ['codex', codexWorkspace],
      ['dsh', dshWorkspace],
    ]),
    store,
    now: () => FIXED_NOW,
  });

  // Hydration keeps every harness, including one this process cannot route.
  assert.deepEqual(
    registry.list().map((record) => record.harness),
    ['codex', 'dsh', 'ghost'],
  );
  assert.equal(registry.workspaceFor('codex'), codexWorkspace);
  assert.equal(registry.workspaceFor('dsh'), dshWorkspace);

  const codexRecord = await registry.ensureAttached('codex-session');
  const dshRecord = await registry.ensureAttached('dsh-session');
  assert.equal(codexRecord.nativeId, 'codex-native');
  assert.equal(dshRecord.nativeId, 'dsh-native');
  assert.deepEqual(codex.resumes, [
    { nativeId: 'codex-native', cwd: project.directory },
  ]);
  assert.deepEqual(dsh.resumes, [
    { nativeId: 'dsh-native', cwd: project.directory },
  ]);
  assert.ok(codexWorkspace.getConversation('codex-session') !== undefined);
  assert.ok(dshWorkspace.getConversation('dsh-session') !== undefined);

  await assert.rejects(
    registry.ensureAttached('ghost-session'),
    (error: unknown) => {
      assert.ok(error instanceof SessionAttachError);
      assert.ok(error.cause instanceof UnknownHarnessError);
      return true;
    },
  );
  assert.throws(
    () => registry.workspaceFor('ghost'),
    UnknownHarnessError,
  );
  // The unroutable record survives so a later process with that harness can
  // still attach it.
  assert.equal(registry.get('ghost-session')?.harness, 'ghost');
});

test('isBusy and close route through the record harness', async (t) => {
  const { codex, dsh, codexWorkspace, dshWorkspace, registry, project } =
    makeMultiHarness();
  t.after(async () => {
    await codexWorkspace.stop();
    await dshWorkspace.stop();
  });

  const codexSession = await registry.create(project, { harness: 'codex' });
  const dshSession = await registry.create(project, { harness: 'dsh' });
  const execution = await codexWorkspace.submit(codexSession.sessionId, 'hold');
  const settled = waitForExecutionSettled(codexWorkspace, execution.id);

  try {
    assert.equal(registry.isBusy(codexSession.sessionId), true);
    assert.equal(registry.isBusy(dshSession.sessionId), false);

    // The busy codex session does not block closing the idle dsh session.
    await registry.close(dshSession.sessionId);
    assert.deepEqual(dsh.closed, [dshSession.nativeId]);
    assert.deepEqual(codex.closed, []);

    await assert.rejects(
      registry.close(codexSession.sessionId),
      (error: unknown) => {
        assert.ok(error instanceof SessionBusyError);
        assert.equal(error.sessionId, codexSession.sessionId);
        return true;
      },
    );
  } finally {
    await settled;
  }

  await registry.close(codexSession.sessionId);
  assert.deepEqual(codex.closed, [codexSession.nativeId]);
});

test('sweepIdle closes each harness through its own workspace', async (t) => {
  let current = FIXED_NOW;
  const harness = makeMultiHarness(() => current);
  const { codex, dsh, codexWorkspace, dshWorkspace, registry, project } = harness;
  t.after(async () => {
    await codexWorkspace.stop();
    await dshWorkspace.stop();
  });

  const codexSession = await registry.create(project, { harness: 'codex' });
  const dshSession = await registry.create(project, { harness: 'dsh' });

  current = '2026-11-07T22:00:00.000Z';
  const report = await registry.sweepIdle({ idleTtlMs: 1_000 });

  assert.deepEqual(report, {
    closed: [codexSession.sessionId, dshSession.sessionId],
    skipped: [],
    failed: [],
  });
  assert.deepEqual(codex.closed, [codexSession.nativeId]);
  assert.deepEqual(dsh.closed, [dshSession.nativeId]);
  assert.equal(registry.list().length, 0);
});

test('a single-workspace registry uses its only harness when create omits one', async (t) => {
  const adapter = new ResumableFakeAdapter();
  const workspace = new Workspace(adapter);
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]),
    now: () => FIXED_NOW,
  });
  t.after(() => workspace.stop());

  assert.deepEqual(registry.harnesses(), ['dsh-acp']);
  assert.equal(registry.workspaceFor('dsh-acp'), workspace);

  const record = await registry.create(project);
  assert.equal(record.harness, 'dsh-acp');
  assert.equal(registry.workspaceFor(record.harness), workspace);
  assert.ok(workspace.getConversation(record.sessionId) !== undefined);
  await assert.rejects(registry.create(project, { harness: 'codex' }), UnknownHarnessError);
});
