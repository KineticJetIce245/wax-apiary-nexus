import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import type { Project } from '../src/kernel.js';
import {
  ConversationBusyError,
  UnsupportedApprovalError,
  UnknownApprovalError,
  UnknownExecutionError,
  Workspace,
} from '../src/workspace.js';

class FakeAdapter implements HarnessAdapter {
  capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    resume: true,
  };
  readonly nativeId = 'native-1';
  readonly projects: Project[] = [];
  readonly submissions: Array<{ nativeId: string; executionId: string; text: string }> = [];
  readonly cancellations: string[] = [];
  readonly approvals: ApprovalDecision[] = [];
  readonly closed: string[] = [];
  startCalls = 0;
  stopCalls = 0;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async createConversation(project: Project): Promise<string> {
    this.projects.push(project);
    return this.nativeId;
  }

  async submit(nativeId: string, executionId: string, text: string): Promise<void> {
    this.submissions.push({ nativeId, executionId, text });
  }

  async cancel(nativeId: string): Promise<void> {
    this.cancellations.push(nativeId);
  }

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
  }

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function makeProject(): Project {
  return { id: `project-${Date.now()}`, directory: mkdtempSync(join(tmpdir(), 'uw-g002-')) };
}

function approvalEvent(
  executionId: string,
  requestId = 'request-1',
  options: readonly ApprovalOption[] = [
    { id: 'allow-once', kind: 'allow_once', label: 'Allow once' },
    { id: 'reject-once', kind: 'reject_once', label: 'Reject once' },
  ],
): { type: 'execution/approval-requested'; executionId: string; request: ApprovalRequest } {
  return {
    type: 'execution/approval-requested',
    executionId,
    request: { requestId, executionId, summary: 'Run a test command', options },
  };
}

async function setup(options: { approvalTimeoutMs?: number } = {}) {
  const adapter = new FakeAdapter();
  const workspace = new Workspace(adapter, options);
  const conversation = await workspace.createConversation(makeProject());
  return { adapter, workspace, conversation };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('rejects a second submission while the first execution is running', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'first');
  assert.equal(execution.state, 'running');
  assert.equal(adapter.submissions.length, 1);
  assert.equal(adapter.submissions[0]?.text, 'first');

  await assert.rejects(workspace.submit(conversation.id, 'second'), ConversationBusyError);
  assert.equal(adapter.submissions.length, 1);

  adapter.emit({ type: 'execution/completed', executionId: execution.id, stopReason: 'end_turn' });
  assert.equal(workspace.getExecution(execution.id)?.state, 'completed');
});

test('records assistant output and ignores late terminal events', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'hello');
  adapter.emit({
    type: 'execution/output',
    executionId: execution.id,
    channel: 'assistant',
    text: 'hello back',
  });
  adapter.emit({ type: 'execution/completed', executionId: execution.id, stopReason: 'end_turn' });
  adapter.emit({ type: 'execution/failed', executionId: execution.id, error: 'late' });

  const settled = workspace.getExecution(execution.id);
  assert.equal(settled?.state, 'completed');
  assert.equal(settled?.output, 'hello back');
});

test('settles failed and unknown executions without marking success', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const failed = await workspace.submit(conversation.id, 'fail');
  adapter.emit({ type: 'execution/failed', executionId: failed.id, error: 'boom' });
  assert.equal(workspace.getExecution(failed.id)?.state, 'failed');
  assert.equal(workspace.getExecution(failed.id)?.error, 'boom');

  const unknown = await workspace.submit(conversation.id, 'unknown');
  adapter.emit({ type: 'execution/unknown', executionId: unknown.id, reason: 'lost' });
  assert.equal(workspace.getExecution(unknown.id)?.state, 'unknown');
  assert.equal(workspace.getExecution(unknown.id)?.error, 'lost');
});

test('allows one approval and completes the execution', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'needs approval');
  adapter.emit(approvalEvent(execution.id));

  await workspace.decideApproval(execution.id, 'request-1', 'allow_once');
  assert.deepEqual(adapter.approvals, [{ requestId: 'request-1', kind: 'allow_once' }]);

  adapter.emit({ type: 'execution/completed', executionId: execution.id, stopReason: 'end_turn' });
  assert.equal(workspace.getExecution(execution.id)?.state, 'completed');
});

test('rejects an approval option the harness did not advertise', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'needs approval');
  adapter.emit(approvalEvent(execution.id, 'request-1', [
    { id: 'allow-once', kind: 'allow_once', label: 'Allow once' },
  ]));

  await assert.rejects(
    workspace.decideApproval(execution.id, 'request-1', 'reject_once'),
    UnsupportedApprovalError,
  );
  assert.equal(adapter.approvals.length, 0);
  assert.equal(workspace.getExecution(execution.id)?.state, 'running');
});

test('rejects unknown approval and execution ids', async (t) => {
  const { workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  await assert.rejects(
    workspace.decideApproval('missing-execution', 'missing-request', 'allow_once'),
    UnknownApprovalError,
  );
  await assert.rejects(workspace.cancel('missing-execution'), UnknownExecutionError);
  assert.ok(conversation.id.length > 0);
});

test('cancels an unanswered approval and the native execution', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'slow');
  adapter.emit(approvalEvent(execution.id));

  await workspace.cancel(execution.id);
  assert.deepEqual(adapter.approvals, [{ requestId: 'request-1', kind: 'cancelled' }]);
  assert.deepEqual(adapter.cancellations, [adapter.nativeId]);

  adapter.emit({ type: 'execution/cancelled', executionId: execution.id });
  assert.equal(workspace.getExecution(execution.id)?.state, 'cancelled');
});

test('times out an unanswered approval without allowing it', async (t) => {
  const { adapter, workspace, conversation } = await setup({ approvalTimeoutMs: 20 });
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'slow');
  adapter.emit(approvalEvent(execution.id));

  await delay(80);
  assert.deepEqual(adapter.approvals, [{ requestId: 'request-1', kind: 'cancelled' }]);
  assert.deepEqual(adapter.cancellations, [adapter.nativeId]);
  assert.equal(workspace.getExecution(execution.id)?.state, 'running');

  adapter.emit({ type: 'execution/cancelled', executionId: execution.id });
  assert.equal(workspace.getExecution(execution.id)?.state, 'cancelled');
});

test('close settles a running execution as cancelled', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'close me');
  await workspace.closeConversation(conversation.id);

  assert.deepEqual(adapter.closed, [adapter.nativeId]);
  assert.equal(workspace.getExecution(execution.id)?.state, 'cancelled');
});

test('stop marks running executions unknown', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'stop me');
  await workspace.stop();

  assert.equal(adapter.stopCalls, 1);
  assert.equal(workspace.getExecution(execution.id)?.state, 'unknown');
});

test('does not prompt for approval when the adapter advertises policy-only', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  adapter.capabilities = { ...adapter.capabilities, approval: 'policy-only' };
  t.after(() => workspace.stop());

  const execution = await workspace.submit(conversation.id, 'policy');
  adapter.emit(approvalEvent(execution.id));

  assert.deepEqual(adapter.approvals, [{ requestId: 'request-1', kind: 'cancelled' }]);
  assert.equal(workspace.getExecution(execution.id)?.state, 'running');
});
