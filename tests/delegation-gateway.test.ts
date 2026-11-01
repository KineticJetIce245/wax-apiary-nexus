import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import { CollaborationGateway } from '../src/collaboration-gateway.js';
import { DelegationLedger, readLedgerFile } from '../src/delegation-ledger.js';
import type { DelegationPolicy } from '../src/delegation-policy.js';
import type { Project } from '../src/kernel.js';
import { Workbench } from '../src/workbench.js';

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
    private readonly hang = false,
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> {
    return this.nativeId;
  }
  async submit(_nativeId: string, executionId: string, text: string): Promise<void> {
    this.submissions.push(text);
    if (this.hang) {
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
  options: { hang?: boolean; stateDirectory?: string; policy?: DelegationPolicy } = {},
) {
  const project: Project = {
    id: `g010-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    directory: mkdtempSync(join(tmpdir(), 'uw-g010-project-')),
  };
  const dsh = new FakeAdapter('dsh-native', options.hang === true);
  const workbench = new Workbench({ project, connections: [{ name: 'dsh', adapter: dsh }] });
  await workbench.start();
  const stateDirectory = options.stateDirectory ?? mkdtempSync(join(tmpdir(), 'uw-g010-state-'));
  const gateway = new CollaborationGateway(workbench, {
    pollIntervalMs: 5,
    stateDirectory,
    policy: options.policy ?? policy(),
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
    const controller = new AbortController();
    const first = delegate(context.info, { task: 'slow' });
    void first.catch(() => undefined);
    await waitUntil(() => context.dsh.submissions.length === 1);
    const second = await delegate(context.info, { task: 'second' });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string };
    assert.match(body.error, /concurrency limit/);
    assert.equal(context.dsh.submissions.length, 1);
    controller.abort();
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
