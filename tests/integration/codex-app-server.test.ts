import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexAppServerAdapter } from '../../src/adapters/codex/adapter.js';
import { createCodexConnection } from '../../src/connection.js';
import type { Project } from '../../src/kernel.js';
import { Workspace } from '../../src/workspace.js';

const codexExe = process.env.CODEX_EXE;
const integrationOptions = {
  skip:
    codexExe === undefined || !existsSync(codexExe)
      ? 'Set CODEX_EXE to the Codex CLI executable to run Codex integration tests'
      : false,
  timeout: 300_000,
};

interface Session {
  readonly adapter: CodexAppServerAdapter;
  readonly workspace: Workspace;
  readonly project: Project;
  readonly conversationId: string;
  readonly version: string;
}

async function openSession(): Promise<Session> {
  if (codexExe === undefined) {
    throw new Error('CODEX_EXE is not set');
  }
  const connection = await createCodexConnection({ executable: codexExe });
  const directory = mkdtempSync(join(tmpdir(), 'uw-g003-integration-'));
  const project: Project = { id: `project-${Date.now()}`, directory };
  const adapter = new CodexAppServerAdapter({ launch: connection.launch });
  await adapter.start();
  const workspace = new Workspace(adapter, { approvalTimeoutMs: 60_000 });
  const conversation = await workspace.createConversation(project);
  return {
    adapter,
    workspace,
    project,
    conversationId: conversation.id,
    version: connection.version.version,
  };
}

async function closeSession(session: Session): Promise<void> {
  try {
    await session.workspace.closeConversation(session.conversationId);
  } catch {
    // Cleanup must not mask the assertion result.
  }
  await session.workspace.stop().catch(() => undefined);
}

async function waitForSettled(session: Session, executionId: string, timeoutMs = 180_000) {
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

test('keeps one native thread across two prompts and reads a project file', integrationOptions, async () => {
  const session = await openSession();
  try {
    const marker = 'G003-NATIVE-MARKER';
    writeFileSync(join(session.project.directory, 'marker.txt'), marker, 'utf8');

    const first = await session.workspace.submit(
      session.conversationId,
      'Read marker.txt in the current directory and reply with exactly the token it contains, nothing else.',
    );
    const firstResult = await waitForSettled(session, first.id);
    assert.equal(firstResult.state, 'completed');
    assert.match(firstResult.output, new RegExp(marker));

    const second = await session.workspace.submit(
      session.conversationId,
      'Without reading any file, reply with the exact token I asked you to read in the previous turn.',
    );
    const secondResult = await waitForSettled(session, second.id);
    assert.equal(secondResult.state, 'completed');
    assert.match(secondResult.output, new RegExp(marker));
  } finally {
    await closeSession(session);
  }
});

test('relays a real approval and allows the file write', integrationOptions, async () => {
  const session = await openSession();
  let approvals = 0;
  let approvalFailure: unknown;
  const unsubscribe = session.workspace.onEvent((event) => {
    if (event.type === 'execution/approval-requested') {
      approvals += 1;
      void session.workspace
        .decideApproval(event.executionId, event.request.requestId, 'allow_once')
        .catch((error: unknown) => {
          approvalFailure = error;
        });
    }
  });

  try {
    const execution = await session.workspace.submit(
      session.conversationId,
      'Create a new file named approved.txt in the current directory containing exactly APPROVED-OK. Use your file editing tool. Do not use any other directory.',
    );
    const result = await waitForSettled(session, execution.id);
    assert.equal(approvalFailure, undefined);
    assert.equal(approvals > 0, true, 'expected at least one real Codex approval request');
    assert.equal(result.state, 'completed');
    assert.equal(readFileSync(join(session.project.directory, 'approved.txt'), 'utf8'), 'APPROVED-OK');
  } finally {
    unsubscribe();
    await closeSession(session);
  }
});

test('rejects a real approval without writing the file', integrationOptions, async () => {
  const session = await openSession();
  let approvals = 0;
  const unsubscribe = session.workspace.onEvent((event) => {
    if (event.type === 'execution/approval-requested') {
      approvals += 1;
      void session.workspace
        .decideApproval(event.executionId, event.request.requestId, 'reject_once')
        .catch(() => undefined);
    }
  });

  try {
    const execution = await session.workspace.submit(
      session.conversationId,
      'Create a new file named denied.txt in the current directory containing exactly DENIED-OK. Use your file editing tool. Do not use any other directory.',
    );
    await waitForSettled(session, execution.id);
    assert.equal(approvals > 0, true, 'expected a real Codex approval request');
    assert.equal(existsSync(join(session.project.directory, 'denied.txt')), false);
  } finally {
    unsubscribe();
    await closeSession(session);
  }
});

test('cancels a real Codex turn through turn/interrupt', integrationOptions, async () => {
  const session = await openSession();
  try {
    const execution = await session.workspace.submit(
      session.conversationId,
      'Run the shell command `node -e "setTimeout(() => {}, 60000)"` in the current directory and wait for it to finish. Do not answer before it finishes.',
    );
    await delay(4_000);
    await session.workspace.cancel(execution.id);
    const result = await waitForSettled(session, execution.id);
    assert.equal(result.state, 'cancelled');
  } finally {
    await closeSession(session);
  }
});

test('marks a running execution unknown when the app-server exits', integrationOptions, async () => {
  const session = await openSession();
  try {
    const execution = await session.workspace.submit(
      session.conversationId,
      'Run the shell command `node -e "setTimeout(() => {}, 60000)"` in the current directory and wait for it to finish. Do not answer before it finishes.',
    );
    await delay(4_000);
    await session.adapter.stop();
    const result = await waitForSettled(session, execution.id, 30_000);
    assert.equal(result.state, 'unknown');
  } finally {
    await closeSession(session);
  }
});
