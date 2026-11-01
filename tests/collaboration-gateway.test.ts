import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
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

async function setup(hang = false) {
  const project: Project = { id: 'g009-gateway', directory: mkdtempSync(join(tmpdir(), 'uw-g009-gateway-')) };
  const dsh = new FakeAdapter('dsh-native', hang);
  const workbench = new Workbench({ project, connections: [{ name: 'dsh', adapter: dsh }] });
  await workbench.start();
  const gateway = new CollaborationGateway(workbench, { pollIntervalMs: 5 });
  const info = await gateway.start();
  return { dsh, workbench, gateway, info };
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

function delegate(info: { url: string; token: string }, body: unknown): Promise<Response> {
  return fetch(info.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: JSON.stringify(body),
  });
}

function rawStatus(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  const parsed = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
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

test('resets state after a failed listen and can be started again', async () => {
  const { workbench, gateway } = await setup();
  await gateway.stop();
  const blocker = createServer((_request, response) => response.end('blocked'));
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  if (address === null || typeof address === 'string') {
    throw new Error('blocker has no port');
  }
  const retry = new CollaborationGateway(workbench, { port: address.port, pollIntervalMs: 5 });
  try {
    await assert.rejects(retry.start(), /EADDRINUSE/);
    assert.equal(retry.running, false);
    await closeServer(blocker);
    const info = await retry.start();
    assert.equal(retry.running, true);
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await retry.stop().catch(() => undefined);
    await closeServer(blocker).catch(() => undefined);
    await workbench.stop();
  }
});

test('cancels the worker when the client disconnects', async () => {
  const { dsh, workbench, gateway, info } = await setup(true);
  try {
    const controller = new AbortController();
    const pending = fetch(info.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ task: 'slow worker' }),
      signal: controller.signal,
    });
    await waitUntil(() => dsh.submissions.length === 1);
    controller.abort();
    await assert.rejects(pending);
    await waitUntil(() => dsh.cancels.length === 1);
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

    const badHost = await rawStatus(
      info.url,
      {
        Host: 'attacker.example',
        authorization: `Bearer ${info.token}`,
        'content-type': 'application/json',
      },
      JSON.stringify({ task: 'x' }),
    );
    assert.equal(badHost, 403);

    const extra = await delegate(info, { task: 'x', extra: true });
    assert.equal(extra.status, 400);

    const oversize = await delegate(info, { task: 'x'.repeat(100_000) });
    assert.equal(oversize.status, 413);

    await workbench.stop();
    const unavailable = await delegate(info, { task: 'x' });
    assert.equal(unavailable.status, 409);
  } finally {
    await gateway.stop().catch(() => undefined);
  }
});
