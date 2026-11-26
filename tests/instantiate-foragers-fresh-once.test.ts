import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions } from '../src/adapters/harness.js';
import type { HarnessCapabilities } from '../src/adapters/harness.js';
import type { GraphBindings } from '../src/graph/binding.js';
import { GraphBindingStore, type ResolvedGraphBinding } from '../src/graph/binding-store.js';
import type { Project } from '../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type ForagerNode,
  type Value,
} from '../src/runtime/index.js';
import {
  BindingValidationError,
  instantiateForagers,
  SessionBindingUnavailableError,
} from '../src/session/instantiate-foragers.js';
import {
  RoutingExecutorDisposedError,
} from '../src/session/routing-executor.js';
import {
  SessionNotFoundError,
  SessionRegistry,
  type SessionRecord,
} from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { ConversationStore } from '../src/storage/conversation-store.js';
import { FakeAdapter } from './support/fake-adapter.js';

import {
  FIXED_NOW,
  makeProject,
  makeStore,
  makeBindingStore,
  FailingSetBindingStore,
  foragerNode,
  makeDefinition,
  foragerOf,
  text,
  waitForExecutionSettled,
  makeHarness,
  TrackingCloseAdapter,
  ResumableAdapter,
  VanishingRegistry,
  FlakyCreateAdapter,
} from './support/instantiate-foragers-fixtures.js';

test('fresh_once creates once, stores the mapping and reuses it on a second instantiation', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({ only: foragerNode('run {{message}}') });
  const options = {
    definition,
    graphId: 'once-graph',
    bindings: { only: { kind: 'fresh', mode: 'once' } } satisfies GraphBindings,
    registry,
    project,
    bindingStore,
  } as const;

  const first = await instantiateForagers(options);
  t.after(() => first.dispose());
  const firstSession = first.sessions.get('only');
  assert.ok(firstSession !== undefined);
  assert.deepEqual(first.createdSessionIds, [firstSession.sessionId]);
  assert.equal(adapter.displayNames.length, 1);

  const stored = bindingStore.get('once-graph', 'only');
  assert.ok(stored !== undefined);
  assert.equal(stored.sessionId, firstSession.sessionId);
  assert.equal(stored.harness, 'dsh-acp');
  assert.equal(stored.projectId, project.id);
  assert.equal(stored.projectDirectory, project.directory);
  assert.equal(stored.updatedAt, FIXED_NOW);

  const second = await instantiateForagers(options);
  t.after(() => second.dispose());
  assert.deepEqual(second.createdSessionIds, []);
  assert.equal(adapter.displayNames.length, 1);
  assert.equal(second.sessions.get('only')?.sessionId, firstSession.sessionId);
  assert.equal(bindingStore.get('once-graph', 'only')?.sessionId, firstSession.sessionId);
  assert.equal(registry.list().length, 1);
  assert.ok(workspace.getConversation(firstSession.sessionId) !== undefined);
});

test('fresh_once reuses only the exact project directory, not a shared projectId', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({ only: foragerNode('run') });
  const first = await instantiateForagers({
    definition,
    graphId: 'directory-graph',
    bindings: { only: { kind: 'fresh', mode: 'once' } },
    registry,
    project,
    bindingStore,
  });
  t.after(() => first.dispose());
  const firstSession = first.sessions.get('only');
  assert.ok(firstSession !== undefined);

  const sameIdOtherDirectory: Project = {
    id: project.id,
    directory: mkdtempSync(join(tmpdir(), 'wax-m3b-other-directory-')),
  };
  const second = await instantiateForagers({
    definition,
    graphId: 'directory-graph',
    bindings: { only: { kind: 'fresh', mode: 'once' } },
    registry,
    project: sameIdOtherDirectory,
    bindingStore,
  });
  t.after(() => second.dispose());
  const secondSession = second.sessions.get('only');
  assert.ok(secondSession !== undefined);
  assert.notEqual(secondSession.sessionId, firstSession.sessionId);
  assert.deepEqual(second.createdSessionIds, [secondSession.sessionId]);
  assert.equal(secondSession.projectId, project.id);
  assert.equal(secondSession.projectDirectory, sameIdOtherDirectory.directory);
  assert.equal(
    bindingStore.get('directory-graph', 'only')?.projectDirectory,
    sameIdOtherDirectory.directory,
  );
  assert.equal(adapter.displayNames.length, 2);
});

test('fresh_once reuses the same directory even when projectId changes', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({ only: foragerNode('run') });
  const first = await instantiateForagers({
    definition,
    graphId: 'directory-reuse-graph',
    bindings: { only: { kind: 'fresh', mode: 'once' } },
    registry,
    project,
    bindingStore,
  });
  t.after(() => first.dispose());
  const firstSession = first.sessions.get('only');
  assert.ok(firstSession !== undefined);

  const sameDirectoryNewId: Project = {
    id: 'different-project-id',
    directory: project.directory,
  };
  const second = await instantiateForagers({
    definition,
    graphId: 'directory-reuse-graph',
    bindings: { only: { kind: 'fresh', mode: 'once' } },
    registry,
    project: sameDirectoryNewId,
    bindingStore,
  });
  t.after(() => second.dispose());

  assert.deepEqual(second.createdSessionIds, []);
  assert.equal(second.sessions.get('only')?.sessionId, firstSession.sessionId);
  assert.equal(adapter.displayNames.length, 1);
  assert.equal(registry.list().length, 1);
  assert.equal(second.sessions.get('only')?.projectId, project.id);
  assert.equal(
    bindingStore.get('directory-reuse-graph', 'only')?.projectDirectory,
    project.directory,
  );
});

test('fresh_always and an absent mode both create a new session without writing the store', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({ only: foragerNode('run {{message}}') });

  const first = await instantiateForagers({
    definition,
    graphId: 'always-graph',
    bindings: { only: { kind: 'fresh', mode: 'always' } },
    registry,
    project,
    bindingStore,
  });
  t.after(() => first.dispose());
  const firstSession = first.sessions.get('only');
  assert.ok(firstSession !== undefined);
  assert.deepEqual(first.createdSessionIds, [firstSession.sessionId]);
  assert.deepEqual(bindingStore.snapshot(), []);

  const second = await instantiateForagers({
    definition,
    graphId: 'always-graph',
    bindings: { only: { kind: 'fresh', mode: 'always' } },
    registry,
    project,
    bindingStore,
  });
  t.after(() => second.dispose());
  const secondSession = second.sessions.get('only');
  assert.ok(secondSession !== undefined);
  assert.notEqual(secondSession.sessionId, firstSession.sessionId);
  assert.deepEqual(second.createdSessionIds, [secondSession.sessionId]);

  // An absent mode is the backward-compatible spelling of `always`.
  const legacy = await instantiateForagers({
    definition,
    graphId: 'legacy-graph',
    bindings: { only: { kind: 'fresh' } },
    registry,
    project,
    bindingStore,
  });
  t.after(() => legacy.dispose());
  const legacySession = legacy.sessions.get('only');
  assert.ok(legacySession !== undefined);
  assert.notEqual(legacySession.sessionId, secondSession.sessionId);
  assert.deepEqual(legacy.createdSessionIds, [legacySession.sessionId]);

  assert.equal(adapter.displayNames.length, 3);
  assert.deepEqual(bindingStore.snapshot(), []);
});

test('fresh_once without a binding store fails before creating a session', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const definition = makeDefinition({ only: foragerNode('run') });

  await assert.rejects(
    instantiateForagers({
      definition,
      graphId: 'missing-store',
      bindings: { only: { kind: 'fresh', mode: 'once' } },
      registry,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['invalid-binding'],
      );
      assert.equal(error.issues[0]?.nodeId, 'only');
      return true;
    },
  );

  assert.equal(adapter.displayNames.length, 0);
  assert.equal(registry.list().length, 0);
});

test('a stored fresh_once session that vanished is replaced and the mapping is rewritten', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({ only: foragerNode('run') });
  const options = {
    definition,
    graphId: 'vanished-graph',
    bindings: { only: { kind: 'fresh', mode: 'once' } } satisfies GraphBindings,
    registry,
    project,
    bindingStore,
  } as const;

  const first = await instantiateForagers(options);
  const firstSession = first.sessions.get('only');
  assert.ok(firstSession !== undefined);
  first.dispose();
  await registry.close(firstSession.sessionId);
  assert.equal(bindingStore.get('vanished-graph', 'only')?.sessionId, firstSession.sessionId);

  const second = await instantiateForagers(options);
  t.after(() => second.dispose());
  const secondSession = second.sessions.get('only');
  assert.ok(secondSession !== undefined);
  assert.notEqual(secondSession.sessionId, firstSession.sessionId);
  assert.deepEqual(second.createdSessionIds, [secondSession.sessionId]);
  assert.equal(bindingStore.get('vanished-graph', 'only')?.sessionId, secondSession.sessionId);
  assert.equal(adapter.displayNames.length, 2);
  assert.equal(registry.list().length, 1);
});

test('a busy stored fresh_once session reports busy without creating a replacement', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const existing = await registry.create(project);
  bindingStore.set({
    graphId: 'busy-graph',
    nodeId: 'reuse',
    sessionId: existing.sessionId,
    harness: 'dsh-acp',
    projectId: project.id,
    projectDirectory: project.directory,
    updatedAt: FIXED_NOW,
  });
  const execution = await workspace.submit(existing.sessionId, 'hold');
  const settled = waitForExecutionSettled(workspace, execution.id);
  const definition = makeDefinition({ reuse: foragerNode('reuse') });

  try {
    await assert.rejects(
      instantiateForagers({
        definition,
        graphId: 'busy-graph',
        bindings: { reuse: { kind: 'fresh', mode: 'once' } },
        registry,
        project,
        bindingStore,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionBindingUnavailableError);
        assert.equal(error.nodeId, 'reuse');
        assert.equal(error.sessionId, existing.sessionId);
        assert.equal(error.reason, 'busy');
        return true;
      },
    );

    assert.equal(adapter.displayNames.length, 1);
    assert.equal(registry.list().length, 1);
    assert.equal(bindingStore.get('busy-graph', 'reuse')?.sessionId, existing.sessionId);
  } finally {
    await settled;
  }
});

test('an attach failure on a stored fresh_once session reports attach-failed and keeps the mapping', async (t) => {
  const sessionStore = makeStore();
  const project = makeProject();
  const firstAdapter = new FakeAdapter({ output: 'ok' });
  const firstWorkspace = new Workspace(firstAdapter);
  const firstRegistry = new SessionRegistry({
    workspaces: new Map([['dsh-acp', firstWorkspace]]),
    now: () => FIXED_NOW,
    store: sessionStore,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const bindingStore = makeBindingStore();
  bindingStore.set({
    graphId: 'attach-graph',
    nodeId: 'reuse',
    sessionId: existing.sessionId,
    harness: 'dsh-acp',
    projectId: project.id,
    projectDirectory: project.directory,
    updatedAt: FIXED_NOW,
  });

  const adapter = new ResumableAdapter({ output: 'ok' });
  adapter.resumeError = new Error('native resume failed');
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]),
    now: () => FIXED_NOW,
    store: sessionStore,
  });
  const definition = makeDefinition({ reuse: foragerNode('reuse') });

  await assert.rejects(
    instantiateForagers({
      definition,
      graphId: 'attach-graph',
      bindings: { reuse: { kind: 'fresh', mode: 'once' } },
      registry,
      project,
      bindingStore,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionBindingUnavailableError);
      assert.equal(error.nodeId, 'reuse');
      assert.equal(error.sessionId, existing.sessionId);
      assert.equal(error.reason, 'attach-failed');
      return true;
    },
  );

  // The attach stays retryable: record, conversation state and mapping survive.
  assert.equal(adapter.displayNames.length, 0);
  assert.equal(adapter.resumes.length, 1);
  assert.ok(registry.get(existing.sessionId) !== undefined);
  assert.equal(workspace.getConversation(existing.sessionId), undefined);
  assert.equal(bindingStore.get('attach-graph', 'reuse')?.sessionId, existing.sessionId);
});

test('a store write failure closes the created session and leaves no record or mapping', async (t) => {
  const adapter = new TrackingCloseAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]), now: () => FIXED_NOW });
  const bindingStore = new FailingSetBindingStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m5b-failing-bindings-')), 'graph-bindings.json'),
  );
  const definition = makeDefinition({ only: foragerNode('run') });

  await assert.rejects(
    instantiateForagers({
      definition,
      graphId: 'write-failure',
      bindings: { only: { kind: 'fresh', mode: 'once' } },
      registry,
      project,
      bindingStore,
    }),
    /graph binding store write failed/,
  );

  assert.equal(adapter.displayNames.length, 1);
  assert.deepEqual(adapter.closedNativeIds, ['native-1']);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(bindingStore.snapshot(), []);
});

test('a mid-way failure removes only mappings created by this call', async (t) => {
  const adapter = new FlakyCreateAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]), now: () => FIXED_NOW });
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({
    one: foragerNode('one'),
    two: foragerNode('two'),
  });
  // The second fresh create fails after the first session and mapping exist.
  adapter.failCreateOn = 2;

  await assert.rejects(
    instantiateForagers({
      definition,
      graphId: 'cleanup-graph',
      bindings: {
        one: { kind: 'fresh', mode: 'once' },
        two: { kind: 'fresh', mode: 'once' },
      },
      registry,
      project,
      bindingStore,
    }),
    /create failed on call 2/,
  );

  assert.deepEqual(bindingStore.snapshot(), []);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(adapter.closedNativeIds, ['native-1']);
});

test('a later failure leaves a reused fresh_once session and its mapping untouched', async (t) => {
  const adapter = new FlakyCreateAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]), now: () => FIXED_NOW });
  const existing = await registry.create(project);
  const bindingStore = makeBindingStore();
  bindingStore.set({
    graphId: 'mixed-failure',
    nodeId: 'reuse',
    sessionId: existing.sessionId,
    harness: 'dsh-acp',
    projectId: project.id,
    projectDirectory: project.directory,
    updatedAt: FIXED_NOW,
  });
  const definition = makeDefinition({
    reuse: foragerNode('reuse'),
    new: foragerNode('new'),
  });
  // The manual session is create call 1; the new node is call 2 and fails.
  adapter.failCreateOn = 2;

  await assert.rejects(
    instantiateForagers({
      definition,
      graphId: 'mixed-failure',
      bindings: {
        reuse: { kind: 'fresh', mode: 'once' },
        new: { kind: 'fresh', mode: 'once' },
      },
      registry,
      project,
      bindingStore,
    }),
    /create failed on call 2/,
  );

  assert.deepEqual(adapter.closedNativeIds, []);
  assert.equal(adapter.displayNames.length, 1);
  assert.equal(registry.list().length, 1);
  assert.ok(registry.get(existing.sessionId) !== undefined);
  assert.ok(workspace.getConversation(existing.sessionId) !== undefined);
  assert.equal(bindingStore.get('mixed-failure', 'reuse')?.sessionId, existing.sessionId);
  assert.equal(bindingStore.get('mixed-failure', 'new'), undefined);
});

test('a stored mapping for another harness is replaced rather than attached', async (t) => {
  const adapter = new TrackingCloseAdapter({ output: 'ok' });
  const { workspace, registry, project } = makeHarness(adapter);
  t.after(() => workspace.stop());
  const existing = await registry.create(project);
  const bindingStore = makeBindingStore();
  bindingStore.set({
    graphId: 'stale-harness',
    nodeId: 'only',
    sessionId: existing.sessionId,
    harness: 'codex',
    projectId: project.id,
    projectDirectory: project.directory,
    updatedAt: FIXED_NOW,
  });
  const definition = makeDefinition({ only: foragerNode('run') });

  const instantiated = await instantiateForagers({
    definition,
    graphId: 'stale-harness',
    bindings: { only: { kind: 'fresh', mode: 'once' } },
    registry,
    project,
    bindingStore,
  });
  t.after(() => instantiated.dispose());

  const reused = instantiated.sessions.get('only');
  assert.ok(reused !== undefined);
  assert.notEqual(reused.sessionId, existing.sessionId);
  assert.deepEqual(instantiated.createdSessionIds, [reused.sessionId]);
  assert.equal(bindingStore.get('stale-harness', 'only')?.sessionId, reused.sessionId);
  assert.equal(adapter.displayNames.length, 2);
  // The stale target is not attached or closed by this call.
  assert.equal(registry.get(existing.sessionId)?.sessionId, existing.sessionId);
  assert.deepEqual(adapter.closedNativeIds, []);
});
