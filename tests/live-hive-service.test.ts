import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  LiveHiveHost,
  type LiveHiveRunResult,
} from '../src/daemon/graph-host.js';
import { GraphBindingStore } from '../src/graph/binding-store.js';
import { HiveTemplateStore } from '../src/b/hive-template.js';
import { LiveHiveStore } from '../src/b/live-hive.js';
import { LiveHiveService, LiveHiveServiceError } from '../src/b/live-hive-service.js';
import type { LiveHive } from '../src/b/types.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { HoneyStore } from '../src/storage/honey.js';
import { RunStore } from '../src/storage/run-store.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { simpleLiveHive, simpleTemplate } from './support/b-object-fixtures.js';

/**
 * Wake a fixture live whose sessions are unique per live. Admission is in the
 * harness adapter, so a resolved call is the synchronous run the test asserts on.
 */
async function wakeNow(
  service: LiveHiveService,
  liveId: string,
  beeId: string,
  input: string,
): Promise<LiveHiveRunResult> {
  return service.wake(liveId, beeId, input);
}

interface Harness {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly root: string;
  readonly host: LiveHiveHost;
  readonly templates: HiveTemplateStore;
  readonly runStore: RunStore;
  readonly service: LiveHiveService;
}

function setup(t: TestContext): Harness {
  const adapter = new FakeAdapter({ output: 'dispatched' });
  const workspace = new Workspace(adapter);
  const registry = new SessionRegistry({ workspaces: new Map([['fake', workspace]]) });
  const project: Project = {
    id: 'service-project',
    directory: mkdtempSync(join(tmpdir(), 'wax-service-project-')),
  };
  const root = mkdtempSync(join(tmpdir(), 'wax-service-state-'));
  const runStore = new RunStore(join(root, 'runs'));
  const host = new LiveHiveHost({
    registry,
    runStore,
    honeyForGraph: (graphId) => HoneyStore.forComposition(root, 'apiary', graphId),
    bindingStore: new GraphBindingStore(join(root, 'bindings.json')),
  });
  const templates = new HiveTemplateStore(join(root, 'templates'));
  const service = new LiveHiveService({
    liveHiveHost: host,
    registry,
    livesRoot: join(root, 'lives'),
    templateStore: templates,
    defaultProject: project,
    runStore,
  });
  t.after(async () => {
    await host.dispose();
    await workspace.stop();
  });
  return {
    adapter,
    workspace,
    registry,
    project,
    root,
    host,
    templates,
    runStore,
    service,
  };
}

async function boundLive(harness: Harness): Promise<LiveHive> {
  const base = simpleLiveHive();
  const draft = await harness.registry.create(harness.project, {
    harness: 'fake',
    model: 'draft-model',
  });
  const review = await harness.registry.create(harness.project, {
    harness: 'fake',
    reasoning: 'review-reasoning',
  });
  const done = await harness.registry.create(harness.project, { harness: 'fake' });
  return {
    ...base,
    bindings: {
      draft: draft.sessionId,
      review: review.sessionId,
      done: done.sessionId,
    },
  };
}

test('LiveHiveService new/wake/save/unload/load round-trips one live', async (t) => {
  const harness = setup(t);
  const live = await boundLive(harness);
  const created = await harness.service.new(live);
  assert.equal(created.liveId, 'demo');
  assert.equal(created.status.graphId, 'demo');
  const livePath = join(harness.root, 'lives', 'demo', 'live.json');
  assert.equal(existsSync(livePath), true);
  assert.deepEqual(JSON.parse(readFileSync(livePath, 'utf8')), live);
  assert.equal(harness.host.statusOf('demo')?.rest, true);
  assert.equal(harness.service.read.list().find((entry) => entry.liveId === 'demo')?.state, 'loaded');

  const woke = await wakeNow(harness.service, 'demo', 'draft', 'hello');
  assert.equal(woke.graphId, 'demo');
  assert.equal(harness.host.statusOf('demo')?.rest, true);
  assert.equal(harness.service.read.output('demo').runId, woke.runId);
  assert.equal(harness.service.read.output('demo', woke.runId).runId, woke.runId);
  assert.throws(() => harness.service.read.output('demo', 'unknown-run'), /run output is not available/);

  const saved = await harness.service.save('demo');
  assert.equal(saved.graphId, 'demo');
  assert.equal(harness.host.statusOf('demo')?.rest, true);
  assert.ok(harness.host.outputsOf('demo').size > 0);

  const inspected = harness.service.read.inspect('demo');
  assert.equal(inspected.liveId, 'demo');
  assert.equal(inspected.status?.graphId, 'demo');
  assert.ok(inspected.outputs.length > 0);

  assert.equal(await harness.service.unload('demo'), true);
  assert.equal(harness.host.statusOf('demo'), undefined);
  assert.equal(existsSync(livePath), true);
  const unloadedInspect = harness.service.read.inspect('demo');
  assert.equal(unloadedInspect.status, undefined);
  assert.deepEqual(unloadedInspect.outputs, []);
  assert.equal(harness.service.read.list().find((entry) => entry.liveId === 'demo')?.state, 'unloaded');
  assert.equal(harness.service.read.output('demo').runId, woke.runId);
  const loaded = await harness.service.load('demo');
  assert.equal(loaded.status.graphId, 'demo');
  assert.equal(harness.host.statusOf('demo')?.rest, true);
  assert.deepEqual(JSON.parse(readFileSync(livePath, 'utf8')), live);
});

test('LiveHiveService compose/instantiate uses template defaults and creates sessions', async (t) => {
  const harness = setup(t);
  const template = {
    ...simpleTemplate(),
    schedules: [{ scheduleId: 'tick', targetBee: 'draft', everyMs: 60_000 }],
  };
  assert.deepEqual(harness.service.compose(template), template);
  assert.deepEqual(harness.service.listTemplates().map((entry) => entry.templateId), ['starter']);

  const instantiated = await harness.service.instantiate(
    'starter',
    'instantiated',
    {
      draft: { harness: 'fake', model: 'override-model' },
      review: { harness: 'fake' },
      done: { harness: 'fake' },
    },
  );
  assert.equal(instantiated.status.graphId, 'instantiated');
  assert.equal(existsSync(join(harness.root, 'lives', 'instantiated', 'live.json')), true);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(harness.root, 'lives', 'instantiated', 'live.json'), 'utf8'),
    )['schedules'],
    template.schedules,
  );
  assert.equal(harness.registry.list().length, 3);
  const draft = harness.registry.list().find((record) => record.model === 'override-model');
  assert.ok(draft !== undefined);
  assert.equal(harness.host.statusOf('instantiated')?.rest, true);
  assert.equal(
    (await wakeNow(harness.service, 'instantiated', 'draft', 'x')).graphId,
    'instantiated',
  );
});

test('LiveHiveService migrate replaces structure explicitly without fork semantics', async (t) => {
  const harness = setup(t);
  const live = await boundLive(harness);
  await harness.service.new(live);
  const next: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      draft: {
        ...live.bees['draft']!,
        config: { connection: 'fake', prompt: 'changed {{input}}' },
      },
    },
  };
  const migrated = await harness.service.migrate('demo', next);
  assert.equal(migrated.status.graphId, 'demo');
  assert.equal(harness.host.statusOf('demo')?.rest, true);
  assert.deepEqual(
    JSON.parse(readFileSync(join(harness.root, 'lives', 'demo', 'live.json'), 'utf8')),
    next,
  );
});

test('LiveHiveService list includes disk-only lives and skips non-live dirs', async (t) => {
  const harness = setup(t);
  const disk = { ...simpleLiveHive(), liveId: 'disk-only' };
  const path = join(harness.root, 'lives', 'disk-only', 'live.json');
  mkdirSync(join(harness.root, 'lives', 'garbage'), { recursive: true });
  new LiveHiveStore(path).save(disk);

  const entries = harness.service.read.list();
  assert.deepEqual(entries.map((entry) => entry.liveId), ['disk-only']);
  assert.equal(entries[0]?.state, 'unloaded');
  assert.equal(entries[0]?.status, undefined);
});

test('LiveHiveService rejects invalid, unknown and unsafe live inputs', async (t) => {
  const harness = setup(t);
  await assert.rejects(
    harness.service.new({ ...simpleLiveHive(), schemaVersion: 2 } as unknown as LiveHive),
    LiveHiveServiceError,
  );
  await assert.rejects(harness.service.load('missing'), /not loaded/);
  await assert.rejects(harness.service.load('../escape'), LiveHiveServiceError);
  await assert.rejects(harness.service.wake('demo', 'draft', 'x'), /Graph is not loaded/);
  await assert.rejects(
    harness.service.new({ ...simpleLiveHive(), liveId: '../escape' } as LiveHive),
    LiveHiveServiceError,
  );
});
