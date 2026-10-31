import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexAppServerAdapter } from '../../src/adapters/codex/adapter.js';
import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { createCodexConnection } from '../../src/connection.js';
import { loadFlowDefinition } from '../../src/flow-definition.js';
import { FlowRuntime } from '../../src/flow-runtime.js';
import type { Project } from '../../src/kernel.js';
import { Workbench } from '../../src/workbench.js';

const dshRoot = process.env.DSH_ROOT;
const codexExe = process.env.CODEX_EXE;
const integrationOptions = {
  skip:
    dshRoot === undefined ||
    codexExe === undefined ||
    !existsSync(join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')) ||
    !existsSync(codexExe)
      ? 'Set DSH_ROOT and CODEX_EXE to run the flow integration tests'
      : false,
  timeout: 900_000,
};

interface Session {
  readonly workbench: Workbench;
}

async function openSession(): Promise<Session> {
  if (dshRoot === undefined || codexExe === undefined) {
    throw new Error('DSH_ROOT and CODEX_EXE are required');
  }
  const codex = await createCodexConnection({ executable: codexExe });
  const project: Project = {
    id: `g005-${Date.now()}`,
    directory: mkdtempSync(join(tmpdir(), 'uw-g005-integration-')),
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
  return { workbench };
}

async function waitExecution(
  workbench: Workbench,
  connection: string,
  executionId: string,
  timeoutMs = 180_000,
) {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('runs the declarative review chain over two native conversations', integrationOptions, async () => {
  const session = await openSession();
  try {
    const dshNative = session.workbench.getConnection('dsh')?.conversation.nativeId;
    const codexNative = session.workbench.getConnection('codex')?.conversation.nativeId;
    assert.ok(dshNative !== undefined && codexNative !== undefined);

    const definition = loadFlowDefinition('examples/flows/review-chain.json');
    const runtime = new FlowRuntime(session.workbench, definition, { pollIntervalMs: 100 });
    const result = await runtime.run();

    assert.equal(result.status, 'completed');
    assert.match(result.outputs.plan ?? '', /PLAN-OK/);
    assert.match(result.outputs.review ?? '', /REVIEW-(OK|NO)/);
    assert.equal(result.nodes.plan?.status, 'completed');
    assert.equal(result.nodes.review?.status, 'completed');
    const reviewApproved = /REVIEW-OK/.test(result.outputs.review ?? '');
    assert.equal(result.nodes.revise?.status, reviewApproved ? 'pending' : 'completed');
    assert.equal(result.nodes.done?.status, 'completed');

    assert.equal(session.workbench.getConnection('dsh')?.conversation.nativeId, dshNative);
    assert.equal(session.workbench.getConnection('codex')?.conversation.nativeId, codexNative);

    const continued = await session.workbench.submit(
      'What token did your first plan reply end with? Reply with only that token.',
      'dsh',
    );
    const after = await waitExecution(session.workbench, 'dsh', continued.execution.id);
    assert.equal(after.state, 'completed');
    assert.match(after.output, /PLAN-OK/);
  } finally {
    await session.workbench.stop().catch(() => undefined);
  }
});

test('runs a parallel review flow and joins both branches', integrationOptions, async () => {
  const session = await openSession();
  try {
    const dshNative = session.workbench.getConnection('dsh')?.conversation.nativeId;
    const codexNative = session.workbench.getConnection('codex')?.conversation.nativeId;
    const definition = loadFlowDefinition('examples/flows/parallel-review.json');
    const runtime = new FlowRuntime(session.workbench, definition, { pollIntervalMs: 100 });
    const result = await runtime.run();

    assert.equal(result.status, 'completed');
    assert.match(result.outputs.plan ?? '', /PLAN-OK/);
    assert.match(result.outputs['review-a'] ?? '', /REVIEW-A-OK/);
    assert.match(result.outputs['review-b'] ?? '', /REVIEW-B-OK/);
    assert.match(result.outputs.merge ?? '', /MERGED-OK/);
    assert.equal(result.nodes['review-a']?.status, 'completed');
    assert.equal(result.nodes['review-b']?.status, 'completed');
    assert.equal(result.nodes.merge?.status, 'completed');

    assert.equal(session.workbench.getConnection('dsh')?.conversation.nativeId, dshNative);
    assert.equal(session.workbench.getConnection('codex')?.conversation.nativeId, codexNative);
  } finally {
    await session.workbench.stop().catch(() => undefined);
  }
});
