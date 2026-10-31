import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import type { Project } from '../src/kernel.js';
import { Workbench } from '../src/workbench.js';
import { WebServer } from '../src/web-server.js';

class FakeAdapter implements HarnessAdapter {
  capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    resume: false,
  };
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> {
    return 'native-web-test';
  }
  async submit(): Promise<void> {}
  async cancel(): Promise<void> {}
  async respondToApproval(_decision: ApprovalDecision): Promise<void> {}  async closeConversation(): Promise<void> {}

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-web-project-'));
  const artifactDir = mkdtempSync(join(tmpdir(), 'uw-web-artifacts-'));
  const imagePath = join(projectDir, 'generated.png');
  const imageBytes = Buffer.from('fake-png-bytes');
  writeFileSync(imagePath, imageBytes);

  const dsh = new FakeAdapter();
  const codex = new FakeAdapter();
  const project: Project = { id: 'g006-web', directory: projectDir };
  const workbench = new Workbench({
    project,
    connections: [
      { name: 'codex', adapter: codex },
      { name: 'dsh', adapter: dsh },
    ],
  });
  await workbench.start();
  const web = new WebServer(workbench, { artifactRoot: artifactDir });
  const info = await web.start();
  return { adapter: codex, dsh, codex, workbench, web, info, imagePath, imageBytes };
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('serves a read-only state snapshot and artifact bytes without local paths', async () => {
  const { adapter, workbench, web, info, imagePath, imageBytes } = await setup();
  try {
    const submitted = await workbench.submit('make an image');
    adapter.emit({ type: 'execution/output', executionId: submitted.execution.id, channel: 'assistant', text: 'done' });
    adapter.emit({
      type: 'execution/attachment',
      executionId: submitted.execution.id,
      attachment: {
        kind: 'image',
        path: imagePath,
        mimeType: 'image/png',
        name: 'generated.png',
        byteLength: imageBytes.byteLength,
      },
    });
    adapter.emit({ type: 'execution/completed', executionId: submitted.execution.id, stopReason: 'end_turn' });
    await delay(20);

    const stateResponse = await fetch(`${info.url}api/state`);
    assert.equal(stateResponse.status, 200);
    assert.match(stateResponse.headers.get('content-type') ?? '', /application\/json/);
    const state = (await stateResponse.json()) as {
      executions: Array<{
        id: string;
        state: string;
        output: string;
        attachments: Array<{ id?: string; url?: string; path?: string; mimeType?: string }>;
      }>;
    };
    assert.equal(state.executions.length, 1);
    assert.equal(state.executions[0]?.state, 'completed');
    assert.equal(state.executions[0]?.output, 'done');
    const attachment = state.executions[0]?.attachments[0];
    assert.ok(attachment?.id !== undefined);
    assert.equal(attachment?.url, `/artifacts/${attachment.id}`);
    assert.equal(attachment?.mimeType, 'image/png');
    assert.equal('path' in (attachment ?? {}), false);

    const artifactResponse = await fetch(new URL(attachment.url, info.url));
    assert.equal(artifactResponse.status, 200);
    assert.equal(artifactResponse.headers.get('content-type'), 'image/png');
    assert.equal(artifactResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await artifactResponse.arrayBuffer()), imageBytes);

    const page = await fetch(info.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(await page.text(), /Unified Workspace/);
  } finally {
    await web.stop();
    await workbench.stop();
  }
});

test('keeps approvals from two connections with the same request id separate', async () => {
  const { dsh, codex, workbench, web } = await setup();
  try {
    const dshExecution = await workbench.submit('dsh approval', 'dsh');
    const codexExecution = await workbench.submit('codex approval', 'codex');
    const request = (executionId: string) => ({
      requestId: '77',
      executionId,
      summary: `approval for ${executionId}`,
      options: [{ id: 'allow', kind: 'allow_once' as const, label: 'Allow' }],
    });
    dsh.emit({
      type: 'execution/approval-requested',
      executionId: dshExecution.execution.id,
      request: request(dshExecution.execution.id),
    });
    codex.emit({
      type: 'execution/approval-requested',
      executionId: codexExecution.execution.id,
      request: request(codexExecution.execution.id),
    });
    await delay(20);
    assert.equal(web.getState().approvals.length, 2);

    await workbench.decideApproval('dsh', dshExecution.execution.id, '77', 'allow_once');
    await delay(20);
    const remaining = web.getState().approvals;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.connection, 'codex');
  } finally {
    await web.stop();
    await workbench.stop();
  }
});

test('restarts with a fresh artifact store after stop', async () => {
  const { workbench, web, codex, imagePath, imageBytes } = await setup();
  try {
    await web.stop();
    const info = await web.start();
    assert.equal(web.running, true);

    const submitted = await workbench.submit('after restart', 'codex');
    codex.emit({
      type: 'execution/attachment',
      executionId: submitted.execution.id,
      attachment: {
        kind: 'image',
        path: imagePath,
        mimeType: 'image/png',
        name: 'generated.png',
        byteLength: imageBytes.byteLength,
      },
    });
    codex.emit({ type: 'execution/completed', executionId: submitted.execution.id, stopReason: 'end_turn' });
    await delay(20);

    const execution = web
      .getState()
      .executions.find((candidate) => candidate.id === submitted.execution.id);
    const attachment = execution?.attachments[0];
    assert.ok(attachment !== undefined && 'url' in attachment);
    const response = await fetch(new URL(attachment.url, info.url));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    await web.stop();
    await workbench.stop();
  }
});

test('rejects a non-loopback Host header to prevent DNS rebinding', async () => {
  const { workbench, web, info } = await setup();
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: info.port,
          path: '/api/state',
          headers: { Host: 'evil.example' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once('error', reject);
      request.end();
    });
    assert.equal(status, 403);
  } finally {
    await web.stop();
    await workbench.stop();
  }
});

test('rejects non-GET requests and unknown or traversing artifact ids', async () => {
  const { workbench, web, info } = await setup();
  try {
    const post = await fetch(`${info.url}api/state`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');

    for (const path of [
      'artifacts/not-a-hash',
      'artifacts/../package.json',
      'artifacts/%2e%2e%2fpackage.json',
      'nope',
    ]) {
      const response = await fetch(`${info.url}${path}`);
      assert.equal(response.status, 404, path);
    }
  } finally {
    await web.stop();
    await workbench.stop();
  }
});
