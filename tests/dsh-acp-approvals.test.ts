import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { DshAcpAdapter } from '../src/adapters/dsh-acp/adapter.js';
import type { ApprovalRequest } from '../src/adapters/harness.js';

// Every prompt gets a permission request with the same native JSON-RPC id 0,
// even from different sessions. The adapter must namespace that id before it
// reaches WAX's pending maps.
const FAKE_ACP_DUPLICATE_APPROVALS = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const recordPath = process.argv[4];
const rl = readline.createInterface({ input: process.stdin });
let sessionSeq = 0;
const prompts = [];
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function sendRequest(id, method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}
function settlePrompt(outcome) {
  const prompt = prompts.find((candidate) => !candidate.settled);
  if (prompt === undefined) return;
  prompt.settled = true;
  send(prompt.id, { stopReason: outcome });
}
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: 1 });
    return;
  }
  if (message.method === 'session/new') {
    sessionSeq += 1;
    send(message.id, { sessionId: 'duplicate-session-' + sessionSeq });
    return;
  }
  if (message.method === 'session/close') {
    send(message.id, {});
    return;
  }
  if (message.method === 'session/cancel') {
    settlePrompt('cancelled');
    return;
  }
  if (message.method === 'session/prompt') {
    prompts.push({ id: message.id, settled: false });
    sendRequest(0, 'session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: { toolCallId: 'tool-' + String(prompts.length), title: 'write marker' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const outcome = message.result === undefined ? null : message.result.outcome;
    fs.appendFileSync(recordPath, JSON.stringify({ id: message.id, outcome }) + '\n');
    settlePrompt(outcome !== null && outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn');
  }
});
`;

function makeFakeDshRoot(binSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'uw-fake-dsh-'));
  const dir = join(root, 'apps', 'cli', 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bin.js'), binSource, 'utf8');
  return root;
}

function approvalEvents(adapter: DshAcpAdapter): ApprovalRequest[] {
  const approvals: ApprovalRequest[] = [];
  adapter.onEvent((event) => {
    if (event.type === 'execution/approval-requested') {
      approvals.push(event.request);
    }
  });
  return approvals;
}

async function waitForApprovals(approvals: ApprovalRequest[], count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (approvals.length < count && Date.now() < deadline) {
    await delay(10);
  }
}

async function waitForResponses(recordPath: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  let lines: string[] = [];
  while (Date.now() < deadline) {
    lines = existsSync(recordPath)
      ? readFileSync(recordPath, 'utf8').trim().split('\n').filter((line) => line !== '')
      : [];
    if (lines.length >= count) {
      return lines;
    }
    await delay(10);
  }
  return lines;
}

test('namespaces duplicate native approval ids by session and clears each pending promise', async () => {
  const root = makeFakeDshRoot(FAKE_ACP_DUPLICATE_APPROVALS);
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-duplicate-approval-project-'));
  const recordPath = join(projectDir, 'approval-responses.jsonl');
  const adapter = new DshAcpAdapter({
    dshRoot: root,
    dshArgs: [recordPath],
    sessionTimeoutMs: 1_000,
  });
  const approvals = approvalEvents(adapter);

  try {
    await adapter.start();
    const firstSession = await adapter.createConversation({
      id: 'duplicate-a',
      directory: projectDir,
    });
    const secondSession = await adapter.createConversation({
      id: 'duplicate-b',
      directory: projectDir,
    });
    await adapter.submit(firstSession, 'duplicate-execution-a', 'first');
    await adapter.submit(secondSession, 'duplicate-execution-b', 'second');

    await waitForApprovals(approvals, 2);
    assert.equal(approvals.length, 2, 'both duplicate native request ids must remain pending');

    const firstApproval = approvals.find(
      (approval) => approval.requestId === `${firstSession}:0`,
    );
    const secondApproval = approvals.find(
      (approval) => approval.requestId === `${secondSession}:0`,
    );
    assert.ok(firstApproval !== undefined);
    assert.ok(secondApproval !== undefined);
    assert.notEqual(firstApproval.requestId, secondApproval.requestId);

    await adapter.respondToApproval({ requestId: firstApproval.requestId, kind: 'allow_once' });
    await assert.rejects(
      adapter.respondToApproval({ requestId: firstApproval.requestId, kind: 'reject_once' }),
      /Unknown ACP approval request/,
    );
    await adapter.respondToApproval({ requestId: secondApproval.requestId, kind: 'reject_once' });
    await assert.rejects(
      adapter.respondToApproval({ requestId: secondApproval.requestId, kind: 'allow_once' }),
      /Unknown ACP approval request/,
    );

    const lines = await waitForResponses(recordPath, 2);
    assert.equal(lines.length, 2);
    const responses = lines.map((line) => JSON.parse(line) as {
      readonly id: number;
      readonly outcome: { readonly outcome: string; readonly optionId?: string };
    });
    assert.deepEqual(responses.map((response) => response.id), [0, 0]);
    assert.deepEqual(responses.map((response) => response.outcome), [
      { outcome: 'selected', optionId: 'allow-once' },
      { outcome: 'selected', optionId: 'reject-once' },
    ]);
  } finally {
    await adapter.stop().catch(() => undefined);
  }
});

test('cancelling one session leaves the other duplicate approval pending', async () => {
  const root = makeFakeDshRoot(FAKE_ACP_DUPLICATE_APPROVALS);
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-duplicate-cancel-project-'));
  const recordPath = join(projectDir, 'approval-responses.jsonl');
  const adapter = new DshAcpAdapter({
    dshRoot: root,
    dshArgs: [recordPath],
    sessionTimeoutMs: 1_000,
  });
  const approvals = approvalEvents(adapter);

  try {
    await adapter.start();
    const firstSession = await adapter.createConversation({
      id: 'cancel-a',
      directory: projectDir,
    });
    const secondSession = await adapter.createConversation({
      id: 'cancel-b',
      directory: projectDir,
    });
    await adapter.submit(firstSession, 'cancel-execution-a', 'first');
    await adapter.submit(secondSession, 'cancel-execution-b', 'second');

    await waitForApprovals(approvals, 2);
    assert.equal(approvals.length, 2);
    const firstApproval = approvals.find(
      (approval) => approval.requestId === `${firstSession}:0`,
    );
    const secondApproval = approvals.find(
      (approval) => approval.requestId === `${secondSession}:0`,
    );
    assert.ok(firstApproval !== undefined);
    assert.ok(secondApproval !== undefined);

    await adapter.cancel(firstSession);
    await assert.rejects(
      adapter.respondToApproval({ requestId: firstApproval.requestId, kind: 'allow_once' }),
      /Unknown ACP approval request/,
    );
    await adapter.respondToApproval({ requestId: secondApproval.requestId, kind: 'allow_once' });

    const lines = await waitForResponses(recordPath, 2);
    assert.equal(lines.length, 2);
    const outcomes = lines.map((line) => {
      const response = JSON.parse(line) as {
        readonly outcome: { readonly outcome: string; readonly optionId?: string };
      };
      return response.outcome;
    });
    assert.deepEqual(outcomes, [
      { outcome: 'cancelled' },
      { outcome: 'selected', optionId: 'allow-once' },
    ]);
  } finally {
    await adapter.stop().catch(() => undefined);
  }
});
