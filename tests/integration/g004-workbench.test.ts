import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexAppServerAdapter } from '../../src/adapters/codex/adapter.js';
import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { createCodexConnection } from '../../src/connection.js';
import type { Project } from '../../src/kernel.js';
import type { Execution } from '../../src/workspace.js';
import { Workbench } from '../../src/workbench.js';

const dshRoot = process.env.DSH_ROOT;
const codexExe = process.env.CODEX_EXE;
const integrationOptions = {
  skip:
    dshRoot === undefined ||
    codexExe === undefined ||
    !existsSync(join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')) ||
    !existsSync(codexExe)
      ? 'Set DSH_ROOT and CODEX_EXE to run the dual-harness integration tests'
      : false,
  timeout: 600_000,
};

interface Session {
  readonly workbench: Workbench;
  readonly project: Project;
}

async function openSession(): Promise<Session> {
  if (dshRoot === undefined || codexExe === undefined) {
    throw new Error('DSH_ROOT and CODEX_EXE are required');
  }
  const codex = await createCodexConnection({ executable: codexExe });
  const project: Project = {
    id: `g004-${Date.now()}`,
    directory: mkdtempSync(join(tmpdir(), 'uw-g004-integration-')),
  };
  const workbench = new Workbench({
    project,
    connections: [
      { name: 'dsh', adapter: new DshAcpAdapter({ dshRoot }) },
      { name: 'codex', adapter: new CodexAppServerAdapter({ launch: codex.launch }) },
    ],
    approvalTimeoutMs: 60_000,
  });
  workbench.onEvent(({ connection, event }) => {
    if (event.type === 'execution/approval-requested') {
      void workbench
        .decideApproval(connection, event.request.executionId, event.request.requestId, 'allow_once')
        .catch(() => undefined);
    }
  });
  await workbench.start();
  return { workbench, project };
}

async function waitExecution(
  workbench: Workbench,
  connection: string,
  executionId: string,
  timeoutMs = 180_000,
): Promise<Execution> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = workbench.getExecution(connection, executionId);
    if (found !== undefined && found.execution.state !== 'running') {
      return found.execution;
    }
    await delay(100);
  }
  throw new Error(`execution ${executionId} on ${connection} did not settle within ${timeoutMs}ms`);
}

async function submitAndWait(
  workbench: Workbench,
  connection: string,
  text: string,
): Promise<Execution> {
  const submitted = await workbench.submit(text, connection);
  return waitExecution(workbench, connection, submitted.execution.id);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('keeps two native conversations independent and interleaved', integrationOptions, async () => {
  const session = await openSession();
  try {
    const dshConversation = session.workbench.getConnection('dsh')?.conversation.nativeId;
    const codexConversation = session.workbench.getConnection('codex')?.conversation.nativeId;
    assert.ok(dshConversation !== undefined && codexConversation !== undefined);
    assert.notEqual(dshConversation, codexConversation);

    const dshFirstSubmission = await session.workbench.submit(
      'Remember this code word: DSH-731. Reply with exactly OK.',
      'dsh',
    );
    const codexFirstSubmission = await session.workbench.submit(
      'Remember this code word: CODEX-842. Reply with exactly OK.',
      'codex',
    );
    const [dshFirst, codexFirst] = await Promise.all([
      waitExecution(session.workbench, 'dsh', dshFirstSubmission.execution.id),
      waitExecution(session.workbench, 'codex', codexFirstSubmission.execution.id),
    ]);
    assert.equal(dshFirst.state, 'completed');
    assert.equal(codexFirst.state, 'completed');

    const dshSecondSubmission = await session.workbench.submit(
      'What code word did I ask you to remember? Reply with only the code word.',
      'dsh',
    );
    const codexSecondSubmission = await session.workbench.submit(
      'What code word did I ask you to remember? Reply with only the code word.',
      'codex',
    );
    const [dshSecond, codexSecond] = await Promise.all([
      waitExecution(session.workbench, 'dsh', dshSecondSubmission.execution.id),
      waitExecution(session.workbench, 'codex', codexSecondSubmission.execution.id),
    ]);
    assert.match(dshSecond.output, /DSH-731/);
    assert.doesNotMatch(dshSecond.output, /CODEX-842/);
    assert.match(codexSecond.output, /CODEX-842/);
    assert.doesNotMatch(codexSecond.output, /DSH-731/);

    assert.equal(session.workbench.getConnection('dsh')?.conversation.nativeId, dshConversation);
    assert.equal(session.workbench.getConnection('codex')?.conversation.nativeId, codexConversation);
  } finally {
    await session.workbench.stop().catch(() => undefined);
  }
});

test('runs one explicit plan, review and revise handoff across both harnesses', integrationOptions, async () => {
  const session = await openSession();
  try {
    const dshConversation = session.workbench.getConnection('dsh')?.conversation.nativeId;
    const codexConversation = session.workbench.getConnection('codex')?.conversation.nativeId;

    const plan = await submitAndWait(
      session.workbench,
      'dsh',
      'Propose the smallest one-line plan for the token PLAN-731 and reply with exactly that token.',
    );
    assert.equal(plan.state, 'completed');
    assert.match(plan.output, /PLAN-731/);

    const reviewRecord = await session.workbench.transfer(
      'dsh',
      plan.id,
      'codex',
      'Review the transferred plan. Reply with exactly REVIEWED-731 if the plan contains PLAN-731.',
    );
    assert.equal(reviewRecord.outcome, 'submitted');
    assert.ok(reviewRecord.target.executionId !== undefined);
    const review = await waitExecution(session.workbench, 'codex', reviewRecord.target.executionId);
    assert.equal(review.state, 'completed');
    assert.match(review.output, /REVIEWED-731/);

    const reviseRecord = await session.workbench.transfer(
      'codex',
      review.id,
      'dsh',
      'Apply the transferred review. Reply with exactly APPLIED-731.',
    );
    assert.equal(reviseRecord.outcome, 'submitted');
    assert.ok(reviseRecord.target.executionId !== undefined);
    const revise = await waitExecution(session.workbench, 'dsh', reviseRecord.target.executionId);
    assert.equal(revise.state, 'completed');
    assert.match(revise.output, /APPLIED-731/);

    const records = session.workbench.transferRecords;
    assert.equal(records.length, 2);
    assert.equal(records[0]?.source.connection, 'dsh');
    assert.equal(records[0]?.target.connection, 'codex');
    assert.equal(records[1]?.source.connection, 'codex');
    assert.equal(records[1]?.target.connection, 'dsh');
    assert.match(records[0]?.input ?? '', /PLAN-731/);
    assert.match(records[1]?.input ?? '', /REVIEWED-731/);

    const continued = await submitAndWait(
      session.workbench,
      'dsh',
      'What exact token did you just apply? Reply with only the token.',
    );
    assert.match(continued.output, /APPLIED-731/);

    assert.equal(session.workbench.getConnection('dsh')?.conversation.nativeId, dshConversation);
    assert.equal(session.workbench.getConnection('codex')?.conversation.nativeId, codexConversation);
  } finally {
    await session.workbench.stop().catch(() => undefined);
  }
});
