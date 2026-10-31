import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
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
import { SubmitOutcomeUnknownError } from '../src/adapters/harness.js';
import type { AttachmentDraft } from '../src/content.js';
import type { Project } from '../src/kernel.js';
import { ProjectDirectoryError } from '../src/project-directory.js';
import {
  ConversationBusyError,
  ConversationClosingError,
  SubmitFailedError,
  UnsupportedApprovalError,
  UnknownApprovalError,
  UnknownExecutionError,
  Workspace,
  type WorkspaceEvent,
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
  readonly submissions: Array<{
    nativeId: string;
    executionId: string;
    text: string;
    attachments?: readonly AttachmentDraft[];
  }> = [];
  readonly cancellations: string[] = [];
  readonly approvals: ApprovalDecision[] = [];
  readonly closed: string[] = [];
  closeError: Error | undefined;
  submitError: Error | undefined;
  closePending: Promise<void> | undefined;
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

  async submit(
    nativeId: string,
    executionId: string,
    text: string,
    attachments?: readonly AttachmentDraft[],
  ): Promise<void> {
    this.submissions.push({
      nativeId,
      executionId,
      text,
      ...(attachments === undefined ? {} : { attachments }),
    });
    if (this.submitError !== undefined) {
      throw this.submitError;
    }
  }

  async cancel(nativeId: string): Promise<void> {
    this.cancellations.push(nativeId);
  }

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
    if (this.closePending !== undefined) {
      await this.closePending;
    }
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
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
  const project = makeProject();
  const conversation = await workspace.createConversation(project);
  return { adapter, workspace, project, conversation };
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

test('associates a definite submit failure with its execution', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  adapter.submitError = new Error('native refused');
  let failure: unknown;
  await assert.rejects(workspace.submit(conversation.id, 'rejected'), (error: unknown) => {
    failure = error;
    return true;
  });
  assert.ok(failure instanceof SubmitFailedError);
  assert.equal(failure.message, 'native refused');
  assert.equal(failure.executionId, adapter.submissions[0]?.executionId);
  assert.equal(workspace.getExecution(failure.executionId)?.state, 'failed');
});

test('settles an uncertain submit as unknown and blocks until a terminal event', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  adapter.submitError = new SubmitOutcomeUnknownError('native acceptance unknown');
  await assert.rejects(workspace.submit(conversation.id, 'first'), SubmitOutcomeUnknownError);
  const executionId = adapter.submissions[0]?.executionId;
  assert.ok(executionId !== undefined);
  assert.equal(workspace.getExecution(executionId)?.state, 'unknown');

  await assert.rejects(workspace.submit(conversation.id, 'second'), ConversationBusyError);

  adapter.emit({ type: 'execution/cancelled', executionId });
  adapter.submitError = undefined;
  const third = await workspace.submit(conversation.id, 'third');
  assert.equal(third.state, 'running');
});

test('marks a preserved unknown execution as released when a terminal event arrives', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());

  adapter.submitError = new SubmitOutcomeUnknownError('native acceptance unknown');
  await assert.rejects(workspace.submit(conversation.id, 'first'), SubmitOutcomeUnknownError);
  const executionId = adapter.submissions[0]?.executionId;
  assert.ok(executionId !== undefined);

  adapter.emit({ type: 'execution/failed', executionId, error: 'late native failure' });
  assert.equal(workspace.getExecution(executionId)?.state, 'unknown');

  adapter.submitError = undefined;
  const next = await workspace.submit(conversation.id, 'next');
  assert.equal(next.state, 'running');
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

test('records attachment events, snapshots them, and ignores late attachments', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());
  const events: WorkspaceEvent[] = [];
  workspace.onEvent((event) => events.push(event));

  const execution = await workspace.submit(conversation.id, 'make an image');
  adapter.emit({
    type: 'execution/attachment',
    executionId: execution.id,
    attachment: {
      kind: 'image',
      path: 'C:\\tmp\\generated.png',
      mimeType: 'image/png',
      name: 'generated.png',
      byteLength: 123,
      id: 'adapter-supplied-id',
    } as never,
  });
  adapter.emit({
    type: 'execution/attachment',
    executionId: execution.id,
    attachment: {
      kind: 'file',
      path: 'C:\\tmp\\notes.txt',
      mimeType: 'text/plain',
      name: 'notes.txt',
    },
  });
  adapter.emit({ type: 'execution/completed', executionId: execution.id, stopReason: 'end_turn' });
  adapter.emit({
    type: 'execution/attachment',
    executionId: execution.id,
    attachment: { kind: 'image', path: 'C:\\tmp\\late.png', mimeType: 'image/png' },
  });

  const settled = workspace.getExecution(execution.id);
  assert.equal(settled?.attachments.length, 2);
  assert.equal(settled?.attachments[0]?.kind, 'image');
  assert.equal(settled?.attachments[0]?.name, 'generated.png');
  assert.equal(settled?.attachments[0]?.byteLength, 123);
  assert.notEqual(settled?.attachments[0]?.id, 'adapter-supplied-id');
  assert.equal(settled?.attachments[1]?.kind, 'file');
  assert.ok(settled?.attachments[0]?.id !== settled?.attachments[1]?.id);

  const attachmentEvents = events.filter((event) => event.type === 'execution/attachment');
  assert.equal(attachmentEvents.length, 2);

  assert.ok(settled !== undefined);
  const mutable = settled.attachments[0] as unknown as { path: string };
  mutable.path = 'tampered';
  assert.equal(workspace.getExecution(execution.id)?.attachments[0]?.path, 'C:\\tmp\\generated.png');
});

test('passes optional attachments through to the adapter', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());
  const attachment: AttachmentDraft = {
    kind: 'image',
    path: 'C:\\tmp\\input.png',
    mimeType: 'image/png',
    name: 'input.png',
  };
  const execution = await workspace.submit(conversation.id, 'look at this', [attachment]);
  assert.equal(execution.state, 'running');
  assert.deepEqual(adapter.submissions.at(-1)?.attachments, [attachment]);
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

test('rejects conversation creation when the project directory is missing', async (t) => {
  const adapter = new FakeAdapter();
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const missing = join(tmpdir(), `uw-missing-project-${Date.now()}`);

  await assert.rejects(
    workspace.createConversation({ id: 'missing', directory: missing }),
    ProjectDirectoryError,
  );
  assert.equal(adapter.projects.length, 0);
});

test('rejects conversation creation when the project path is a file', async (t) => {
  const adapter = new FakeAdapter();
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const file = join(tmpdir(), `uw-project-file-${Date.now()}`);
  writeFileSync(file, 'not a directory');

  await assert.rejects(
    workspace.createConversation({ id: 'file', directory: file }),
    ProjectDirectoryError,
  );
  assert.equal(adapter.projects.length, 0);
});

test('revalidates the project directory before submitting and does not call the adapter', async (t) => {
  const { adapter, workspace, conversation, project } = await setup();
  t.after(() => workspace.stop());
  const moved = `${project.directory}-moved`;
  renameSync(project.directory, moved);

  try {
    await assert.rejects(workspace.submit(conversation.id, 'hello'), ProjectDirectoryError);
    assert.equal(adapter.submissions.length, 0);
  } finally {
    renameSync(moved, project.directory);
  }
});

test('keeps the conversation and an unknown execution when close fails', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());
  const execution = await workspace.submit(conversation.id, 'close me');
  adapter.closeError = new Error('close timeout');

  await assert.rejects(workspace.closeConversation(conversation.id), /close timeout/);
  assert.ok(workspace.getConversation(conversation.id) !== undefined);
  assert.equal(workspace.getExecution(execution.id)?.state, 'unknown');
  await assert.rejects(workspace.submit(conversation.id, 'again'), ConversationClosingError);

  adapter.closeError = undefined;
  await workspace.closeConversation(conversation.id);
  assert.equal(workspace.getConversation(conversation.id), undefined);
});

test('rejects a submit while close is in progress', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());
  let releaseClose: () => void = () => undefined;
  adapter.closePending = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });

  const closing = workspace.closeConversation(conversation.id);
  await assert.rejects(workspace.submit(conversation.id, 'during close'), ConversationClosingError);
  releaseClose();
  await closing;

  assert.equal(workspace.getConversation(conversation.id), undefined);
  assert.equal(adapter.submissions.length, 0);
});

test('keeps an idle conversation non-submittable after a close failure', async (t) => {
  const { adapter, workspace, conversation } = await setup();
  t.after(() => workspace.stop());
  adapter.closeError = new Error('close timeout');

  await assert.rejects(workspace.closeConversation(conversation.id), /close timeout/);
  assert.ok(workspace.getConversation(conversation.id) !== undefined);
  await assert.rejects(workspace.submit(conversation.id, 'after close'), ConversationClosingError);
  assert.equal(adapter.submissions.length, 0);
});

test('does not expose mutable conversation state', async (t) => {
  const { adapter, workspace, conversation, project } = await setup();
  t.after(() => workspace.stop());
  const originalDirectory = project.directory;

  Reflect.set(conversation, 'nativeId', 'different-native');
  Reflect.set(conversation.project, 'directory', 'Z:/changed');
  Reflect.set(project, 'directory', 'Z:/changed-too');
  await workspace.submit(conversation.id, 'hello');

  assert.equal(adapter.submissions[0]?.nativeId, adapter.nativeId);
  assert.equal(adapter.projects[0]?.directory, originalDirectory);

  const fetched = workspace.getConversation(conversation.id);
  assert.equal(fetched?.nativeId, adapter.nativeId);
  assert.equal(fetched?.project.directory, originalDirectory);
  Reflect.set(fetched!, 'nativeId', 'mutated-again');
  assert.equal(workspace.getConversation(conversation.id)?.nativeId, adapter.nativeId);
});
