import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GraphHost,
  GraphSessionBusyError,
} from '../src/daemon/graph-host.js';
import type { GraphBindings } from '../src/graph/binding.js';
import type { Project } from '../src/project/kernel.js';
import { parseComposition } from '../src/runtime/index.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';

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

test('a second loaded graph cannot bind a session owned by the first', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });
  const session = await env.registry.create(env.project);
  const bindings: GraphBindings = {
    only: { kind: 'session', sessionId: session.sessionId },
  };

  await env.host.loadGraph({ definition: definition('first'), bindings, project: env.project });
  assert.ok(env.host.statusOf('first') !== undefined);

  await assert.rejects(
    env.host.loadGraph({
      definition: definition('second'),
      bindings,
      project: env.project,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GraphSessionBusyError);
      assert.equal(error.graphId, 'second');
      assert.equal(error.sessionId, session.sessionId);
      assert.equal(error.ownerGraphId, 'first');
      assert.equal(error.message.includes(PROMPT_SECRET), false);
      return true;
    },
  );
  assert.equal(env.host.statusOf('second'), undefined);
  assert.deepEqual([...env.host.loadedSessionIds()], [session.sessionId]);
  assert.equal(env.registry.list().length, 1);

  // Unload releases the reservation; the same session is now loadable by the
  // second graph, without creating a replacement session.
  assert.equal(await env.host.unload('first'), true);
  await env.host.loadGraph({
    definition: definition('second'),
    bindings,
    project: env.project,
  });
  assert.ok(env.host.statusOf('second') !== undefined);
  assert.deepEqual([...env.host.loadedSessionIds()], [session.sessionId]);
  assert.equal(env.registry.list().length, 1);
  assert.equal(await env.host.unload('second'), true);
});

test('a rejected load releases its session reservation', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });
  const session = await env.registry.create(env.project);
  const bindings: GraphBindings = {
    only: { kind: 'session', sessionId: session.sessionId },
  };
  const wrongProject: Project = {
    id: env.project.id,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9e-wrong-project-')),
  };

  await assert.rejects(
    env.host.loadGraph({
      definition: definition('failed'),
      bindings,
      project: wrongProject,
    }),
  );
  assert.equal(env.host.statusOf('failed'), undefined);

  // The failed load must not leave the session reserved.
  await env.host.loadGraph({
    definition: definition('valid'),
    bindings,
    project: env.project,
  });
  assert.ok(env.host.statusOf('valid') !== undefined);
  assert.equal(await env.host.unload('valid'), true);
});

test('concurrent loads reserve the explicit session before either finishes', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });
  const session = await env.registry.create(env.project);
  const bindings: GraphBindings = {
    only: { kind: 'session', sessionId: session.sessionId },
  };

  const first = env.host.loadGraph({
    definition: definition('first'),
    bindings,
    project: env.project,
  });
  const second = env.host.loadGraph({
    definition: definition('second'),
    bindings,
    project: env.project,
  });
  const firstResult = await Promise.allSettled([first, second]);
  assert.equal(firstResult.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = firstResult.find((result) => result.status === 'rejected');
  assert.ok(rejected !== undefined && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof GraphSessionBusyError);
});
