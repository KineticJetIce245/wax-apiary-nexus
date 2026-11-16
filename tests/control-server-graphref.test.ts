import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions } from '../src/adapters/harness.js';
import {
  ControlServer,
  type ControlServerInfo,
  type ControlServerOptions,
} from '../src/control/server.js';
import { DaemonLockError } from '../src/daemon/daemon-lock.js';
import type { Project } from '../src/project/kernel.js';
import {
  SessionRegistry,
  type SweepSessionsReport,
} from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';
import {
  FIXED_NOW,
  PROMPT_SECRET,
  INPUT_SECRET,
  OUTPUT_SECRET,
  FakeClock,
  makeEnv,
  makeEnvWithAdapter,
  makeServer,
  startServer,
  type TestEnv,
  foragerDefinition,
  loadBody,
  collectKeys,
  assertNoSecrets,
  hoverTokenOf,
  userAnswerComposition,
  userForagerComposition,
} from './support/control-server-fixtures.js';
import { writeManifestFixture, writeManifestVariant, untriggerableComposition } from './support/control-server-manifests.js';
import {
  GatedFakeAdapter,
  TrackingFakeAdapter,
  HoldingFakeAdapter,
  FailingCloseFakeAdapter,
  ThrowingSweepRegistry,
} from './support/control-server-adapters.js';
import {
  authHeader,
  readResponse,
  getJson,
  postJson,
  withTimeout,
  freePort,
  rawGet,
  announcedButUnsentBody,
} from './support/control-server-http.js';

let projectSeq = 0;

test('trigger with a graphRef lazily loads the manifest graph, then triggers it', async (t) => {
  const env = makeEnv({ output: OUTPUT_SECRET });
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, {
    logger: (line) => logs.push(line),
  });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'lazy-graph' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'lazy-graph',
    nodeId: 'only',
    value: { kind: 'text', text: INPUT_SECRET },
    graphRef: fixture.manifestPath,
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['graphId'], 'lazy-graph');
  assert.equal(trigger.body?.['result']?.['rest'], true);
  assert.equal(trigger.body?.['result']?.['persisted'], true);

  const status = await getJson(info.url, token, '/status/lazy-graph');
  assert.equal(status.status, 200);
  assert.equal(status.body?.['status']?.['graphId'], 'lazy-graph');
  assert.equal(status.body?.['status']?.['rest'], true);

  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
  assert.equal(env.adapter.prompts.length, 1);
  assert.match(env.adapter.prompts[0] ?? '', /manifest/);
  assert.match(env.adapter.prompts[0] ?? '', new RegExp(INPUT_SECRET));
  assertNoSecrets(`${trigger.text}\n${status.text}\n${logs.join('\n')}`, token);
});

test('a graphRef with a missing or untriggerable node is rejected with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const missingNode = writeManifestFixture(env, { graphId: 'missing-node-graph' });
  const missing = await postJson(info.url, token, '/trigger', {
    graphId: 'missing-node-graph',
    nodeId: 'absent',
    value: { kind: 'text', text: 'x' },
    graphRef: missingNode.manifestPath,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body?.['code'], 'bad-request');

  const condition = writeManifestFixture(env, {
    composition: untriggerableComposition('condition-graph'),
  });
  const untriggerable = await postJson(info.url, token, '/trigger', {
    graphId: 'condition-graph',
    nodeId: 'cond',
    value: { kind: 'text', text: 'x' },
    graphRef: condition.manifestPath,
  });
  assert.equal(untriggerable.status, 400);
  assert.equal(untriggerable.body?.['code'], 'bad-request');

  // A failed lazy load must leave neither a session nor a loaded graph behind.
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
  assert.equal(env.adapter.prompts.length, 0);
  for (const graphId of ['missing-node-graph', 'condition-graph']) {
    const status = await getJson(info.url, token, `/status/${graphId}`);
    assert.equal(status.status, 404);
  }
});

test('a manifest harness becomes defaultHarness and an explicit binding wins', async (t) => {
  const codexAdapter = new FakeAdapter({ output: 'codex' });
  const dshAdapter = new FakeAdapter({ output: 'dsh' });
  const codexWorkspace = new Workspace(codexAdapter);
  const dshWorkspace = new Workspace(dshAdapter);
  projectSeq += 1;
  const project: Project = {
    id: `project-${String(projectSeq)}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-control-project-')),
  };
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-control-state-'));
  const env: TestEnv = {
    adapter: codexAdapter,
    workspace: codexWorkspace,
    registry: new SessionRegistry({
      workspaces: new Map([
        ['codex', codexWorkspace],
        ['dsh', dshWorkspace],
      ]),
    }),
    project,
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
  t.after(async () => {
    await codexWorkspace.stop();
    await dshWorkspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  // Manifest harness dsh supplies defaultHarness; the fresh binding has no
  // explicit harness and therefore uses dsh.
  const defaultDsh = writeManifestFixture(env, { graphId: 'default-dsh', harness: 'dsh' });
  const defaultTrigger = await postJson(info.url, token, '/trigger', {
    graphId: 'default-dsh',
    nodeId: 'only',
    value: { kind: 'text', text: 'default' },
    graphRef: defaultDsh.manifestPath,
  });
  assert.equal(defaultTrigger.status, 200);
  assert.equal(dshAdapter.prompts.length, 1);
  assert.equal(codexAdapter.prompts.length, 0);
  assert.deepEqual(
    env.registry.list().map((record) => record.harness),
    ['dsh'],
  );

  // An explicit fresh-binding harness overrides the manifest default.
  const explicitDsh = writeManifestFixture(env, {
    graphId: 'explicit-dsh',
    harness: 'codex',
    bindings: { only: { kind: 'fresh', harness: 'dsh' } },
  });
  const explicitTrigger = await postJson(info.url, token, '/trigger', {
    graphId: 'explicit-dsh',
    nodeId: 'only',
    value: { kind: 'text', text: 'explicit' },
    graphRef: explicitDsh.manifestPath,
  });
  assert.equal(explicitTrigger.status, 200);
  assert.equal(dshAdapter.prompts.length, 2);
  assert.equal(codexAdapter.prompts.length, 0);
  assert.deepEqual(
    env.registry.list().map((record) => record.harness),
    ['dsh', 'dsh'],
  );
});

test('a broken or missing graphRef manifest is rejected with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'bad-manifest' });

  const cases = [
    join(fixture.root, 'absent.wax.json'),
    writeManifestVariant(fixture.root, 'broken.wax.json', '{"schemaVersion":1,'),
    writeManifestVariant(fixture.root, 'unknown-field.wax.json', {
      ...fixture.manifest,
      typoField: true,
    }),
    writeManifestVariant(fixture.root, 'missing-composition.wax.json', {
      ...fixture.manifest,
      composition: 'absent.json',
    }),
  ];

  for (const manifestPath of cases) {
    const trigger = await postJson(info.url, token, '/trigger', {
      graphId: 'bad-manifest',
      nodeId: 'only',
      value: { kind: 'text', text: 'x' },
      graphRef: manifestPath,
    });
    assert.equal(trigger.status, 400, `manifest should be rejected: ${manifestPath}`);
    assert.equal(trigger.body?.['code'], 'bad-request');
  }

  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('a graphRef with invalid bindings is rejected before any session is created', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const cases: Record<string, unknown>[] = [
    // Schema-level: unknown binding kind.
    { only: { kind: 'bogus' } },
    // Semantic: the forager has no binding at all.
    {},
  ];
  for (const bindings of cases) {
    const fixture = writeManifestFixture(env, {
      graphId: 'bad-bindings',
      bindings,
    });
    const trigger = await postJson(info.url, token, '/trigger', {
      graphId: 'bad-bindings',
      nodeId: 'only',
      value: { kind: 'text', text: 'x' },
      graphRef: fixture.manifestPath,
    });
    assert.equal(trigger.status, 400, JSON.stringify(bindings));
    assert.equal(trigger.body?.['code'], 'bad-request');
    assert.equal(env.registry.list().length, 0);
    assert.equal(env.adapter.displayNames.length, 0);
  }

  // A rejected lazy load leaves nothing behind: the same graph id can be
  // loaded by a corrected manifest and triggered once.
  const retry = writeManifestFixture(env, { graphId: 'bad-bindings' });
  const loaded = await postJson(info.url, token, '/trigger', {
    graphId: 'bad-bindings',
    nodeId: 'only',
    value: { kind: 'text', text: 'retry' },
    graphRef: retry.manifestPath,
  });
  assert.equal(loaded.status, 200);
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
});

test('a graphRef composition whose id differs from graphId is rejected with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'composition-id' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'requested-id',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.manifestPath,
  });
  assert.equal(trigger.status, 400);
  assert.equal(trigger.body?.['code'], 'bad-request');
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('trigger graphRef must be a bounded, non-blank string without control characters', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  for (const graphRef of ['', '   ', `bad\u0000path`, `bad\u0007path`, 'x'.repeat(4_097)]) {
    const trigger = await postJson(info.url, token, '/trigger', {
      graphId: 'graph',
      nodeId: 'only',
      value: { kind: 'text', text: 'x' },
      graphRef,
    });
    assert.equal(trigger.status, 400, JSON.stringify(graphRef.slice(0, 8)));
    assert.equal(trigger.body?.['code'], 'bad-request');
  }
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('trigger graphRef is a manifest path, not a composition path', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'manifest-only' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'manifest-only',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.compositionPath,
  });
  assert.equal(trigger.status, 400);
  assert.equal(trigger.body?.['code'], 'bad-request');
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('an already loaded graph ignores a broken graphRef', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(foragerDefinition('loaded-graph', 'loaded {{input}}'), env.project, {
      only: { kind: 'fresh' },
    }),
  );
  assert.equal(load.status, 200);
  const fixture = writeManifestFixture(env, { graphId: 'loaded-graph' });

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'loaded-graph',
    nodeId: 'only',
    value: { kind: 'text', text: 'memory wins' },
    graphRef: join(fixture.root, 'absent.wax.json'),
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['graphId'], 'loaded-graph');
  // Memory was used: no second load and no extra session.
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
  assert.equal(env.adapter.prompts.length, 1);
});

test('an already loaded graph is never replaced by a graphRef composition', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  // Harness must match so a replacement bug cannot be masked by the harness
  // check: the only thing that may reject this trigger is the memory-first rule.
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(foragerDefinition('sticky-graph', 'sticky {{input}}'), env.project, {
      only: { kind: 'fresh' },
    }),
  );
  assert.equal(load.status, 200);
  const before = await getJson(info.url, token, '/status/sticky-graph');
  const revision = before.body?.['status']?.['graphRevision'];

  const otherComposition = {
    schemaVersion: 1,
    id: 'sticky-graph',
    nodes: {
      other: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'other {{input}}' },
      },
    },
    edges: [],
  };
  const fixture = writeManifestFixture(env, {
    graphId: 'sticky-graph',
    composition: otherComposition,
    bindings: { other: { kind: 'fresh' } },
  });

  // The node exists in the manifest graph but not in the loaded graph. The
  // trigger must not swap in the manifest composition.
  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'sticky-graph',
    nodeId: 'other',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.manifestPath,
  });
  assert.equal(trigger.status, 400);

  const after = await getJson(info.url, token, '/status/sticky-graph');
  assert.equal(after.status, 200);
  assert.equal(after.body?.['status']?.['graphRevision'], revision);
  assert.deepEqual(
    (after.body?.['status']?.['nodes'] as { nodeId: string }[]).map((node) => node.nodeId),
    ['only'],
  );
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);
});

test('a failed graphRef restore rolls back the session it created', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const graphId = 'restore-failure';
  const fixture = writeManifestFixture(env, { graphId });

  // A structurally valid Honey field from a different graph revision restores
  // only after sessions have been created, so it exercises GraphHost rollback.
  const honeyDir = join(
    env.stateRoot,
    'apiaries',
    'apiary',
    'compositions',
    graphId,
    'honey',
  );
  mkdirSync(honeyDir, { recursive: true });
  writeFileSync(
    join(honeyDir, 'field.json'),
    JSON.stringify({
      schemaVersion: 1,
      compositionId: graphId,
      graphRevision: 'stale-revision',
      rest: true,
      nodes: {},
    }),
  );

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId,
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
    graphRef: fixture.manifestPath,
  });
  // GraphLoadError maps to 409 in the lazy-load path (see brief M6a §4).
  assert.equal(trigger.status, 409);
  assert.equal(trigger.body?.['code'], 'conflict');
  // A session was created before the restore failed; the rollback closed it.
  assert.equal(env.adapter.displayNames.length, 1);
  assert.equal(env.registry.list().length, 0);
  const status = await getJson(info.url, token, `/status/${graphId}`);
  assert.equal(status.status, 404);
});

test('concurrent triggers with the same graphRef load exactly once', async (t) => {
  const adapter = new GatedFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const fixture = writeManifestFixture(env, { graphId: 'racing-graph' });
  const body = {
    graphId: 'racing-graph',
    nodeId: 'only',
    value: { kind: 'text', text: 'race' },
    graphRef: fixture.manifestPath,
  };

  const first = postJson(info.url, token, '/trigger', body);
  // The first request is provably inside loadGraph (creating its session).
  await withTimeout(adapter.createStarted, 5_000, 'first graphRef load');
  const second = postJson(info.url, token, '/trigger', body);
  const secondResult = await withTimeout(second, 5_000, 'second graphRef trigger');
  adapter.release();
  const firstResult = await withTimeout(first, 5_000, 'first graphRef trigger');

  const statuses = [firstResult.status, secondResult.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const conflict = firstResult.status === 409 ? firstResult : secondResult;
  assert.equal(conflict.body?.['code'], 'conflict');
  assert.equal(env.registry.list().length, 1);
  assert.equal(adapter.displayNames.length, 1);
});

test('a hover-only graph is swept only when allowHoverUnload is enabled', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, {
    allowHoverUnload: true,
    now: clock.now,
  });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const definition = userAnswerComposition('hover-sweep');

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 100),
  );
  assert.equal(load.status, 200);
  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'hover-sweep',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting' },
  });
  assert.equal(trigger.body?.['result']?.['hovered'], true);

  clock.advance(100);
  const sweep = await postJson(info.url, token, '/sweep', {});
  assert.equal(sweep.status, 200);
  assert.deepEqual(sweep.body?.['report']?.['unloaded'], ['hover-sweep']);
  assert.deepEqual(sweep.body?.['report']?.['failed'], []);
  const gone = await getJson(info.url, token, '/status/hover-sweep');
  assert.equal(gone.status, 404);

  // The sweep flushed the hover: reloading restores it and it can be answered.
  const reload = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 0),
  );
  assert.equal(reload.status, 200);
  assert.equal(reload.body?.['status']?.['rest'], false);
  assert.equal(reload.body?.['status']?.['hovered'], true);
  const answer = await postJson(info.url, token, '/answer', {
    graphId: 'hover-sweep',
    nodeId: 'ask',
    value: { kind: 'text', text: 'answered' },
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body?.['result']?.['rest'], true);

  // The default (false) still refuses the same graph.
  const clockB = new FakeClock(1_000);
  const envB = makeEnv();
  t.after(async () => {
    await envB.workspace.stop();
  });
  const runningB = await startServer(envB, { now: clockB.now });
  t.after(async () => {
    await runningB.server.stop();
  });
  const loadB = await postJson(
    runningB.info.url,
    runningB.token,
    '/graphs/load',
    loadBody(definition, envB.project, {}, 100),
  );
  assert.equal(loadB.status, 200);
  const triggerB = await postJson(runningB.info.url, runningB.token, '/trigger', {
    graphId: 'hover-sweep',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting' },
  });
  assert.equal(triggerB.body?.['result']?.['hovered'], true);
  clockB.advance(100);
  const sweepB = await postJson(runningB.info.url, runningB.token, '/sweep', {});
  assert.deepEqual(sweepB.body?.['report']?.['unloaded'], []);
  assert.deepEqual(sweepB.body?.['report']?.['skipped'], [
    { id: 'hover-sweep', reason: 'unsafe' },
  ]);
  const unloadB = await postJson(runningB.info.url, runningB.token, '/graphs/unload', {
    graphId: 'hover-sweep',
  });
  assert.equal(unloadB.status, 409);
  assert.equal(unloadB.body?.['code'], 'conflict');
  assert.equal(unloadB.body?.['status']?.['hovered'], true);
});
