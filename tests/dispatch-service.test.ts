import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  DispatchConflictError,
  DispatchExecutionError,
  DispatchService,
  DispatchSessionNotFoundError,
  DispatchTimeoutError,
} from '../src/b/dispatch-service.js';
import { GraphHost } from '../src/daemon/graph-host.js';
import type { GraphStatus, LoadGraphOptions } from '../src/daemon/graph-host.js';
import { LiveHiveCatalog } from '../src/daemon/live-hive-catalog.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { HoneyStore } from '../src/storage/honey.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';

interface Harness {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly graphHost: RecordingGraphHost;
  readonly service: DispatchService;
}

/** Records graph ids so a test can prove the dispatch graph was unloaded. */
class RecordingGraphHost extends GraphHost {
  readonly loadedIds: string[] = [];

  override loadGraph(options: LoadGraphOptions): Promise<GraphStatus> {
    this.loadedIds.push(options.definition.id);
    return super.loadGraph(options);
  }
}

function assertReleased(host: RecordingGraphHost): void {
  assert.equal(host.loadedIds.length, 1);
  const graphId = host.loadedIds[0];
  assert.ok(graphId !== undefined);
  assert.equal(host.statusOf(graphId), undefined);
}

function setup(
  t: TestContext,
  adapterOptions: FakeAdapterOptions = {},
  withDefaultProject = true,
): Harness {
  return setupWithAdapter(t, new FakeAdapter(adapterOptions), withDefaultProject);
}

function setupWithAdapter(
  t: TestContext,
  adapter: FakeAdapter,
  withDefaultProject = true,
): Harness {
  const workspace = new Workspace(adapter);
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const graphHost = new RecordingGraphHost({ registry });
  t.after(async () => {
    await graphHost.dispose();
    await workspace.stop();
  });
  const project: Project = {
    id: 'dispatch-project',
    directory: mkdtempSync(join(tmpdir(), 'wax-dispatch-')),
  };
  const service = new DispatchService({
    registry,
    graphHost,
    ...(withDefaultProject ? { defaultProject: project } : {}),
  });
  return { adapter, workspace, registry, project, graphHost, service };
}

/**
 * Never emits a terminal event on its own. Its cancel settles the execution the
 * way a cooperative native harness would, so the timeout cleanup path can be
 * observed instead of leaving a graph active forever.
 */
class HoldingAdapter extends FakeAdapter {
  private heldExecutionId: string | undefined;

  override async submit(
    _nativeId: string,
    executionId: string,
    text: string,
  ): Promise<void> {
    this.prompts.push(text);
    this.heldExecutionId = executionId;
  }

  override async cancel(_nativeId: string): Promise<void> {
    const executionId = this.heldExecutionId;
    if (executionId === undefined) {
      return;
    }
    this.heldExecutionId = undefined;
    this.emit({ type: 'execution/cancelled', executionId });
  }
}

test('dispatch fresh creates one temporary session and returns its output', async (t) => {
  const harness = setup(t, { output: 'answer-42' });
  const result = await harness.service.dispatch('hello', {
    sessionParams: { harness: 'fake', model: 'm1', reasoning: 'high' },
  });

  assert.deepEqual(result, { output: 'answer-42', sessionId: result.sessionId });
  assert.equal(harness.adapter.prompts.length, 1);
  assert.equal(harness.adapter.prompts[0], 'hello');
  const record = harness.registry.get(result.sessionId);
  assert.ok(record !== undefined);
  assert.equal(record.harness, 'fake');
  assert.equal(record.model, 'm1');
  assert.equal(record.reasoning, 'high');
  assert.equal(harness.registry.list().length, 1);
  assert.deepEqual(readdirSync(harness.project.directory), []);
  // The ephemeral graph is not left loaded or listed.
  assertReleased(harness.graphHost);
});

test('dispatch graph is ephemeral: no catalog, Honey, live.json or list entry', async (t) => {
  const adapter = new FakeAdapter({ output: 'ephemeral-output' });
  const workspace = new Workspace(adapter);
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-dispatch-state-'));
  const catalogPath = join(stateRoot, 'live-catalog.json');
  const catalog = new LiveHiveCatalog(catalogPath);
  let honeyRequests = 0;
  const graphHost = new RecordingGraphHost({
    registry,
    catalog,
    honeyForGraph: (graphId) => {
      honeyRequests += 1;
      return HoneyStore.forComposition(stateRoot, 'apiary', graphId);
    },
  });
  t.after(async () => {
    await graphHost.dispose();
    await workspace.stop();
  });
  const project: Project = {
    id: 'ephemeral-project',
    directory: mkdtempSync(join(tmpdir(), 'wax-dispatch-project-')),
  };
  const service = new DispatchService({ registry, graphHost, defaultProject: project });

  const result = await service.dispatch('hello', { sessionParams: { harness: 'fake' } });

  assert.equal(result.output, 'ephemeral-output');
  assert.equal(honeyRequests, 0);
  assert.deepEqual(catalog.list(), []);
  assert.equal(existsSync(catalogPath), false);
  assert.equal(existsSync(join(stateRoot, 'apiaries')), false);
  assert.equal(existsSync(join(stateRoot, 'lives')), false);
  assertReleased(graphHost);
});

test('dispatch explicit session reuses it and uses its own harness metadata', async (t) => {
  const harness = setup(t, { output: 'reused' });
  const session = await harness.registry.create(harness.project, {
    harness: 'fake',
    model: 'session-model',
    reasoning: 'session-reasoning',
  });

  const result = await harness.service.dispatch('continue', {
    sessionId: session.sessionId,
    sessionParams: {
      harness: 'fake',
      model: 'session-model',
      reasoning: 'session-reasoning',
    },
  });

  assert.deepEqual(result, { output: 'reused', sessionId: session.sessionId });
  assert.equal(harness.registry.list().length, 1);
  assert.equal(harness.adapter.prompts[0], 'continue');
  assertReleased(harness.graphHost);
});

test('dispatch explicit session rejects conflicting creation parameters', async (t) => {
  const harness = setup(t, { output: 'ok' });
  const session = await harness.registry.create(harness.project, {
    harness: 'fake',
    model: 'session-model',
    reasoning: 'session-reasoning',
  });

  await assert.rejects(
    harness.service.dispatch('x', {
      sessionId: session.sessionId,
      sessionParams: { harness: 'other' },
    }),
    DispatchConflictError,
  );
  await assert.rejects(
    harness.service.dispatch('x', {
      sessionId: session.sessionId,
      sessionParams: { model: 'other' },
    }),
    DispatchConflictError,
  );
  await assert.rejects(
    harness.service.dispatch('x', {
      sessionId: session.sessionId,
      sessionParams: { reasoning: 'other' },
    }),
    DispatchConflictError,
  );
  assert.equal(harness.adapter.prompts.length, 0);
});

test('dispatch reports an unknown explicit session without creating one', async (t) => {
  const harness = setup(t);
  await assert.rejects(
    harness.service.dispatch('x', { sessionId: 'unknown-session' }),
    DispatchSessionNotFoundError,
  );
  assert.equal(harness.registry.list().length, 0);
  assert.equal(harness.adapter.prompts.length, 0);
});

test('dispatch requires input and one session choice; fresh needs a project', async (t) => {
  const harness = setup(t, {}, false);
  await assert.rejects(harness.service.dispatch('', { sessionParams: {} }), TypeError);
  await assert.rejects(harness.service.dispatch('x', {}), TypeError);
  await assert.rejects(harness.service.dispatch('x', { sessionParams: {} }), /needs a project/);
  assert.equal(harness.adapter.prompts.length, 0);
});

test('dispatch can use a per-call project and validates timeout', async (t) => {
  const harness = setup(t, { output: 'override' }, false);
  const result = await harness.service.dispatch('x', {
    sessionParams: { harness: 'fake' },
    project: harness.project,
  });
  assert.equal(result.output, 'override');
  await assert.rejects(
    harness.service.dispatch('x', {
      sessionParams: { harness: 'fake' },
      project: harness.project,
      timeoutMs: 0,
    }),
    TypeError,
  );
});

test('dispatch timeout cancels once, releases the graph and never replays', async (t) => {
  const harness = setupWithAdapter(t, new HoldingAdapter());
  const started = Date.now();
  await assert.rejects(
    harness.service.dispatch('side-effect', {
      sessionParams: { harness: 'fake' },
      timeoutMs: 40,
    }),
    DispatchTimeoutError,
  );
  assert.ok(Date.now() - started < 2_000);
  assert.equal(harness.adapter.prompts.length, 1);
  assert.equal(harness.adapter.prompts[0], 'side-effect');
  // The cancelled execution settled, so the ephemeral graph was unloaded now
  // rather than left for the deferred release path.
  assertReleased(harness.graphHost);
});

test('dispatch rejects a completed run whose output is empty', async (t) => {
  const harness = setup(t, { output: '' });
  await assert.rejects(
    harness.service.dispatch('x', { sessionParams: { harness: 'fake' } }),
    /empty output/,
  );
  assertReleased(harness.graphHost);
});

test('dispatch reports failed and unknown terminal states without replay', async (t) => {
  const failed = setup(t, { terminal: 'failed', error: 'native failure' });
  await assert.rejects(
    failed.service.dispatch('x', { sessionParams: { harness: 'fake' } }),
    DispatchExecutionError,
  );
  assert.equal(failed.adapter.prompts.length, 1);
  assertReleased(failed.graphHost);

  const unknown = setup(t, { terminal: 'unknown', error: 'no outcome' });
  await assert.rejects(
    unknown.service.dispatch('x', { sessionParams: { harness: 'fake' } }),
    DispatchExecutionError,
  );
  assert.equal(unknown.adapter.prompts.length, 1);
  assertReleased(unknown.graphHost);
});
