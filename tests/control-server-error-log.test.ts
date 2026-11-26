import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ControlServer } from '../src/control/server.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';
import {
  bLoad,
  bTrigger,
  getJson,
  postJson,
  waitForRest,
} from './support/control-server-http.js';

interface Env {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly stateRoot: string;
  readonly daemonDir: string;
}

function makeEnv(adapter: FakeAdapter): Env {
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: `error-log-${String(Date.now())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m12a-error-log-project-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['codex', workspace]]),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m12a-error-log-state-'));
  return {
    adapter,
    workspace,
    registry,
    project,
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for guard state');
}

function definition(id: string, prompt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt },
      },
    },
    edges: [],
  };
}

test('an internal 500 is logged as errorClass only, never message or body', async (t) => {
  const promptSecret = `PROMPT-SECRET-${String(Date.now())}`;
  const nativeSecret = `NATIVE-SECRET-${String(Date.now())}`;
  const adapter = new FakeAdapter({
    askApproval: true,
    terminal: 'failed',
    error: nativeSecret,
    output: `OUTPUT-SECRET-${String(Date.now())}`,
  });
  const env = makeEnv(adapter);
  const logs: string[] = [];
  const server = new ControlServer({
    registry: env.registry,
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
    liveProject: env.project,
    guardTimeoutMs: 10_000,
    logger: (line) => logs.push(line),
  });
  t.after(async () => {
    await server.stop();
    await env.workspace.stop();
  });
  const info = await server.start();
  const token = readFileSync(info.tokenPath, 'utf8').trim();
  const loaded = await bLoad(info.url, token, {
    definition: definition('error-log', `run ${promptSecret} {{message}}`),
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  assert.equal(loaded.status, 200);

  const wakePromise = bTrigger(info.url, token, 'error-log', 'only', promptSecret);
  await waitFor(async () => {
    const guards = await getJson(info.url, token, '/guards');
    return guards.status === 200 && (guards.body?.['guards'] as unknown[]).length === 1;
  });
  const listed = await getJson(info.url, token, '/guards');
  const guard = (listed.body?.['guards'] as Record<string, unknown>[])[0];
  assert.ok(guard !== undefined);

  const decided = await postJson(info.url, token, '/guard/decide', {
    requestId: guard['requestId'],
    decision: 'allow_once',
  });
  assert.equal(decided.status, 200);

  // The native execution fails after the decision. With delivery-only triggers
  // this is a background execution failure: no HTTP 500 is produced, and
  // neither the inspect view nor the metadata log may carry the prompt, native
  // error or output.
  const wake = await wakePromise;
  assert.equal(wake.status, 202);
  const finished = await waitForRest(
    info.url,
    token,
    'error-log',
    2_000,
    false,
  );
  assert.equal(finished.body?.['status']?.['rest'], true);
  assert.deepEqual(finished.body?.['outputs'], []);
  assert.equal(finished.text.includes(promptSecret), false);
  assert.equal(finished.text.includes(nativeSecret), false);
  assert.equal(finished.text.includes('OUTPUT-SECRET'), false);

  // Async failures are never turned into a synthetic 500 request line.
  assert.equal(logs.some((line) => line.includes('status=500')), false);

  // Non-500 responses keep the original line shape: no class and no body.
  const missing = await postJson(info.url, token, '/lives/trigger', {
    liveId: 'missing',
    beeId: 'missing',
    input: promptSecret,
  });
  assert.equal(missing.status, 404);
  const notFoundLine = logs.find((line) => line.includes('status=404'));
  assert.ok(notFoundLine !== undefined);
  assert.equal(notFoundLine.includes('errorClass='), false);

  for (const line of logs) {
    assert.match(
      line,
      /^control method=(GET|POST) path=\S+ status=\d{3} durationMs=\d+ code=[a-z-]+( errorClass=\S+)?$/,
    );
    assert.equal(line.includes(promptSecret), false);
    assert.equal(line.includes(nativeSecret), false);
    assert.equal(line.includes(token), false);
  }

  t.diagnostic(
    `observed: rest=true outputs=0; request log lines=${String(logs.length)}`,
  );
});
