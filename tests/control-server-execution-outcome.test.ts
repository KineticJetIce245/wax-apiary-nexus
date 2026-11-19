import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeAdapter, type FakeTerminal } from './support/fake-adapter.js';
import {
  OUTPUT_SECRET,
  PROMPT_SECRET,
  assertNoSecrets,
  foragerDefinition,
  makeEnvWithAdapter,
  startServer,
} from './support/control-server-fixtures.js';
import { bLoad, bWake } from './support/control-server-http.js';

interface Scenario {
  readonly terminal: FakeTerminal;
  readonly status: number;
  readonly code: string;
}

/**
 * A native cancelled execution has no Workspace provenance, so it stays
 * `execution-cancelled`; `failed` and `unknown` remain internal 500. The
 * Workspace approval timer and an explicit cancel are covered separately.
 */
const SCENARIOS: readonly Scenario[] = [
  { terminal: 'failed', status: 500, code: 'internal' },
  { terminal: 'unknown', status: 500, code: 'internal' },
  { terminal: 'cancelled', status: 409, code: 'execution-cancelled' },
];

for (const scenario of SCENARIOS) {
  const { terminal, status, code } = scenario;

  test(`a ${terminal} execution answers ${String(status)} ${code}`, async (t) => {
    const liveId = `outcome-${terminal}`;
    const adapter = new FakeAdapter({
      terminal,
      output: OUTPUT_SECRET,
      error: `${terminal}-native-detail`,
    });
    const env = makeEnvWithAdapter(adapter);
    const running = await startServer(env);
    t.after(async () => {
      await running.server.stop();
      await env.workspace.stop();
    });

    const loaded = await bLoad(running.info.url, running.token, {
      definition: foragerDefinition(liveId, `run ${PROMPT_SECRET} {{input}}`),
      bindings: { only: { kind: 'fresh' } },
      project: env.project,
    });
    assert.equal(loaded.status, 200);

    const wake = await bWake(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
    assert.equal(wake.status, status, wake.text);
    assert.equal(wake.body?.['ok'], false);
    assert.equal(wake.body?.['code'], code);
    assertNoSecrets(wake.text, running.token);
    assert.equal(wake.text.includes(OUTPUT_SECRET), false);

    t.diagnostic(`observed: state=${terminal} status=${String(wake.status)} code=${code}`);
  });
}

test('the workspace approval timer answers 409 approval-timeout', async (t) => {
  const liveId = 'outcome-approval-timeout';
  const logs: string[] = [];
  const adapter = new FakeAdapter({
    askApproval: true,
    approvalCancelTerminal: 'cancelled',
    output: OUTPUT_SECRET,
  });
  const env = makeEnvWithAdapter(adapter, undefined, { approvalTimeoutMs: 50 });
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  let executionId: string | undefined;
  const unsubscribe = env.workspace.onEvent((event) => {
    if (event.type === 'execution/approval-requested') {
      executionId = event.executionId;
    }
  });
  t.after(async () => {
    unsubscribe();
    await running.server.stop();
    await env.workspace.stop();
  });

  const loaded = await bLoad(running.info.url, running.token, {
    definition: foragerDefinition(liveId, `run ${PROMPT_SECRET} {{input}}`),
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  assert.equal(loaded.status, 200);

  const wake = await bWake(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
  assert.equal(wake.status, 409, wake.text);
  assert.equal(wake.body?.['ok'], false);
  assert.equal(wake.body?.['code'], 'approval-timeout');
  assertNoSecrets(wake.text, running.token);
  assert.equal(wake.text.includes(OUTPUT_SECRET), false);

  assert.ok(executionId !== undefined, 'expected a native approval request');
  const execution = env.workspace.getExecution(executionId);
  assert.ok(execution !== undefined);
  assert.equal(execution.state, 'cancelled');
  assert.equal(execution.cancelReason, 'approval-timeout');
  assert.equal(execution.error, undefined);

  const wakeLine = logs.find(
    (line) => line.includes('path=/lives/wake') && line.includes('status=409'),
  );
  assert.ok(wakeLine !== undefined, `no 409 wake log line: ${logs.join(' | ')}`);
  assert.match(wakeLine, / code=approval-timeout$/);
  assert.equal(logs.some((line) => line.includes('status=500')), false);

  t.diagnostic(
    `observed: status=${String(wake.status)} code=${String(wake.body?.['code'])} ` +
      `cancelReason=${String(execution.cancelReason)}`,
  );
});

test('an explicit workspace cancel answers 409 execution-cancelled', async (t) => {
  const liveId = 'outcome-explicit-cancel';
  const adapter = new FakeAdapter({
    askApproval: true,
    approvalCancelTerminal: 'cancelled',
    output: OUTPUT_SECRET,
  });
  const env = makeEnvWithAdapter(adapter, undefined, { approvalTimeoutMs: 60_000 });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const loaded = await bLoad(running.info.url, running.token, {
    definition: foragerDefinition(liveId, `run ${PROMPT_SECRET} {{input}}`),
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  assert.equal(loaded.status, 200);

  const requested = new Promise<string>((resolve) => {
    const off = env.workspace.onEvent((event) => {
      if (event.type === 'execution/approval-requested') {
        off();
        resolve(event.executionId);
      }
    });
  });
  const wakePromise = bWake(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
  const executionId = await requested;
  await env.workspace.cancel(executionId);
  const wake = await wakePromise;

  assert.equal(wake.status, 409, wake.text);
  assert.equal(wake.body?.['ok'], false);
  assert.equal(wake.body?.['code'], 'execution-cancelled');
  assertNoSecrets(wake.text, running.token);

  const execution = env.workspace.getExecution(executionId);
  assert.ok(execution !== undefined);
  assert.equal(execution.state, 'cancelled');
  assert.equal(execution.cancelReason, 'explicit-cancel');

  t.diagnostic(
    `observed: status=${String(wake.status)} code=${String(wake.body?.['code'])} ` +
      `cancelReason=${String(execution.cancelReason)}`,
  );
});
