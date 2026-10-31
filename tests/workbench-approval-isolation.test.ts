import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexAppServerAdapter } from '../src/adapters/codex/adapter.js';
import { DshAcpAdapter } from '../src/adapters/dsh-acp/adapter.js';
import type { ApprovalRequest } from '../src/adapters/harness.js';
import type { Project } from '../src/kernel.js';
import { Workbench, type TaggedWorkspaceEvent } from '../src/workbench.js';

const FAKE_ACP_SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
let promptSession = null;
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'dsh-approval-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    promptSession = message.params.sessionId;
    send({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: {
        sessionId: promptSession,
        toolCall: { title: 'needs permission' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    return;
  }
  if (message.id === 77 && message.result !== undefined) {
    const outcome = message.result.outcome;
    const optionId = outcome && outcome.outcome === 'selected' ? outcome.optionId : 'cancelled';
    const decision = optionId === 'allow' ? 'accept' : 'decline';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: promptSession,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'decision=' + decision } },
      },
    });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    promptId = null;
    return;
  }
  if (message.method === 'session/close') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/cancel') {
    return;
  }
});
`;

const FAKE_CODEX_SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let threadId = 'thr-approval';
let turnId = 'turn-approval';
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function notify(method, params) {
  send({ method, params });
}
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex-cli 0.166.0 (fake)' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') {
    send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: threadId }, model: 'fake', approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } } });
    return;
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId } } });
    notify('turn/started', { threadId, turn: { id: turnId } });
    send({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId, itemId: 'exec-approval', command: 'needs approval' },
    });
    return;
  }
  if (message.id === 77 && message.result !== undefined) {
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: 'msg-approval', text: 'decision=' + message.result.decision },
    });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    return;
  }
  if (message.method === 'thread/unsubscribe') {
    send({ id: message.id, result: { status: 'unsubscribed' } });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } });
    return;
  }
});
`;

function makeFakeDshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'uw-g004-approval-dsh-'));
  const dir = join(root, 'apps', 'cli', 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bin.js'), FAKE_ACP_SERVER, 'utf8');
  return root;
}

function makeFakeCodexLaunch(): { file: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'uw-g004-approval-codex-'));
  const script = join(dir, 'fake-app-server.cjs');
  writeFileSync(script, FAKE_CODEX_SERVER, 'utf8');
  return { file: process.execPath, args: [script] };
}

async function waitForApprovalCount(
  events: readonly { connection: string; request: ApprovalRequest }[],
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (events.length >= count) {
      return;
    }
    await delay(20);
  }
  throw new Error(`waiting for ${count} approval requests timed out`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('keeps identical protocol approval ids isolated per connection', async () => {
  const project: Project = {
    id: 'g004-approval-isolation',
    directory: mkdtempSync(join(tmpdir(), 'uw-g004-approval-')),
  };
  const workbench = new Workbench({
    project,
    connections: [
      { name: 'dsh', adapter: new DshAcpAdapter({ dshRoot: makeFakeDshRoot() }) },
      { name: 'codex', adapter: new CodexAppServerAdapter({ launch: makeFakeCodexLaunch(), requestTimeoutMs: 5_000 }) },
    ],
    approvalTimeoutMs: 30_000,
  });
  const approvals: Array<{ connection: string; request: ApprovalRequest }> = [];
  workbench.onEvent((event: TaggedWorkspaceEvent) => {
    if (event.event.type === 'execution/approval-requested') {
      approvals.push({ connection: event.connection, request: event.event.request });
    }
  });

  try {
    await workbench.start();
    const dshExecution = await workbench.submit('dsh needs approval', 'dsh');
    const codexExecution = await workbench.submit('codex needs approval', 'codex');
    await waitForApprovalCount(approvals, 2);

    const dshApproval = approvals.find((entry) => entry.connection === 'dsh');
    const codexApproval = approvals.find((entry) => entry.connection === 'codex');
    assert.ok(dshApproval !== undefined && codexApproval !== undefined);
    assert.equal(dshApproval.request.requestId, '77');
    assert.equal(codexApproval.request.requestId, '77');

    await workbench.decideApproval('dsh', dshExecution.execution.id, '77', 'allow_once');
    await delay(100);
    assert.equal(workbench.getExecution('dsh', dshExecution.execution.id)?.execution.state, 'completed');
    assert.match(workbench.getExecution('dsh', dshExecution.execution.id)?.execution.output ?? '', /decision=accept/);
    // The identical request id on the other connection must still be pending.
    assert.equal(workbench.getExecution('codex', codexExecution.execution.id)?.execution.state, 'running');

    await workbench.decideApproval('codex', codexExecution.execution.id, '77', 'reject_once');
    await delay(100);
    assert.equal(workbench.getExecution('codex', codexExecution.execution.id)?.execution.state, 'completed');
    assert.match(workbench.getExecution('codex', codexExecution.execution.id)?.execution.output ?? '', /decision=decline/);
  } finally {
    await workbench.stop().catch(() => undefined);
  }
});
