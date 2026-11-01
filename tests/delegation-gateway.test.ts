import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SubmitOutcomeUnknownError,
  type ApprovalDecision,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
} from '../src/adapters/harness.js';
import { CollaborationGateway } from '../src/collaboration-gateway.js';
import { DelegationLedger, readLedgerFile } from '../src/delegation-ledger.js';
import type { DelegationPolicy } from '../src/delegation-policy.js';
import type { Project } from '../src/kernel.js';
import { Workbench } from '../src/workbench.js';

interface FakeOptions {
  readonly hang?: boolean;
  readonly submitDelayMs?: number;
  readonly submitError?: Error;
}

class FakeAdapter implements HarnessAdapter {
  capabilities: HarnessCapabilities = {
    approval: 'none',
    cancel: true,
    streaming: true,
    resume: false,
  };
  readonly submissions: string[] = [];
  readonly cancels: string[] = [];
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly active = new Set<string>();

  constructor(
    readonly nativeId: string,
    private readonly options: FakeOptions = {},
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> {
    return this.nativeId;
  }
  async submit(_nativeId: string, executionId: string, text: string): Promise<void> {
    this.submissions.push(text);
    if (this.options.submitError !== undefined) {
      throw this.options.submitError;
    }
    if (this.options.submitDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.options.submitDelayMs));
    }
    if (this.options.hang === true) {
      this.active.add(executionId);
      return;
    }
    setTimeout(() => {
      this.emit({ type: 'execution/output', executionId, channel: 'assistant', text: 'WORKER-OK' });
      this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, 0);
  }
  async cancel(_nativeId: string, executionId?: string): Promise<void> {
    for (const id of executionId === undefined ? [...this.active] : [executionId]) {
      this.cancels.push(id);
      this.active.delete(id);
      this.emit({ type: 'execution/cancelled', executionId: id });
    }
  }
  async respondToApproval(_decision: ApprovalDecision): Promise<void> {}
  async closeConversation(): Promise<void> {}
  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function policy(overrides: Partial<DelegationPolicy> = {}): DelegationPolicy {
  return {
    requester: 'operator',
    basis: 'policy',
    allowedWorkers: ['dsh'],
    maxTaskChars: 20_000,
    maxConcurrent: 1,
    ttlMs: 60_000,
    policyVersion: 'g010-test',
    ...overrides,
  };
}

async function setup(
  options: {
    stateDirectory?: string;
    policy?: DelegationPolicy;
    asyncTimeoutMs?: number;
    resultMaxBytes?: number;
  } & FakeOptions = {},
) {
  const project: Project = {
    id: `g010-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    directory: mkdtempSync(join(tmpdir(), 'uw-g010-project-')),
  };
  const dsh = new FakeAdapter('dsh-native', options);
  const workbench = new Workbench({ project, connections: [{ name: 'dsh', adapter: dsh }] });
  await workbench.start();
  const stateDirectory = options.stateDirectory ?? mkdtempSync(join(tmpdir(), 'uw-g010-state-'));
  const gateway = new CollaborationGateway(workbench, {
    pollIntervalMs: 5,
    stateDirectory,
    policy: options.policy ?? policy(),
    ...(options.asyncTimeoutMs === undefined ? {} : { asyncTimeoutMs: options.asyncTimeoutMs }),
    ...(options.resultMaxBytes === undefined ? {} : { resultMaxBytes: options.resultMaxBytes }),
  });
  const info = await gateway.start();
  return { dsh, workbench, gateway, info, stateDirectory };
}

async function cleanup(context: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await context.gateway.stop().catch(() => undefined);
  await context.workbench.stop().catch(() => undefined);
}

function delegate(
  info: { url: string; token: string },
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(info.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}`, ...headers },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test('records an authorized delegation, settles it, and keeps the facts on disk', async () => {
  const context = await setup();
  try {
    const response = await delegate(context.info, { task: 'reply WORKER-OK' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      worker: string;
      output: string;
      workItemId: string;
      mandateId: string;
    };
    assert.equal(body.worker, 'dsh');
    assert.equal(body.output, 'WORKER-OK');
    assert.equal(body.mandateId, context.gateway.mandateInfo?.id);

    const items = context.gateway.workItems;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, body.workItemId);
    assert.equal(items[0]?.state, 'completed');
    assert.equal(items[0]?.requester, 'operator');
    assert.equal(items[0]?.basis, 'policy');
    assert.equal(items[0]?.policyVersion, 'g010-test');
    assert.equal(items[0]?.taskDigest.length, 64);
    assert.deepEqual(context.dsh.submissions, ['reply WORKER-OK']);

    const read = readLedgerFile(join(context.stateDirectory, 'ledger.jsonl'));
    assert.deepEqual(
      read.entries.map((entry) => entry.type),
      ['work-item/created', 'delivery/intent', 'delivery/submitted', 'delivery/settled'],
    );
  } finally {
    await cleanup(context);
  }
});

test('rejects a worker outside the policy without submitting it', async () => {
  const context = await setup();
  try {
    const response = await delegate(context.info, { task: 'x', worker: 'codex' });
    assert.equal(response.status, 403);
    assert.equal(context.dsh.submissions.length, 0);
    assert.equal(context.gateway.workItems.length, 0);
    const read = readLedgerFile(join(context.stateDirectory, 'ledger.jsonl'));
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0]?.type, 'gate/rejected');
    assert.equal(read.entries[0]?.data.code, 'worker-not-allowed');
  } finally {
    await cleanup(context);
  }
});

test('checks the worker allowlist before the task bound', async () => {
  const context = await setup({ policy: policy({ maxTaskChars: 16 }) });
  try {
    const response = await delegate(context.info, { task: 'x'.repeat(64), worker: 'codex' });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /not allowed by policy/);
    assert.equal(context.dsh.submissions.length, 0);
    const read = readLedgerFile(join(context.stateDirectory, 'ledger.jsonl'));
    assert.equal(read.entries[0]?.data.code, 'worker-not-allowed');
  } finally {
    await cleanup(context);
  }
});

test('rejects authorization claims in the tool arguments', async () => {
  const context = await setup();
  try {
    const response = await delegate(context.info, { task: 'x', basis: 'explicit' });
    assert.equal(response.status, 400);
    assert.equal(context.dsh.submissions.length, 0);
    const read = readLedgerFile(join(context.stateDirectory, 'ledger.jsonl'));
    assert.equal(read.entries.length, 0);
  } finally {
    await cleanup(context);
  }
});

test('rejects an expired mandate', async () => {
  const context = await setup({ policy: policy({ ttlMs: 1 }) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    const response = await delegate(context.info, { task: 'x' });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /expired/);
    assert.equal(context.dsh.submissions.length, 0);
  } finally {
    await cleanup(context);
  }
});

test('turns a repeated idempotency key into one work item', async () => {
  const context = await setup();
  try {
    const first = await delegate(context.info, { task: 'once' }, { 'idempotency-key': 'call-1' });
    assert.equal(first.status, 200);
    const second = await delegate(context.info, { task: 'once' }, { 'idempotency-key': 'call-1' });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string };
    assert.match(body.error, /Duplicate delegation key/);
    assert.equal(context.dsh.submissions.length, 1);
    assert.equal(context.gateway.workItems.length, 1);
  } finally {
    await cleanup(context);
  }
});

test('enforces the concurrency limit', async () => {
  const context = await setup({ hang: true });
  try {
    const pending = delegate(context.info, { task: 'slow' });
    void pending.catch(() => undefined);
    await waitUntil(() => context.dsh.submissions.length === 1);
    const second = await delegate(context.info, { task: 'second' });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string };
    assert.match(body.error, /concurrency limit/);
    assert.equal(context.dsh.submissions.length, 1);
  } finally {
    await cleanup(context);
  }
});

test('reports and never replays unsettled work items after a restart', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'uw-g010-restart-'));
  const ledger = DelegationLedger.open({ directory: stateDirectory });
  try {
    ledger.append('work-item/created', {
      id: 'w-crashed',
      mandateId: 'm-1',
      requester: 'operator',
      basis: 'policy',
      policyVersion: 'g010-test',
      worker: 'dsh',
      taskLength: 4,
      taskDigest: 'a'.repeat(64),
    });
    ledger.append('delivery/intent', { id: 'w-crashed' });
    ledger.append('delivery/submitted', { id: 'w-crashed', executionId: 'exec-1' });
  } finally {
    ledger.close();
  }

  const context = await setup({ stateDirectory });
  try {
    const report = context.gateway.getRecoveryReport();
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0]?.id, 'w-crashed');
    assert.equal(report.items[0]?.state, 'in-flight');
    assert.match(report.note, /Do not replay a delegation automatically/);
    assert.equal(report.tornTail, false);
    // Starting the gateway must not resubmit anything.
    assert.equal(context.dsh.submissions.length, 0);
  } finally {
    await cleanup(context);
  }
});

test('includes an unknown outcome in the recovery report', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'uw-g010-unknown-'));
  const ledger = DelegationLedger.open({ directory: stateDirectory });
  try {
    ledger.append('work-item/created', {
      id: 'w-unknown',
      mandateId: 'm-1',
      requester: 'operator',
      basis: 'policy',
      policyVersion: 'g010-test',
      worker: 'dsh',
      taskLength: 4,
      taskDigest: 'a'.repeat(64),
    });
    ledger.append('delivery/intent', { id: 'w-unknown' });
    ledger.append('delivery/settled', { id: 'w-unknown', state: 'unknown', error: 'accept timeout' });
  } finally {
    ledger.close();
  }

  const context = await setup({ stateDirectory });
  try {
    const report = context.gateway.getRecoveryReport();
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0]?.state, 'unknown');
    assert.match(report.note, /unknown/);
  } finally {
    await cleanup(context);
  }
});

test('refuses new delegations while an unrepairable ledger tail exists', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'uw-g010-torn-'));
  const entry = {
    seq: 1,
    writer: 'previous',
    at: new Date().toISOString(),
    type: 'work-item/created',
    data: {
      id: 'w-torn',
      mandateId: 'm',
      requester: 'operator',
      basis: 'policy',
      policyVersion: 'v',
      worker: 'dsh',
      taskLength: 1,
      taskDigest: 'a'.repeat(64),
    },
  };
  writeFileSync(
    join(stateDirectory, 'ledger.jsonl'),
    `${JSON.stringify(entry)}\n{"seq":2,"writer":"previous"`,
    'utf8',
  );

  const context = await setup({ stateDirectory });
  try {
    const report = context.gateway.getRecoveryReport();
    assert.equal(report.tornTail, true);
    assert.equal(report.items.length, 1);
    const response = await delegate(context.info, { task: 'x' });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /manual repair/);
    assert.equal(context.dsh.submissions.length, 0);
  } finally {
    await cleanup(context);
  }
});

test('recovers when the repaired ledger is replaced atomically', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'uw-g010-replace-'));
  const entry = {
    seq: 1,
    writer: 'previous',
    at: new Date().toISOString(),
    type: 'work-item/created',
    data: {
      id: 'w-replaced',
      mandateId: 'm',
      requester: 'operator',
      basis: 'policy',
      policyVersion: 'v',
      worker: 'dsh',
      taskLength: 1,
      taskDigest: 'a'.repeat(64),
    },
  };
  const ledgerPath = join(stateDirectory, 'ledger.jsonl');
  writeFileSync(ledgerPath, `${JSON.stringify(entry)}\n{"seq":2,"writer":"previous"`, 'utf8');

  const context = await setup({ stateDirectory });
  try {
    const blocked = await delegate(context.info, { task: 'x' });
    assert.equal(blocked.status, 503);

    // Operator repairs by writing a new file and renaming it over the ledger:
    // the old descriptor now points at an unlinked inode.
    const repaired = join(stateDirectory, 'ledger.repaired');
    writeFileSync(repaired, `${JSON.stringify(entry)}\n`, 'utf8');
    rmSync(ledgerPath);
    renameSync(repaired, ledgerPath);

    const response = await delegate(context.info, { task: 'after replacement' });
    assert.equal(response.status, 200);

    const read = readLedgerFile(ledgerPath);
    assert.deepEqual(
      read.entries.map((line) => line.type),
      [
        'work-item/created',
        'work-item/created',
        'delivery/intent',
        'delivery/submitted',
        'delivery/settled',
      ],
    );
    assert.equal(context.gateway.workItems.length, 2);
  } finally {
    await cleanup(context);
  }
});

test('reports an unknown submit outcome instead of claiming failure', async () => {
  const context = await setup({
    submitError: new SubmitOutcomeUnknownError('native turn acceptance is unknown'),
  });
  try {
    const response = await delegate(context.info, { task: 'x' });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /outcome is unknown/);
    const item = context.gateway.workItems[0];
    assert.equal(item?.state, 'unknown');
    // The Workspace knows the execution id it created; the ledger must name it.
    assert.equal(typeof item?.executionId, 'string');
    assert.equal(context.dsh.submissions.length, 1);
  } finally {
    await cleanup(context);
  }
});

test('caps a long worker error at the documented limit', async () => {
  const context = await setup({ submitError: new Error('x'.repeat(5_000)) });
  try {
    const response = await delegate(context.info, { task: 'x' });
    assert.equal(response.status, 502);
    const read = readLedgerFile(join(context.stateDirectory, 'ledger.jsonl'));
    const settled = read.entries.find((entry) => entry.type === 'delivery/settled');
    assert.equal(typeof settled?.data.error, 'string');
    assert.equal((settled?.data.error as string).length, 2000);
  } finally {
    await cleanup(context);
  }
});

test('recovers from a repaired ledger tail without a restart', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'uw-g010-repair-'));
  const entry = {
    seq: 1,
    writer: 'previous',
    at: new Date().toISOString(),
    type: 'work-item/created',
    data: {
      id: 'w-repaired',
      mandateId: 'm',
      requester: 'operator',
      basis: 'policy',
      policyVersion: 'v',
      worker: 'dsh',
      taskLength: 1,
      taskDigest: 'a'.repeat(64),
    },
  };
  const ledgerPath = join(stateDirectory, 'ledger.jsonl');
  writeFileSync(ledgerPath, `${JSON.stringify(entry)}\n{"seq":2,"writer":"previous"`, 'utf8');

  const context = await setup({ stateDirectory });
  try {
    const blocked = await delegate(context.info, { task: 'x' });
    assert.equal(blocked.status, 503);
    // Operator repairs the torn fragment by hand: keep only complete records.
    writeFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
    const response = await delegate(context.info, { task: 'after repair' });
    assert.equal(response.status, 200);
    assert.equal(context.dsh.submissions.length, 1);
  } finally {
    await cleanup(context);
  }
});

test('records a definite submit failure with its execution id', async () => {
  const context = await setup({ submitError: new Error('harness refused the turn') });
  try {
    const response = await delegate(context.info, { task: 'x' });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /failed to accept/);
    const item = context.gateway.workItems[0];
    assert.equal(item?.state, 'failed');
    assert.equal(typeof item?.executionId, 'string');
  } finally {
    await cleanup(context);
  }
});

test('cancels the worker and settles the item when the client disconnects', async () => {
  const context = await setup({ hang: true });
  try {
    const controller = new AbortController();
    const pending = delegate(context.info, { task: 'slow' }, {}, controller.signal);
    void pending.catch(() => undefined);
    await waitUntil(() => context.dsh.submissions.length === 1);
    controller.abort();
    await waitUntil(() => {
      const state = context.gateway.workItems[0]?.state;
      return state === 'cancelled' || state === 'unknown';
    });
    assert.equal(context.dsh.cancels.length, 1);
    assert.equal(context.dsh.submissions.length, 1);
  } finally {
    await cleanup(context);
  }
});

test('keeps the execution id when the client disconnects during submission', async () => {
  const context = await setup({ hang: true, submitDelayMs: 150 });
  try {
    const controller = new AbortController();
    const pending = delegate(context.info, { task: 'slow submit' }, {}, controller.signal);
    void pending.catch(() => undefined);
    await waitUntil(() => context.dsh.submissions.length === 1);
    controller.abort();
    await assert.rejects(pending);
    await waitUntil(() => {
      const state = context.gateway.workItems[0]?.state;
      return state === 'cancelled' || state === 'unknown';
    });
    assert.equal(context.dsh.cancels.length, 1);
    const read = readLedgerFile(join(context.stateDirectory, 'ledger.jsonl'));
    assert.deepEqual(
      read.entries.map((entry) => entry.type),
      ['work-item/created', 'delivery/intent', 'delivery/submitted', 'delivery/settled'],
    );
    const submitted = read.entries.find((entry) => entry.type === 'delivery/submitted');
    assert.equal(typeof submitted?.data.executionId, 'string');
  } finally {
    await cleanup(context);
  }
});

function gatewayOrigin(info: { url: string }): string {
  return new URL(info.url).origin;
}

function startAsync(
  info: { url: string; token: string },
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${gatewayOrigin(info)}/delegations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

function getStatus(info: { url: string; token: string }, workItemId: string): Promise<Response> {
  return fetch(`${gatewayOrigin(info)}/delegations/${workItemId}`, {
    headers: { authorization: `Bearer ${info.token}` },
  });
}

test('accepts an async delegation, answers 202, and serves the stored result', async () => {
  const context = await setup();
  try {
    const response = await startAsync(context.info, { task: 'reply WORKER-OK' });
    assert.equal(response.status, 202);
    const accepted = (await response.json()) as { workItemId: string; state: string; executionId: string };
    assert.equal(accepted.state, 'accepted');
    assert.equal(typeof accepted.workItemId, 'string');

    await waitUntil(() => context.gateway.workItems[0]?.state === 'completed');
    const status = await getStatus(context.info, accepted.workItemId);
    assert.equal(status.status, 200);
    const body = (await status.json()) as { state: string; output: string; executionId: string };
    assert.equal(body.state, 'completed');
    assert.equal(body.output, 'WORKER-OK');
    assert.equal(body.executionId, accepted.executionId);

    const read = readLedgerFile(join(context.stateDirectory, 'ledger.jsonl'));
    const settled = read.entries.find((entry) => entry.type === 'delivery/settled');
    assert.equal(typeof settled?.data.resultFile, 'string');
    assert.equal(settled?.data.resultTruncated, false);
  } finally {
    await cleanup(context);
  }
});

test('async delegations keep running after the request ends', async () => {
  const context = await setup({ hang: true });
  try {
    const response = await startAsync(context.info, { task: 'slow' });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(context.dsh.cancels.length, 0);
    assert.equal(context.gateway.workItems[0]?.state, 'in-flight');
    const status = (await (await getStatus(context.info, context.gateway.workItems[0]!.id)).json()) as {
      state: string;
    };
    assert.equal(status.state, 'in-flight');
  } finally {
    await cleanup(context);
  }
});

test('times out a background delegation and cancels its worker', async () => {
  const context = await setup({ hang: true, asyncTimeoutMs: 25 });
  try {
    const response = await startAsync(context.info, { task: 'too slow' });
    assert.equal(response.status, 202);
    await waitUntil(() => context.gateway.workItems[0]?.state === 'failed');
    assert.equal(context.dsh.cancels.length, 1);
    const item = context.gateway.workItems[0];
    assert.match(item?.error ?? '', /timed out/);
  } finally {
    await cleanup(context);
  }
});

test('caps a stored async result and reports truncation', async () => {
  const context = await setup({ resultMaxBytes: 8 });
  try {
    const response = await startAsync(context.info, { task: 'reply WORKER-OK' });
    assert.equal(response.status, 202);
    const accepted = (await response.json()) as { workItemId: string };
    await waitUntil(() => context.gateway.workItems[0]?.state === 'completed');
    const body = (await (await getStatus(context.info, accepted.workItemId)).json()) as {
      output: string;
      truncated: boolean;
    };
    assert.equal(body.output, 'WORKER-O');
    assert.equal(body.truncated, true);
  } finally {
    await cleanup(context);
  }
});

test('returns 404 for an unknown work item and 400 for a bad id', async () => {
  const context = await setup();
  try {
    const missing = await getStatus(context.info, '00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404);
    const invalid = await getStatus(context.info, 'not-a-uuid');
    assert.equal(invalid.status, 400);
  } finally {
    await cleanup(context);
  }
});
