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
import { bLoad, bWake, waitForRunTerminal } from './support/control-server-http.js';

interface Scenario {
  readonly terminal: FakeTerminal;
  readonly runState: string;
}

/**
 * Native terminal states are now asynchronous run outcomes: wake returns 202
 * and the run route reports the final state. No native error text crosses the
 * control boundary.
 */
const SCENARIOS: readonly Scenario[] = [
  { terminal: 'failed', runState: 'failed' },
  { terminal: 'unknown', runState: 'unknown' },
  { terminal: 'cancelled', runState: 'cancelled' },
];

for (const scenario of SCENARIOS) {
  const { terminal, runState } = scenario;

  test(`a ${terminal} execution ends its run as ${runState}`, async (t) => {
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
    assert.equal(wake.status, 202, wake.text);
    assert.equal(wake.body?.['ok'], true);
    const runId = String(wake.body?.['runId']);
    assert.ok(runId.length > 0);

    const finished = await waitForRunTerminal(
      running.info.url,
      running.token,
      liveId,
      runId,
    );
    assert.equal(finished.status, 200);
    assert.equal(finished.body?.['run']?.['state'], runState);
    assertNoSecrets(finished.text, running.token);
    assert.equal(finished.text.includes(OUTPUT_SECRET), false);
    assert.equal(finished.text.includes('native-detail'), false);

    t.diagnostic(`observed: state=${runState}`);
  });
}

test('the workspace approval timer cancels the run', async (t) => {
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
  assert.equal(wake.status, 202, wake.text);
  const runId = String(wake.body?.['runId']);
  const finished = await waitForRunTerminal(
    running.info.url,
    running.token,
    liveId,
    runId,
  );
  assert.equal(finished.body?.['run']?.['state'], 'cancelled');
  assertNoSecrets(finished.text, running.token);
  assert.equal(finished.text.includes(OUTPUT_SECRET), false);

  assert.ok(executionId !== undefined, 'expected a native approval request');
  const execution = env.workspace.getExecution(executionId);
  assert.ok(execution !== undefined);
  assert.equal(execution.state, 'cancelled');
  assert.equal(execution.cancelReason, 'approval-timeout');
  assert.equal(execution.error, undefined);

  const wakeLine = logs.find(
    (line) => line.includes('path=/lives/wake') && line.includes('status=202'),
  );
  assert.ok(wakeLine !== undefined, `no 202 wake log line: ${logs.join(' | ')}`);
  assert.equal(logs.some((line) => line.includes('status=500')), false);

  t.diagnostic('observed: run state=cancelled cancelReason=approval-timeout');
});

test('an explicit workspace cancel ends the run as cancelled', async (t) => {
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
  const wake = await bWake(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
  assert.equal(wake.status, 202, wake.text);
  const runId = String(wake.body?.['runId']);
  const executionId = await requested;
  await env.workspace.cancel(executionId);
  const finished = await waitForRunTerminal(
    running.info.url,
    running.token,
    liveId,
    runId,
  );
  assert.equal(finished.body?.['run']?.['state'], 'cancelled');
  assertNoSecrets(finished.text, running.token);

  const execution = env.workspace.getExecution(executionId);
  assert.ok(execution !== undefined);
  assert.equal(execution.state, 'cancelled');
  assert.equal(execution.cancelReason, 'explicit-cancel');

  t.diagnostic('observed: run state=cancelled cancelReason=explicit-cancel');
});
