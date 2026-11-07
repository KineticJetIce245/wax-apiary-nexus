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

const FIXED_NOW = '2026-11-06T22:00:00.000Z';

function makeProject(): Project {
  return {
    id: `project-${String(Date.now())}-${String(Math.random())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m3b-')),
  };
}

function makeStore(): ConversationStore {
  return new ConversationStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-instantiate-')), 'sessions.json'),
  );
}

function makeBindingStore(now: () => string = () => FIXED_NOW): GraphBindingStore {
  return new GraphBindingStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m5b-instantiate-bindings-')), 'graph-bindings.json'),
    { now },
  );
}

class FailingSetBindingStore extends GraphBindingStore {
  override set(_binding: ResolvedGraphBinding): void {
    throw new Error('graph binding store write failed');
  }
}

function foragerNode(prompt = 'go'): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'codex', prompt } };
}

function makeDefinition(nodes: Record<string, unknown>): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'instantiate-foragers-test',
    nodes,
    edges: [],
  });
}

function foragerOf(definition: CompositionDefinition, nodeId: string): ForagerNode {
  const node = definition.nodes.get(nodeId);
  if (node === undefined || node.kind !== 'forager') {
    throw new Error(`expected a forager node '${nodeId}'`);
  }
  return node;
}

function text(value: string): Value {
  return { kind: 'text', text: value };
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

function makeHarness(
  adapter: FakeAdapter = new FakeAdapter({ output: 'ok' }),
  harness = 'dsh-acp',
): {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
} {
  const workspace = new Workspace(adapter);
  const project = makeProject();
  const registry = new SessionRegistry({ workspace, harness, now: () => FIXED_NOW });
  return { adapter, workspace, registry, project };
}

class ReportedHarnessRegistry extends SessionRegistry {
  private readonly reportedHarness: string;

  constructor(options: ConstructorParameters<typeof SessionRegistry>[0], reportedHarness: string) {
    super(options);
    this.reportedHarness = reportedHarness;
  }

  override get harness(): string {
    return this.reportedHarness;
  }
}

class TrackingCloseAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
  }
}

/** FakeAdapter plus the resume capability needed for hydrated sessions. */
class ResumableAdapter extends FakeAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    rename: false,
    resume: true,
  };
  readonly resumes: Array<{ readonly nativeId: string; readonly cwd: string }> = [];
  resumeError: Error | undefined;

  async resume(nativeId: string, cwd: string): Promise<void> {
    this.resumes.push({ nativeId, cwd });
    if (this.resumeError !== undefined) {
      throw this.resumeError;
    }
  }
}

/** A registry whose record exists for validation but vanishes before attach. */
class VanishingRegistry extends SessionRegistry {
  override async ensureAttached(sessionId: string): Promise<SessionRecord> {
    throw new SessionNotFoundError(sessionId);
  }
}

class FlakyCreateAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];
  failCreateOn = 0;
  createCalls = 0;

  override async createConversation(
    project: Project,
    options?: ConversationOptions,
  ): Promise<string> {
    this.createCalls += 1;
    if (this.createCalls === this.failCreateOn) {
      throw new Error(`create failed on call ${String(this.createCalls)}`);
    }
    return super.createConversation(project, options);
  }

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
  }
}

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
    workspace,
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
      workspace,
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
      workspace,
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
        workspace,
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

test('a wrong harness rejects before any fresh session is created', async (t) => {
  const adapter = new FakeAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new ReportedHarnessRegistry(
    { workspace, harness: 'codex', now: () => FIXED_NOW },
    'dsh-acp',
  );
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
        fresh: { kind: 'fresh' },
      },
      registry,
      workspace,
      project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BindingValidationError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        ['wrong-harness'],
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
      workspace,
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
  const registry = new SessionRegistry({ workspace, harness: 'dsh-acp', now: () => FIXED_NOW });
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
    instantiateForagers({ definition, bindings, registry, workspace, project }),
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
  const registry = new SessionRegistry({ workspace, harness: 'dsh-acp', now: () => FIXED_NOW });
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
    instantiateForagers({ definition, bindings, registry, workspace, project }),
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
    workspace,
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
    workspace: firstWorkspace,
    harness: 'dsh-acp',
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({
    workspace,
    harness: 'dsh-acp',
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
    workspace,
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
    workspace: firstWorkspace,
    harness: 'dsh-acp',
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  adapter.resumeError = new Error('native resume failed');
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({
    workspace,
    harness: 'dsh-acp',
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
      workspace,
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
    workspace: firstWorkspace,
    harness: 'dsh-acp',
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new VanishingRegistry({
    workspace,
    harness: 'dsh-acp',
    now: () => FIXED_NOW,
    store,
  });
  const definition = makeDefinition({ reuse: foragerNode('reuse') });

  await assert.rejects(
    instantiateForagers({
      definition,
      bindings: { reuse: { kind: 'session', sessionId: existing.sessionId } },
      registry,
      workspace,
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
    workspace: firstWorkspace,
    harness: 'dsh-acp',
    now: () => FIXED_NOW,
    store,
  });
  const existing = await firstRegistry.create(project);
  await firstWorkspace.stop();

  const adapter = new ResumableAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({
    workspace,
    harness: 'dsh-acp',
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
      workspace,
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

test('fresh_once creates once, stores the mapping and reuses it on a second instantiation', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({ only: foragerNode('run {{input}}') });
  const options = {
    definition,
    graphId: 'once-graph',
    bindings: { only: { kind: 'fresh', mode: 'once' } } satisfies GraphBindings,
    registry,
    workspace,
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

test('fresh_always and an absent mode both create a new session without writing the store', async (t) => {
  const { adapter, workspace, registry, project } = makeHarness();
  t.after(() => workspace.stop());
  const bindingStore = makeBindingStore();
  const definition = makeDefinition({ only: foragerNode('run {{input}}') });

  const first = await instantiateForagers({
    definition,
    graphId: 'always-graph',
    bindings: { only: { kind: 'fresh', mode: 'always' } },
    registry,
    workspace,
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
    workspace,
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
    workspace,
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
      workspace,
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
    workspace,
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
        workspace,
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
    workspace: firstWorkspace,
    harness: 'dsh-acp',
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
    updatedAt: FIXED_NOW,
  });

  const adapter = new ResumableAdapter({ output: 'ok' });
  adapter.resumeError = new Error('native resume failed');
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const registry = new SessionRegistry({
    workspace,
    harness: 'dsh-acp',
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
      workspace,
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
  const registry = new SessionRegistry({ workspace, harness: 'dsh-acp', now: () => FIXED_NOW });
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
      workspace,
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
  const registry = new SessionRegistry({ workspace, harness: 'dsh-acp', now: () => FIXED_NOW });
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
      workspace,
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
  const registry = new SessionRegistry({ workspace, harness: 'dsh-acp', now: () => FIXED_NOW });
  const existing = await registry.create(project);
  const bindingStore = makeBindingStore();
  bindingStore.set({
    graphId: 'mixed-failure',
    nodeId: 'reuse',
    sessionId: existing.sessionId,
    harness: 'dsh-acp',
    projectId: project.id,
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
      workspace,
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
    updatedAt: FIXED_NOW,
  });
  const definition = makeDefinition({ only: foragerNode('run') });

  const instantiated = await instantiateForagers({
    definition,
    graphId: 'stale-harness',
    bindings: { only: { kind: 'fresh', mode: 'once' } },
    registry,
    workspace,
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
