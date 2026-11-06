import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import type { ApprovalRequest } from '../../src/adapters/harness.js';
import type { Project } from '../../src/project/kernel.js';
import { Workspace } from '../../src/session/workspace.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli = dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli)
      ? 'Set DSH_ROOT to a built DeepSeek Harness checkout to run integration tests'
      : false,
  timeout: 180_000,
};

interface Session {
  readonly adapter: DshAcpAdapter;
  readonly workspace: Workspace;
  readonly project: Project;
  readonly conversationId: string;
}

async function openSession(options: { permissionMode?: string } = {}): Promise<Session> {
  const root = dshRoot;
  if (root === undefined) {
    throw new Error('DSH_ROOT is not set');
  }
  const directory = mkdtempSync(join(tmpdir(), 'uw-g002-integration-'));
  const project: Project = { id: `project-${Date.now()}`, directory };
  const adapter = new DshAcpAdapter({
    dshRoot: root,
    ...(options.permissionMode === undefined
      ? {}
      : { env: { DSH_PERMISSION_MODE: options.permissionMode } }),
  });
  await adapter.start();
  const workspace = new Workspace(adapter, { approvalTimeoutMs: 30_000 });
  const conversation = await workspace.createConversation(project);
  return { adapter, workspace, project, conversationId: conversation.id };
}

async function closeSession(session: Session): Promise<void> {
  try {
    await session.workspace.closeConversation(session.conversationId);
  } catch {
    // The assertion result should not be masked by cleanup.
  }
  await session.workspace.stop().catch(() => undefined);
}

async function waitForSettled(session: Session, executionId: string, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const execution = session.workspace.getExecution(executionId);
    if (execution !== undefined && execution.state !== 'running') {
      return execution;
    }
    await delay(100);
  }
  throw new Error(`execution did not settle within ${timeoutMs}ms: ${executionId}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('keeps context across two prompts in the same native session', integrationOptions, async () => {
  const session = await openSession();
  try {
    const first = await session.workspace.submit(
      session.conversationId,
      'Remember this code word: ORANGE-731. Reply with just OK.',
    );
    const firstResult = await waitForSettled(session, first.id);
    assert.equal(firstResult.state, 'completed');

    const second = await session.workspace.submit(
      session.conversationId,
      'What code word did I give you? Reply with just the code word.',
    );
    const secondResult = await waitForSettled(session, second.id);
    assert.equal(secondResult.state, 'completed');
    assert.match(secondResult.output, /ORANGE-731/);
  } finally {
    await closeSession(session);
  }
});

test('reads a file from the project working directory', integrationOptions, async () => {
  const session = await openSession();
  try {
    const marker = `G002-PROBE-${Date.now()}`;
    writeFileSync(join(session.project.directory, 'probe.txt'), marker, 'utf8');

    const execution = await session.workspace.submit(
      session.conversationId,
      'Read the file probe.txt in the current working directory and reply with its exact contents. Do not read any other directory.',
    );
    const result = await waitForSettled(session, execution.id);
    assert.equal(result.state, 'completed');
    assert.match(result.output, new RegExp(marker));
  } finally {
    await closeSession(session);
  }
});

test('relays a real permission request and allows the tool once', integrationOptions, async () => {
  const session = await openSession({ permissionMode: 'read-only' });
  let sawApproval = false;
  let approval: ApprovalRequest | undefined;
  let approvalFailure: unknown;
  const unsubscribe = session.workspace.onEvent((event) => {
    if (event.type === 'execution/approval-requested') {
      sawApproval = true;
      approval = event.request;
      void session.workspace
        .decideApproval(event.executionId, event.request.requestId, 'allow_once')
        .catch((error: unknown) => {
          approvalFailure = error;
        });
    }
  });

  try {
    const marker = `APPROVED-WRITE-${Date.now()}`;
    const execution = await session.workspace.submit(
      session.conversationId,
      `Use the shell tool to create a file named approved.txt in the current directory with the exact content ${marker}. Report done. Do not use any other directory.`,
    );
    const result = await waitForSettled(session, execution.id);

    assert.equal(approvalFailure, undefined);
    assert.equal(sawApproval, true, 'expected a real ACP permission request');
    assert.ok(approval !== undefined);
    assert.equal(result.state, 'completed');

    const written = existsSync(join(session.project.directory, 'approved.txt'))
      ? readFileSync(join(session.project.directory, 'approved.txt'), 'utf8')
      : undefined;
    assert.equal(written, marker);
  } finally {
    unsubscribe();
    await closeSession(session);
  }
});

test('rejects a real permission request without creating the file', integrationOptions, async () => {
  const session = await openSession({ permissionMode: 'read-only' });
  let sawApproval = false;
  const unsubscribe = session.workspace.onEvent((event) => {
    if (event.type === 'execution/approval-requested') {
      sawApproval = true;
      void session.workspace
        .decideApproval(event.executionId, event.request.requestId, 'reject_once')
        .catch(() => undefined);
    }
  });

  try {
    const execution = await session.workspace.submit(
      session.conversationId,
      'Use the shell tool to create a file named rejected.txt in the current directory. Report done. Do not use any other directory.',
    );
    await waitForSettled(session, execution.id);

    assert.equal(sawApproval, true, 'expected a real ACP permission request');
    assert.equal(existsSync(join(session.project.directory, 'rejected.txt')), false);
  } finally {
    unsubscribe();
    await closeSession(session);
  }
});

test('cancels a real execution and settles it as cancelled', integrationOptions, async () => {
  const session = await openSession();
  try {
    const execution = await session.workspace.submit(
      session.conversationId,
      'Use the shell tool to run the command `node -e "setTimeout(() => {}, 20000)"` in the current directory and then report done. Do not answer before the command finishes.',
    );
    await delay(2_500);
    await session.workspace.cancel(execution.id);
    const result = await waitForSettled(session, execution.id);
    assert.equal(result.state, 'cancelled');
  } finally {
    await closeSession(session);
  }
});

test('marks a running execution unknown when the ACP process exits', integrationOptions, async () => {
  const session = await openSession();
  try {
    const execution = await session.workspace.submit(
      session.conversationId,
      'Use the shell tool to run the command `node -e "setTimeout(() => {}, 20000)"` in the current directory and then report done. Do not answer before the command finishes.',
    );
    await delay(1_500);
    await session.adapter.stop();
    const result = await waitForSettled(session, execution.id);
    assert.equal(result.state, 'unknown');
  } finally {
    await closeSession(session);
  }
});
