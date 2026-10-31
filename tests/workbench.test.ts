import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision,
  ApprovalRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import { SubmitOutcomeUnknownError } from '../src/adapters/harness.js';
import type { Project } from '../src/kernel.js';
import { ConversationBusyError } from '../src/workspace.js';
import {
  DuplicateConnectionError,
  MAX_TRANSFER_INPUT_CHARS,
  TransferRejectedError,
  UnknownConnectionError,
  Workbench,
  buildTransferInput,
  type TaggedWorkspaceEvent,
} from '../src/workbench.js';

class FakeAdapter implements HarnessAdapter {
  capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    resume: false,
  };
  readonly submissions: Array<{ nativeId: string; executionId: string; text: string }> = [];
  readonly approvals: ApprovalDecision[] = [];
  readonly cancellations: string[] = [];
  readonly closed: string[] = [];
  startCalls = 0;
  stopCalls = 0;
  startError: Error | undefined;
  closeError: Error | undefined;
  submitError: Error | undefined;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(readonly nativeId: string) {}

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async createConversation(): Promise<string> {
    return this.nativeId;
  }

  async submit(nativeId: string, executionId: string, text: string): Promise<void> {
    this.submissions.push({ nativeId, executionId, text });
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

interface Fixture {
  readonly workbench: Workbench;
  readonly dsh: FakeAdapter;
  readonly codex: FakeAdapter;
  readonly project: Project;
}

async function fixture(): Promise<Fixture> {
  const project: Project = {
    id: `g004-${Date.now()}`,
    directory: mkdtempSync(join(tmpdir(), 'uw-g004-')),
  };
  const dsh = new FakeAdapter('native-dsh');
  const codex = new FakeAdapter('native-codex');
  const workbench = new Workbench({
    project,
    connections: [
      { name: 'dsh', adapter: dsh },
      { name: 'codex', adapter: codex },
    ],
  });
  await workbench.start();
  return { workbench, dsh, codex, project };
}

function approvalEvent(executionId: string, requestId = 'shared-request'): HarnessEvent {
  const request: ApprovalRequest = {
    requestId,
    executionId,
    summary: 'test approval',
    options: [
      { id: 'allow', kind: 'allow_once', label: 'Allow' },
      { id: 'reject', kind: 'reject_once', label: 'Reject' },
    ],
  };
  return { type: 'execution/approval-requested', executionId, request };
}

async function complete(adapter: FakeAdapter, executionId: string, output: string): Promise<void> {
  adapter.emit({ type: 'execution/output', executionId, channel: 'assistant', text: output });
  adapter.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  await delay(10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('starts two named connections with their own conversations and tags events', async () => {
  const { workbench, dsh, codex } = await fixture();
  const events: TaggedWorkspaceEvent[] = [];
  workbench.onEvent((event) => events.push(event));
  try {
    assert.deepEqual(workbench.connectionNames, ['dsh', 'codex']);
    assert.equal(workbench.activeConnection, 'dsh');
    assert.equal(workbench.getConnection('dsh')?.conversation.nativeId, 'native-dsh');
    assert.equal(workbench.getConnection('codex')?.conversation.nativeId, 'native-codex');

    const first = await workbench.submit('from dsh');
    dsh.emit({ type: 'execution/output', executionId: first.execution.id, channel: 'assistant', text: 'dsh-out' });
    await delay(10);

    assert.equal(events.length > 0, true);
    assert.equal(events.every((event) => event.connection === 'dsh'), true);
    assert.equal(events[0]?.event.type, 'execution/output');
  } finally {
    await workbench.stop();
  }
});

test('routes submissions to the selected connection and keeps prior events tagged', async () => {
  const { workbench, dsh, codex } = await fixture();
  const events: TaggedWorkspaceEvent[] = [];
  workbench.onEvent((event) => events.push(event));
  try {
    const dshExecution = await workbench.submit('dsh work');
    workbench.use('codex');
    const codexExecution = await workbench.submit('codex work');

    assert.equal(dsh.submissions.length, 1);
    assert.equal(codex.submissions.length, 1);
    assert.equal(dshExecution.connection, 'dsh');
    assert.equal(codexExecution.connection, 'codex');

    workbench.use('dsh');
    dsh.emit({ type: 'execution/output', executionId: dshExecution.execution.id, channel: 'assistant', text: 'late' });
    await delay(10);
    assert.equal(events.at(-1)?.connection, 'dsh');
  } finally {
    await workbench.stop();
  }
});

test('routes approvals by connection even when request ids collide', async () => {
  const { workbench, dsh, codex } = await fixture();
  try {
    const dshExecution = await workbench.submit('dsh needs approval');
    const codexExecution = await workbench.submit('codex needs approval', 'codex');
    dsh.emit(approvalEvent(dshExecution.execution.id, 'same-id'));
    codex.emit(approvalEvent(codexExecution.execution.id, 'same-id'));
    await delay(10);

    await workbench.decideApproval('dsh', dshExecution.execution.id, 'same-id', 'allow_once');
    assert.equal(dsh.approvals.length, 1);
    assert.equal(dsh.approvals[0]?.kind, 'allow_once');
    assert.equal(codex.approvals.length, 0);

    await workbench.decideApproval('codex', codexExecution.execution.id, 'same-id', 'reject_once');
    assert.equal(codex.approvals.length, 1);
    assert.equal(codex.approvals[0]?.kind, 'reject_once');
  } finally {
    await workbench.stop();
  }
});

test('transfers exactly one completed assistant snapshot and records source and target', async () => {
  const { workbench, dsh, codex } = await fixture();
  try {
    const source = await workbench.submit('produce a plan');
    dsh.emit({
      type: 'execution/output',
      executionId: source.execution.id,
      channel: 'thought',
      text: 'PRIVATE-THOUGHT',
    });
    await complete(dsh, source.execution.id, 'PLAN-ALPHA');

    const record = await workbench.transfer('dsh', source.execution.id, 'codex', 'review this plan');
    assert.equal(record.outcome, 'submitted');
    assert.equal(record.source.connection, 'dsh');
    assert.equal(record.source.executionId, source.execution.id);
    assert.equal(record.target.connection, 'codex');
    assert.equal(record.target.executionId, codex.submissions[0]?.executionId);
    assert.equal(record.instruction, 'review this plan');
    assert.equal(codex.submissions.length, 1);

    const sent = codex.submissions[0]?.text ?? '';
    assert.match(sent, /source connection: dsh/);
    assert.match(sent, /source execution: /);
    assert.match(sent, /instruction: review this plan/);
    assert.match(sent, /PLAN-ALPHA/);
    assert.doesNotMatch(sent, /PRIVATE-THOUGHT/);
    assert.equal((sent.match(/--- begin transferred result ---/g) ?? []).length, 1);

    assert.deepEqual(workbench.transferRecords, [record]);
    assert.equal(record.input, sent);
    assert.equal(
      sent,
      buildTransferInput({
        source: record.source,
        targetConnection: 'codex',
        output: 'PLAN-ALPHA',
        instruction: 'review this plan',
      }),
    );
  } finally {
    await workbench.stop();
  }
});

test('rejects transfers from non-completed or empty executions', async () => {
  const { workbench, dsh } = await fixture();
  try {
    const running = await workbench.submit('still running');
    await assert.rejects(
      workbench.transfer('dsh', running.execution.id, 'codex'),
      TransferRejectedError,
    );

    dsh.emit({ type: 'execution/completed', executionId: running.execution.id, stopReason: 'end_turn' });
    await delay(10);
    await assert.rejects(
      workbench.transfer('dsh', running.execution.id, 'codex'),
      /no assistant output/,
    );
    await assert.rejects(workbench.transfer('dsh', 'missing-execution', 'codex'), /Unknown execution/);
  } finally {
    await workbench.stop();
  }
});

test('rejects a transfer when the target is busy without queuing another submit', async () => {
  const { workbench, dsh, codex } = await fixture();
  try {
    const source = await workbench.submit('source');
    await complete(dsh, source.execution.id, 'SOURCE-OUTPUT');
    await workbench.submit('target busy', 'codex');
    const targetSubmits = codex.submissions.length;

    await assert.rejects(
      workbench.transfer('dsh', source.execution.id, 'codex'),
      ConversationBusyError,
    );
    assert.equal(codex.submissions.length, targetSubmits);
    assert.equal(workbench.transferRecords.length, 0);
  } finally {
    await workbench.stop();
  }
});

test('records an unknown target submit without retrying and keeps the target busy', async () => {
  const { workbench, dsh, codex } = await fixture();
  try {
    const source = await workbench.submit('source');
    await complete(dsh, source.execution.id, 'SOURCE-OUTPUT');
    codex.submitError = new SubmitOutcomeUnknownError('unknown acceptance', 'unknown-exec');

    await assert.rejects(
      workbench.transfer('dsh', source.execution.id, 'codex'),
      SubmitOutcomeUnknownError,
    );
    const records = workbench.transferRecords;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, 'unknown');
    assert.equal(records[0]?.target.executionId, 'unknown-exec');
    assert.equal(records[0]?.input.includes('SOURCE-OUTPUT'), true);

    codex.submitError = undefined;
    await assert.rejects(
      workbench.transfer('dsh', source.execution.id, 'codex'),
      ConversationBusyError,
    );
    assert.equal(codex.submissions.length, 1);
  } finally {
    await workbench.stop();
  }
});

test('keeps one connection usable when the other fails to start', async () => {
  const project: Project = {
    id: 'g004-start-failure',
    directory: mkdtempSync(join(tmpdir(), 'uw-g004-')),
  };
  const broken = new FakeAdapter('native-broken');
  broken.startError = new Error('engine missing');
  const healthy = new FakeAdapter('native-healthy');
  const workbench = new Workbench({
    project,
    connections: [
      { name: 'broken', adapter: broken },
      { name: 'healthy', adapter: healthy },
    ],
  });

  try {
    await workbench.start();
    assert.deepEqual(workbench.connectionNames, ['healthy']);
    assert.equal(workbench.activeConnection, 'healthy');
    assert.equal(workbench.connectionFailures.length, 1);
    assert.match(workbench.connectionFailures[0]?.message ?? '', /engine missing/);
    assert.equal(broken.stopCalls, 1);
    assert.throws(() => workbench.use('broken'), UnknownConnectionError);

    const execution = await workbench.submit('healthy work');
    assert.equal(execution.connection, 'healthy');
  } finally {
    await workbench.stop();
  }
});

test('stops both connections even when one close fails', async () => {
  const { workbench, dsh, codex } = await fixture();
  codex.closeError = new Error('close refused');
  try {
    await assert.rejects(workbench.stop(), AggregateError);
    assert.equal(dsh.closed.length, 1);
    assert.equal(codex.closed.length, 1);
    assert.equal(dsh.stopCalls, 1);
    assert.equal(codex.stopCalls, 1);
  } finally {
    // stop already attempted both connections.
  }
});

test('keeps the other connection usable after one close fails', async () => {
  const { workbench, dsh, codex } = await fixture();
  codex.closeError = new Error('close refused');
  try {
    await assert.rejects(workbench.closeConnection('codex'), /close refused/);
    assert.equal(workbench.getConnection('codex')?.status, 'closing-failed');
    const execution = await workbench.submit('dsh still works', 'dsh');
    assert.equal(execution.connection, 'dsh');
    await assert.rejects(workbench.submit('blocked', 'codex'), /not usable|closing/i);
  } finally {
    await workbench.stop().catch(() => undefined);
  }
});

test('routes a one-sided connection loss without touching the other execution', async () => {
  const { workbench, dsh, codex } = await fixture();
  try {
    const dshExecution = await workbench.submit('dsh running');
    const codexExecution = await workbench.submit('codex running', 'codex');
    dsh.emit({
      type: 'execution/unknown',
      executionId: dshExecution.execution.id,
      reason: 'dsh process exited',
    });
    await delay(10);

    assert.equal(
      workbench.getExecution('dsh', dshExecution.execution.id)?.execution.state,
      'unknown',
    );
    assert.equal(
      workbench.getExecution('codex', codexExecution.execution.id)?.execution.state,
      'running',
    );
  } finally {
    await workbench.stop();
  }
});

test('rejects a transfer whose assembled input exceeds the local guard', async () => {
  const { workbench, dsh } = await fixture();
  try {
    const source = await workbench.submit('very large');
    await complete(dsh, source.execution.id, 'x'.repeat(MAX_TRANSFER_INPUT_CHARS));
    await assert.rejects(
      workbench.transfer('dsh', source.execution.id, 'codex'),
      /above the local guard/,
    );
    assert.equal(workbench.transferRecords.length, 0);
  } finally {
    await workbench.stop();
  }
});

test('rejects duplicate connection names before starting either adapter', async () => {
  const project: Project = {
    id: 'g004-duplicate',
    directory: mkdtempSync(join(tmpdir(), 'uw-g004-')),
  };
  const first = new FakeAdapter('native-1');
  const second = new FakeAdapter('native-2');
  const workbench = new Workbench({
    project,
    connections: [
      { name: 'same', adapter: first },
      { name: 'same', adapter: second },
    ],
  });

  await assert.rejects(workbench.start(), DuplicateConnectionError);
  assert.equal(first.startCalls, 0);
  assert.equal(second.startCalls, 0);
});
