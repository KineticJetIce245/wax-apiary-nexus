import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GraphHost,
  GraphLoadError,
  isQueuedRun,
} from '../src/daemon/graph-host.js';
import type { GraphBindings } from '../src/graph/binding.js';
import type { Project } from '../src/project/kernel.js';
import { parseComposition } from '../src/runtime/index.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';
import {
  RecordingAdapter,
  fastDefinition,
  forager,
  makeEnv as makeFixtureEnv,
  triggerRun,
} from './support/graph-host-fixtures.js';

const PROMPT_SECRET = 'M9E-PROMPT-SECRET';

function makeEnv(): {
  readonly host: GraphHost;
  readonly registry: SessionRegistry;
  readonly workspace: Workspace;
  readonly project: Project;
  readonly adapter: FakeAdapter;
} {
  const adapter = new FakeAdapter({ output: 'ok' });
  const workspace = new Workspace(adapter);
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const project: Project = {
    id: 'project-session-busy',
    directory: mkdtempSync(join(tmpdir(), 'wax-m9e-session-busy-')),
  };
  const host = new GraphHost({ registry });
  return { host, registry, workspace, project, adapter };
}

function definition(id: string): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: `${PROMPT_SECRET} {{input}}` },
      },
    },
    edges: [],
  });
}

function bindings(sessionId: string): GraphBindings {
  return { only: { kind: 'session', sessionId } };
}

test('two loaded graphs may share one explicit session; release is refcounted', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });
  const session = await env.registry.create(env.project);

  // Both loads are accepted now: execution ordering is the queue's job.
  const first = await env.host.loadGraph({
    definition: definition('first'),
    bindings: bindings(session.sessionId),
    project: env.project,
  });
  const second = await env.host.loadGraph({
    definition: definition('second'),
    bindings: bindings(session.sessionId),
    project: env.project,
  });
  assert.equal(first.graphId, 'first');
  assert.equal(second.graphId, 'second');
  assert.deepEqual([...env.host.loadedSessionIds()], [session.sessionId]);
  assert.equal(env.registry.list().length, 1);

  // Unloading one sharer removes only its reference.
  assert.equal(await env.host.unload('first'), true);
  assert.equal(env.host.statusOf('first'), undefined);
  assert.ok(env.host.statusOf('second') !== undefined);
  assert.deepEqual([...env.host.loadedSessionIds()], [session.sessionId]);

  // The survivor still executes on the shared session.
  const result = await triggerRun(env.host, 'second', 'only', { kind: 'text', text: 'hi' });
  assert.equal(result.graphId, 'second');

  assert.equal(await env.host.unload('second'), true);
  assert.deepEqual([...env.host.loadedSessionIds()], []);
});

test('concurrent loads of different graph ids both attach the same session', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });
  const session = await env.registry.create(env.project);

  const results = await Promise.allSettled([
    env.host.loadGraph({
      definition: definition('first'),
      bindings: bindings(session.sessionId),
      project: env.project,
    }),
    env.host.loadGraph({
      definition: definition('second'),
      bindings: bindings(session.sessionId),
      project: env.project,
    }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.ok(env.host.statusOf('first') !== undefined);
  assert.ok(env.host.statusOf('second') !== undefined);
  assert.deepEqual([...env.host.loadedSessionIds()], [session.sessionId]);
});

test('loading the same graph id twice is still refused', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });
  const session = await env.registry.create(env.project);
  const options = {
    definition: definition('once'),
    bindings: bindings(session.sessionId),
    project: env.project,
  };

  await env.host.loadGraph(options);
  await assert.rejects(
    env.host.loadGraph(options),
    (error: unknown) => {
      assert.ok(error instanceof GraphLoadError);
      assert.equal(error.graphId, 'once');
      return true;
    },
  );

  // The concurrent form is refused too: exactly one load may register.
  await env.host.unload('once');
  const settled = await Promise.allSettled([env.host.loadGraph(options), env.host.loadGraph(options)]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = settled.find((result) => result.status === 'rejected');
  assert.ok(rejected !== undefined && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof GraphLoadError);
  assert.ok(env.host.statusOf('once') !== undefined);
});

test('a rejected load releases only the reservation it added', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });
  const session = await env.registry.create(env.project);
  const wrongProject: Project = {
    id: env.project.id,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9e-wrong-project-')),
  };

  await env.host.loadGraph({
    definition: definition('holder'),
    bindings: bindings(session.sessionId),
    project: env.project,
  });
  // This load fails in binding validation, after the reservation was taken.
  await assert.rejects(
    env.host.loadGraph({
      definition: definition('failed'),
      bindings: bindings(session.sessionId),
      project: wrongProject,
    }),
  );
  assert.equal(env.host.statusOf('failed'), undefined);
  // The holder's reference must survive the failed load's rollback.
  assert.deepEqual([...env.host.loadedSessionIds()], [session.sessionId]);

  assert.equal(await env.host.unload('holder'), true);
  assert.deepEqual([...env.host.loadedSessionIds()], []);

  // The session is reusable after the failed load and the holder are gone.
  await env.host.loadGraph({
    definition: definition('valid'),
    bindings: bindings(session.sessionId),
    project: env.project,
  });
  assert.ok(env.host.statusOf('valid') !== undefined);
  assert.equal(await env.host.unload('valid'), true);
});

test('a busy shared session returns a queue handle instead of a busy error', async (t) => {
  const fixture = makeFixtureEnv(new RecordingAdapter());
  fixture.adapter.holdSubmissions = true;
  const host = new GraphHost({ registry: fixture.registry });
  t.after(async () => {
    await host.dispose();
    await fixture.workspace.stop();
  });
  const session = await fixture.registry.create(fixture.project);
  const load = (id: string): Promise<unknown> =>
    host.loadGraph({
      definition: fastDefinition(id, { only: forager(`run ${id} {{input}}`) }),
      bindings: bindings(session.sessionId),
      project: fixture.project,
    });
  await load('first');
  await load('second');

  const held = host.trigger('first', 'only', { kind: 'text', text: 'one' });
  await fixture.adapter.waitForSubmit(1);
  const queued = await host.trigger('second', 'only', { kind: 'text', text: 'two' });
  assert.ok(isQueuedRun(queued));
  assert.equal(queued.liveId, 'second');
  assert.equal(queued.beeId, 'only');
  assert.equal(queued.sessionId, session.sessionId);
  assert.equal(queued.position, 1);
  assert.equal(host.queues.get(queued.queueId)?.status, 'queued');

  // Only the first run was parked; the promoted run must finish normally.
  fixture.adapter.holdSubmissions = false;
  fixture.adapter.releaseHeld();
  await held;
  await until(() => host.queues.get(queued.queueId)?.status === 'completed');
  assert.equal(typeof host.queues.get(queued.queueId)?.runId, 'string');
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail('timed out waiting for the queue item to settle');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
