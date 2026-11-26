import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  DispatchConflictError,
  DispatchService,
  DispatchSessionNotFoundError,
} from '../src/b/dispatch-service.js';
import { LiveHiveHost } from '../src/daemon/graph-host.js';
import type { LiveHiveStatus, LoadGraphOptions } from '../src/daemon/graph-host.js';
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
  readonly liveHiveHost: RecordingGraphHost;
  readonly service: DispatchService;
}

/** Records graph ids so a test can prove the dispatch graph was unloaded. */
class RecordingGraphHost extends LiveHiveHost {
  readonly loadedIds: string[] = [];

  override loadGraph(options: LoadGraphOptions): Promise<LiveHiveStatus> {
    this.loadedIds.push(options.definition.id);
    return super.loadGraph(options);
  }
}

/** Wait for the host driver to release the ephemeral graph after silent end. */
async function waitForReleased(host: RecordingGraphHost): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const graphId = host.loadedIds[0];
    if (graphId === undefined || host.statusOf(graphId) === undefined) {
      return;
    }
    assert.ok(Date.now() < deadline, 'the ephemeral dispatch graph was not released');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Wait for a delivery to reach the native adapter (its Bee's drain). */
async function waitForPrompts(adapter: FakeAdapter, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (adapter.prompts.length < count) {
    assert.ok(Date.now() < deadline, 'the dispatch prompt did not reach the adapter');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  const liveHiveHost = new RecordingGraphHost({ registry });
  t.after(async () => {
    await liveHiveHost.dispose();
    await workspace.stop();
  });
  const project: Project = {
    id: 'dispatch-project',
    directory: mkdtempSync(join(tmpdir(), 'wax-dispatch-')),
  };
  const service = new DispatchService({
    registry,
    liveHiveHost,
    ...(withDefaultProject ? { defaultProject: project } : {}),
  });
  return { adapter, workspace, registry, project, liveHiveHost, service };
}

/** Holds one execution open until the test releases it. */
class HoldingAdapter extends FakeAdapter {
  private executionId: string | undefined;

  override async submit(
    _nativeId: string,
    executionId: string,
    text: string,
  ): Promise<void> {
    this.prompts.push(text);
    this.executionId = executionId;
  }

  release(): void {
    const executionId = this.executionId;
    this.executionId = undefined;
    if (executionId === undefined) {
      return;
    }
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  }
}

test('dispatch fresh creates one temporary session and accepts without output', async (t) => {
  const harness = setup(t, { output: 'answer-42' });
  const result = await harness.service.dispatch('hello', {
    sessionParams: { harness: 'fake', model: 'm1', reasoning: 'high' },
  });

  assert.equal(result, undefined);
  await waitForPrompts(harness.adapter, 1);
  assert.equal(harness.adapter.prompts.length, 1);
  assert.equal(harness.adapter.prompts[0], 'hello');
  const record = harness.registry.list()[0];
  assert.ok(record !== undefined);
  assert.equal(record.harness, 'fake');
  assert.equal(record.model, 'm1');
  assert.equal(record.reasoning, 'high');
  assert.equal(harness.registry.list().length, 1);
  assert.deepEqual(readdirSync(harness.project.directory), []);
  // The ephemeral graph is not left loaded or listed.
  await waitForReleased(harness.liveHiveHost);
  assert.equal(harness.liveHiveHost.loadedIds.length, 1);
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
  const liveHiveHost = new RecordingGraphHost({
    registry,
    catalog,
    honeyForGraph: (graphId) => {
      honeyRequests += 1;
      return HoneyStore.forComposition(stateRoot, 'apiary', graphId);
    },
  });
  t.after(async () => {
    await liveHiveHost.dispose();
    await workspace.stop();
  });
  const project: Project = {
    id: 'ephemeral-project',
    directory: mkdtempSync(join(tmpdir(), 'wax-dispatch-project-')),
  };
  const service = new DispatchService({ registry, liveHiveHost, defaultProject: project });

  await service.dispatch('hello', { sessionParams: { harness: 'fake' } });
  await waitForReleased(liveHiveHost);

  assert.equal(honeyRequests, 0);
  assert.deepEqual(catalog.list(), []);
  assert.equal(existsSync(catalogPath), false);
  assert.equal(existsSync(join(stateRoot, 'apiaries')), false);
  assert.equal(existsSync(join(stateRoot, 'lives')), false);
  assert.equal(liveHiveHost.status().length, 0);
});

test('dispatch explicit session reuses it and uses its own harness metadata', async (t) => {
  const harness = setup(t, { output: 'reused' });
  const session = await harness.registry.create(harness.project, {
    harness: 'fake',
    model: 'session-model',
    reasoning: 'session-reasoning',
  });

  await harness.service.dispatch('continue', {
    sessionId: session.sessionId,
    sessionParams: {
      harness: 'fake',
      model: 'session-model',
      reasoning: 'session-reasoning',
    },
  });

  assert.equal(harness.registry.list().length, 1);
  await waitForPrompts(harness.adapter, 1);
  assert.equal(harness.adapter.prompts[0], 'continue');
  await waitForReleased(harness.liveHiveHost);
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

test('dispatch can use a per-call project and never reads the model output', async (t) => {
  const harness = setup(t, { output: '' }, false);
  await harness.service.dispatch('x', {
    sessionParams: { harness: 'fake' },
    project: harness.project,
  });
  // An empty model output is not an error: dispatch does not return or inspect it.
  await waitForPrompts(harness.adapter, 1);
  assert.equal(harness.adapter.prompts.length, 1);
  await waitForReleased(harness.liveHiveHost);
});

test('dispatch resolves before a held execution ends and releases after silent end', async (t) => {
  const harness = setupWithAdapter(t, new HoldingAdapter());
  const started = Date.now();
  await harness.service.dispatch('side-effect', {
    sessionParams: { harness: 'fake' },
  });
  assert.ok(Date.now() - started < 2_000);
  await waitForPrompts(harness.adapter, 1);
  assert.equal(harness.adapter.prompts.length, 1);
  const graphId = harness.liveHiveHost.loadedIds[0];
  assert.ok(graphId !== undefined);
  assert.notEqual(harness.liveHiveHost.statusOf(graphId), undefined);
  assert.equal(harness.liveHiveHost.statusOf(graphId)?.rest, false);

  (harness.adapter as HoldingAdapter).release();
  await waitForReleased(harness.liveHiveHost);
});

test('a failed dispatch execution is accepted; the ephemeral graph is still released', async (t) => {
  const harness = setup(t, { terminal: 'failed', error: 'native failure' });
  await harness.service.dispatch('x', { sessionParams: { harness: 'fake' } });
  await waitForPrompts(harness.adapter, 1);
  assert.equal(harness.adapter.prompts.length, 1);
  await waitForReleased(harness.liveHiveHost);
});
