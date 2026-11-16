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

test('resolves an existing session and a fresh session into two executors', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const existing = await registry.create(project, { displayName: 'existing-session' });
  const definition = makeDefinition({
    reuse: foragerNode('reuse {{input}}'),
    fresh: foragerNode('fresh {{input}}'),
  });
  const bindings: GraphBindings = {
    reuse: { kind: 'session', sessionId: existing.sessionId },
    fresh: { kind: 'fresh', model: 'deepseek-chat', reasoning: 'high' },
  };

  const instantiated = await instantiateForagers({
    definition,
    bindings,
    registry,
    project,
  });
  t.after(() => instantiated.dispose());

  assert.deepEqual([...instantiated.executors.keys()], ['reuse', 'fresh']);
  assert.deepEqual([...instantiated.sessions.keys()], ['reuse', 'fresh']);
  assert.equal(instantiated.sessions.get('reuse')?.sessionId, existing.sessionId);

  const fresh = instantiated.sessions.get('fresh');
  assert.ok(fresh !== undefined);
  assert.notEqual(fresh.sessionId, existing.sessionId);
  assert.notEqual(fresh.nativeId, existing.nativeId);
  assert.equal(fresh.harness, 'dsh-acp');
  assert.equal(fresh.projectId, project.id);
  assert.equal(fresh.projectDirectory, project.directory);
  assert.equal(fresh.model, 'deepseek-chat');
  assert.equal(fresh.reasoning, 'high');

  assert.ok(registry.get(fresh.sessionId) !== undefined);
  assert.ok(workspace.getConversation(fresh.sessionId) !== undefined);
  assert.equal(typeof instantiated.routing.execute, 'function');
  // Only the existing session was created before instantiation; the fresh
  // binding produced exactly one more conversation.
  assert.equal(registry.list().length, 2);
  assert.equal(adapter.displayNames.length, 2);
});

test('a missing binding rejects before creating any session', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const definition = makeDefinition({
    one: foragerNode('one'),
    two: foragerNode('two'),
  });

  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: { one: { kind: 'fresh' } },
      registry,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['missing-binding'],
      );
      return true;
    },
  );

  assert.equal(registry.list().length, 0);
  assert.equal(adapter.displayNames.length, 0);
});

test('two foragers on one session are rejected before any session is created', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const existing = await registry.create(project);
  const definition = makeDefinition({
    one: foragerNode('one'),
    two: foragerNode('two'),
  });

  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: {
        one: { kind: 'session', sessionId: existing.sessionId },
        two: { kind: 'session', sessionId: existing.sessionId },
      },
      registry,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['duplicate-session'],
      );
      return true;
    },
  );

  assert.equal(registry.list().length, 1);
  assert.equal(adapter.displayNames.length, 1);
});

test('a busy session is rejected before any fresh session is created', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const existing = await registry.create(project);
  const execution = await workspace.submit(existing.sessionId, 'hold');
  const settled = waitForExecutionSettled(workspace, execution.id);
  const definition = makeDefinition({
    reuse: foragerNode('reuse'),
    fresh: foragerNode('fresh'),
  });

  try {
    await assert.rejects(
      instantiateForagers({
        definition,
        bindings: {
          reuse: { kind: 'session', sessionId: existing.sessionId },
          fresh: { kind: 'fresh' },
        },
        registry,
        project,
      }),
      (error: unknown) => {
        assert.ok(error instanceof BindingValidationError);
        assert.deepEqual(
          error.issues.map((issue) => issue.code),
          ['busy-session'],
        );
        return true;
      },
    );

    // The fresh binding after the busy session never reached registry.create.
    assert.equal(registry.list().length, 1);
    assert.equal(adapter.displayNames.length, 1);
  } finally {
    await settled;
  }
  assert.equal(registry.isBusy(existing.sessionId), false);
});

test('a fresh binding with an unknown harness rejects before creating any session', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const existing = await registry.create(project);
  const definition = makeDefinition({
    reuse: foragerNode('reuse'),
    fresh: foragerNode('fresh'),
  });

  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: {
        reuse: { kind: 'session', sessionId: existing.sessionId },
        fresh: { kind: 'fresh', harness: 'unknown-harness' },
      },
      registry,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['unknown-harness'],
      );
      return true;
    },
  );

  assert.equal(registry.list().length, 1);
  assert.equal(adapter.displayNames.length, 1);
});

test('a session from another project rejects before any fresh session is created', async (t) => {
  const { adapter, workspace, registry, project: projectA } = makeHarness();
  t.after(() => workspace.stop());
  const projectB = makeProject();
  const existing = await registry.create(projectA);
  const definition = makeDefinition({
    reuse: foragerNode('reuse'),
    fresh: foragerNode('fresh'),
  });

  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: {
        reuse: { kind: 'session', sessionId: existing.sessionId },
        fresh: { kind: 'fresh' },
      },
      registry,
      project: projectB,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['wrong-project'],
      );
      return true;
    },
  );

  assert.equal(registry.list().length, 1);
  assert.equal(adapter.displayNames.length, 1);
});

test('a create failure mid-way closes only the fresh sessions created so far', async (t) => {
  const adapter = new FlakyCreateAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]), now: () => FIXED_NOW });
  const existing = await registry.create(project);
  // Existing session is create call 1, the first fresh is call 2; fail on the
  // second fresh so one new session was already registered when it happens.
  adapter.failCreateOn = 3;
  const definition = makeDefinition({
    'fresh-one': foragerNode('fresh one'),
    'fresh-two': foragerNode('fresh two'),
    reuse: foragerNode('reuse'),
  });
  const bindings: GraphBindings = {
    'fresh-one': { kind: 'fresh' },
    'fresh-two': { kind: 'fresh' },
    reuse: { kind: 'session', sessionId: existing.sessionId },
  };

  await assert.rejects(
    instantiateForagers({ definition, bindings, registry, project }),
    /create failed on call 3/,
  );

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get(existing.sessionId)?.sessionId, existing.sessionId);
  assert.ok(workspace.getConversation(existing.sessionId) !== undefined);
  assert.equal(adapter.displayNames.length, 2);
  // The already-created fresh session was closed; the existing one was not.
  assert.deepEqual(adapter.closedNativeIds, ['native-2']);
});

test('a stale session binding cleans up fresh sessions and keeps the existing record', async (t) => {
  const adapter = new TrackingCloseAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]), now: () => FIXED_NOW });
  const stale = await registry.create(project);
  // Close the conversation behind the registry's back: validation still sees a
  // live record, so instantiation tries the lazy attach. This fake cannot
  // resume, so the attach fails after cleanup starts.
  await workspace.closeConversation(stale.sessionId);
  // That manual close also reached the adapter; track only cleanups from the
  // instantiation attempt below.
  adapter.closedNativeIds.length = 0;
  const definition = makeDefinition({
    fresh: foragerNode('fresh'),
    stale: foragerNode('stale'),
  });
  const bindings: GraphBindings = {
    fresh: { kind: 'fresh' },
    stale: { kind: 'session', sessionId: stale.sessionId },
  };

  await assert.rejects(
    instantiateForagers({ definition, bindings, registry, project }),
    (error: unknown) => {
      assert.ok(error instanceof SessionBindingUnavailableError);
      assert.equal(error.nodeId, 'stale');
      assert.equal(error.sessionId, stale.sessionId);
      // The lazy attach is the recovery path for a missing conversation; this
      // adapter does not advertise resume, so that path fails.
      assert.equal(error.reason, 'attach-failed');
      return true;
    },
  );

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get(stale.sessionId)?.sessionId, stale.sessionId);
  // Only the fresh session created during this call was closed.
  assert.deepEqual(adapter.closedNativeIds, ['native-2']);
});

test('dispose releases routing and refuses further forager work', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const existing = await registry.create(project);
  const definition = makeDefinition({ reuse: foragerNode('reuse {{input}}') });
  const instantiated = await instantiateForagers({
    definition,
    bindings: { reuse: { kind: 'session', sessionId: existing.sessionId } },
    registry,
    project,
  });

  const output = await instantiated.routing.execute(foragerOf(definition, 'reuse'), text('one'));
  assert.deepEqual(output, text('ok'));
  assert.deepEqual(adapter.prompts, ['reuse one']);

  instantiated.dispose();
  instantiated.dispose();

  await assert.rejects(
    instantiated.routing.execute(foragerOf(definition, 'reuse'), text('two')),
    (error: unknown) => {
      assert.ok(error instanceof RoutingExecutorDisposedError);
      return true;
    },
  );
  assert.deepEqual(adapter.prompts, ['reuse one']);
  // Disposing executors does not close the session it was bound to.
  assert.ok(registry.get(existing.sessionId) !== undefined);
});

test('a hydrated session binding reattaches through ensureAttached and executes', async (t) => {
  const store = makeStore();
  const project = makeProject();
  const firstAdapter = new FakeAdapter({ output: 'ok' });
  const firstWorkspace = new Workspace(firstAdapter);
  const firstRegistry = new SessionRegistry({
    workspaces: new Map([['dsh-acp', firstWorkspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const definition = makeDefinition({ reuse: foragerNode('reuse {{input}}') });
  const bindings: GraphBindings = {
    reuse: { kind: 'session', sessionId: existing.sessionId },
  };

  // Hydration alone leaves the native conversation absent.
  assert.equal(workspace.getConversation(existing.sessionId), undefined);
  assert.equal(adapter.resumes.length, 0);

  const instantiated = await instantiateForagers({
    definition,
    bindings,
    registry,
    project,
  });
  t.after(() => instantiated.dispose());

  assert.deepEqual(adapter.resumes, [
    { nativeId: existing.nativeId, cwd: project.directory },
  ]);
  assert.equal(workspace.getConversation(existing.sessionId)?.nativeId, existing.nativeId);
  assert.equal(instantiated.sessions.get('reuse')?.sessionId, existing.sessionId);

  const output = await instantiated.routing.execute(foragerOf(definition, 'reuse'), text('one'));
  assert.deepEqual(output, text('ok'));
  assert.deepEqual(adapter.prompts, ['reuse one']);
  assert.equal(adapter.displayNames.length, 0);
  assert.equal(registry.list().length, 1);
});

test('an attach failure reports attach-failed and creates no fresh session', async (t) => {
  const store = makeStore();
  const project = makeProject();
  const firstAdapter = new FakeAdapter({ output: 'ok' });
  const firstWorkspace = new Workspace(firstAdapter);
  const firstRegistry = new SessionRegistry({
    workspaces: new Map([['dsh-acp', firstWorkspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  adapter.resumeError = new Error('native resume failed');
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const definition = makeDefinition({
    reuse: foragerNode('reuse'),
    fresh: foragerNode('fresh'),
  });

  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: {
        reuse: { kind: 'session', sessionId: existing.sessionId },
        fresh: { kind: 'fresh' },
      },
      registry,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionBindingUnavailableError);
      assert.equal(error.nodeId, 'reuse');
      assert.equal(error.sessionId, existing.sessionId);
      assert.equal(error.reason, 'attach-failed');
      return true;
    },
  );

  // The failed attach stays retryable: record and mapping are untouched.
  assert.ok(registry.get(existing.sessionId) !== undefined);
  assert.ok(store.find(existing.sessionId) !== undefined);
  // No fresh session was created after the failure, and no cleanup closed the
  // borrowed session.
  assert.equal(adapter.displayNames.length, 0);
  assert.equal(registry.list().length, 1);
  assert.equal(workspace.getConversation(existing.sessionId), undefined);
  assert.equal(adapter.resumes.length, 1);
});

test('a session that disappears after validation reports unknown-session', async (t) => {
  const store = makeStore();
  const project = makeProject();
  const firstAdapter = new FakeAdapter({ output: 'ok' });
  const firstWorkspace = new Workspace(firstAdapter);
  const firstRegistry = new SessionRegistry({
    workspaces: new Map([['dsh-acp', firstWorkspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new VanishingRegistry({
    workspaces: new Map([['dsh-acp', workspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const definition = makeDefinition({ reuse: foragerNode('reuse') });

  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: { reuse: { kind: 'session', sessionId: existing.sessionId } },
      registry,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionBindingUnavailableError);
      assert.equal(error.reason, 'unknown-session');
      assert.equal(error.sessionId, existing.sessionId);
      return true;
    },
  );
  assert.equal(adapter.resumes.length, 0);
});

test('validation does not attach hydrated sessions', async (t) => {
  const store = makeStore();
  const project = makeProject();
  const firstAdapter = new FakeAdapter({ output: 'ok' });
  const firstWorkspace = new Workspace(firstAdapter);
  const firstRegistry = new SessionRegistry({
    workspaces: new Map([['dsh-acp', firstWorkspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]),
    now: () => FIXED_NOW,
    store,
  });
  const definition = makeDefinition({
    one: foragerNode('one'),
    two: foragerNode('two'),
  });

  // Duplicate use of one session fails validation before instantiation, so the
  // lazy attach point must not have run.
  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: {
        one: { kind: 'session', sessionId: existing.sessionId },
        two: { kind: 'session', sessionId: existing.sessionId },
      },
      registry,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['duplicate-session'],
      );
      return true;
    },
  );

  assert.equal(adapter.resumes.length, 0);
  assert.equal(workspace.getConversation(existing.sessionId), undefined);
  assert.equal(registry.list().length, 1);
});
