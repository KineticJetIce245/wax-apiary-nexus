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
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(readonly nativeId: string) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> {
    return this.nativeId;
  }
  async submit(_nativeId: string, executionId: string, text: string): Promise<void> {
    this.submissions.push(text);
    setTimeout(() => {
      this.emit({ type: 'execution/output', executionId, channel: 'assistant', text: 'WORKER-OK' });
      this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, 0);
  }
  async cancel(): Promise<void> {}
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

async function setup() {
  const project: Project = { id: 'g009-gateway', directory: mkdtempSync(join(tmpdir(), 'uw-g009-gateway-')) };
  const dsh = new FakeAdapter('dsh-native');
  const workbench = new Workbench({ project, connections: [{ name: 'dsh', adapter: dsh }] });
  await workbench.start();
  const gateway = new CollaborationGateway(workbench, { pollIntervalMs: 5 });
  const info = await gateway.start();
  return { dsh, workbench, gateway, info };
}

function delegate(info: { url: string; token: string }, body: unknown): Promise<Response> {
  return fetch(info.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: JSON.stringify(body),
  });
}

test('delegates one task to the worker and returns its completed output', async () => {
  const { dsh, workbench, gateway, info } = await setup();
  try {
    const response = await delegate(info, { task: 'reply WORKER-OK' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      worker: string;
      executionId: string;
      output: string;
    };
    assert.equal(body.worker, 'dsh');
    assert.equal(body.output, 'WORKER-OK');
    assert.equal(typeof body.executionId, 'string');
    assert.deepEqual(dsh.submissions, ['reply WORKER-OK']);
  } finally {
    await gateway.stop();
    await workbench.stop();
  }
});

test('rejects missing auth, unknown fields and an unavailable worker', async () => {
  const { workbench, gateway, info } = await setup();
  try {
    const unauthorized = await fetch(info.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'x' }),
    });
    assert.equal(unauthorized.status, 401);

    const extra = await delegate(info, { task: 'x', extra: true });
    assert.equal(extra.status, 400);

    await workbench.stop();
    const unavailable = await delegate(info, { task: 'x' });
    assert.equal(unavailable.status, 409);
  } finally {
    await gateway.stop().catch(() => undefined);
  }
});
