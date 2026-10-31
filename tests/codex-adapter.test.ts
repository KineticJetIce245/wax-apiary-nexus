import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexAppServerAdapter } from '../src/adapters/codex/adapter.js';
import type { HarnessEvent } from '../src/adapters/harness.js';
import { SubmitOutcomeUnknownError } from '../src/adapters/harness.js';
import type { CodexLaunch } from '../src/connection.js';
import { ConversationBusyError, ConversationClosingError, Workspace } from '../src/workspace.js';
import { assertHarnessAdapterContract } from './support/harness-adapter-contract.js';

const FAKE_SERVER = String.raw`
const readline = require('node:readline');
const mode = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
let turnSeq = 0;
let threadSeq = 0;
let currentThread = null;
let activeTurn = null;
let approvalId = 900;
const pendingApprovals = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function respond(id, result) {
  send({ id, result });
}
function notify(method, params) {
  send({ method, params });
}
function finish(status, error) {
  notify('turn/completed', {
    threadId: currentThread,
    turn: { id: activeTurn, status, ...(error === undefined ? {} : { error }) },
  });
  activeTurn = null;
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    respond(message.id, { userAgent: 'codex-cli 0.166.0 (fake)' });
    return;
  }
  if (message.method === 'initialized') {
    return;
  }
  if (message.method === 'account/read') {
    respond(message.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
    return;
  }
  if (message.method === 'thread/start') {
    threadSeq += 1;
    currentThread = 'thr-' + threadSeq;
    respond(message.id, {
      thread: { id: currentThread },
      model: 'fake-model',
      approvalPolicy: 'on-request',
      sandbox: { type: 'readOnly' },
    });
    return;
  }
  if (message.method === 'turn/start') {
    turnSeq += 1;
    activeTurn = 'turn-' + turnSeq;
    if (mode === 'no-accept') {
      return;
    }
    if (mode === 'late-start' && turnSeq === 1) {
      setTimeout(() => {
        notify('turn/started', { threadId: currentThread, turn: { id: activeTurn } });
        setTimeout(() => finish('completed'), 50);
      }, 150);
      return;
    }
    respond(message.id, { turn: { id: activeTurn } });
    notify('turn/started', { threadId: currentThread, turn: { id: activeTurn } });
    if (mode === 'exit') {
      setTimeout(() => process.exit(0), 20);
      return;
    }
    if (mode === 'happy') {
      notify('item/started', { threadId: currentThread, turnId: activeTurn, item: { type: 'agentMessage', id: 'msg-1', text: '' } });
      notify('item/agentMessage/delta', { threadId: currentThread, turnId: activeTurn, itemId: 'msg-1', delta: 'hel' });
      notify('item/agentMessage/delta', { threadId: currentThread, turnId: activeTurn, itemId: 'msg-1', delta: 'lo' });
      notify('item/completed', { threadId: currentThread, turnId: activeTurn, item: { type: 'agentMessage', id: 'msg-1', text: 'hello' } });
      finish('completed');
    }
    if (mode === 'approval' || mode === 'deny') {
      const id = approvalId++;
      pendingApprovals.set(id, true);
      send({
        id,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: currentThread, turnId: activeTurn, itemId: 'exec-1', command: 'echo hi' },
      });
    }
    if (mode === 'fail') {
      finish('failed', { message: 'boom' });
    }
    if (mode === 'unknown-status') {
      finish('mystery');
    }
    if (mode === 'hang-turn') {
      // never settle
    }
    if (mode === 'stale-terminal' && turnSeq === 2) {
      setTimeout(
        () => notify('turn/completed', { threadId: currentThread, turn: { id: 'turn-1', status: 'completed' } }),
        20,
      );
      setTimeout(() => finish('completed'), 100);
    }
    if (mode === 'stale-approval') {
      if (turnSeq === 1) {
        setTimeout(() => finish('completed'), 20);
      } else {
        const id = approvalId++;
        send({
          id,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: currentThread, turnId: 'turn-1', itemId: 'old-exec', command: 'old command' },
        });
      }
    }
    return;
  }
  if (message.method === 'turn/interrupt') {
    respond(message.id, {});
    if (mode === 'no-terminal') {
      return;
    }
    if (mode === 'late-terminal') {
      setTimeout(() => finish('interrupted'), 100);
      return;
    }
    if (activeTurn !== null) {
      finish('interrupted');
    }
    return;
  }
  if (message.method === 'thread/unsubscribe') {
    if (mode === 'hang-close') {
      return;
    }
    respond(message.id, { status: 'unsubscribed' });
    return;
  }
  if (message.id !== undefined && message.result !== undefined) {
    const decision = message.result.decision;
    notify('item/completed', {
      threadId: currentThread,
      turnId: activeTurn,
      item: { type: 'agentMessage', id: 'msg-approval', text: 'decision=' + decision },
    });
    finish('completed');
    return;
  }
  if (message.id !== undefined && message.error !== undefined) {
    finish('failed', { message: message.error.message });
  }
});
`;

function makeFakeServer(mode: string): CodexLaunch {
  const dir = mkdtempSync(join(tmpdir(), 'uw-fake-codex-'));
  const script = join(dir, 'fake-app-server.cjs');
  writeFileSync(script, FAKE_SERVER, 'utf8');
  return { file: process.execPath, args: [script, mode] };
}

async function open(mode: string): Promise<{ adapter: CodexAppServerAdapter; events: HarnessEvent[]; projectDir: string }> {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-project-'));
  const adapter = new CodexAppServerAdapter({ launch: makeFakeServer(mode), requestTimeoutMs: 2_000 });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  return { adapter, events, projectDir };
}

async function waitForEvent<T extends { readonly type: string }>(
  events: readonly T[],
  predicate: (event: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate);
    if (found !== undefined) {
      return found;
    }
    await delay(10);
  }
  throw new Error(`event not observed within ${timeoutMs}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('streams assistant text once for a turn', async () => {
  const session = await open('happy');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'hello');
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output' && event.channel === 'assistant')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'hello');
  } finally {
    await session.adapter.stop();
  }
});

test('relays a command approval and maps allow_once to accept', async () => {
  const session = await open('approval');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'run it');
    const requested = await waitForEvent(session.events, (event) => event.type === 'execution/approval-requested');
    assert.equal(requested.type, 'execution/approval-requested');
    if (requested.type !== 'execution/approval-requested') {
      return;
    }
    assert.match(requested.request.summary, /echo hi/);
    assert.deepEqual(requested.request.options.map((option) => option.kind), ['allow_once', 'reject_once']);
    await session.adapter.respondToApproval({ requestId: requested.request.requestId, kind: 'allow_once' });
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'decision=accept');
  } finally {
    await session.adapter.stop();
  }
});

test('maps reject_once to decline', async () => {
  const session = await open('deny');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'run it');
    const requested = await waitForEvent(session.events, (event) => event.type === 'execution/approval-requested');
    if (requested.type !== 'execution/approval-requested') {
      return;
    }
    await session.adapter.respondToApproval({ requestId: requested.request.requestId, kind: 'reject_once' });
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'decision=decline');
  } finally {
    await session.adapter.stop();
  }
});

test('rejects a second submission while a turn is running', async () => {
  const session = await open('hang-turn');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'first');
    await assert.rejects(session.adapter.submit(nativeId, 'exec-2', 'second'), /active execution/);
  } finally {
    await session.adapter.stop();
  }
});

test('cancels the active turn through turn/interrupt', async () => {
  const session = await open('hang-turn');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'wait');
    await session.adapter.cancel(nativeId);
    await waitForEvent(session.events, (event) => event.type === 'execution/cancelled');
  } finally {
    await session.adapter.stop();
  }
});

test('fails the execution when the native turn fails', async () => {
  const session = await open('fail');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'boom');
    const failed = await waitForEvent(session.events, (event) => event.type === 'execution/failed');
    assert.equal(failed.type, 'execution/failed');
    if (failed.type === 'execution/failed') {
      assert.equal(failed.error, 'boom');
    }
  } finally {
    await session.adapter.stop();
  }
});

test('marks an unrecognized turn status as unknown instead of completed', async () => {
  const session = await open('unknown-status');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'mystery');
    await waitForEvent(session.events, (event) => event.type === 'execution/unknown');
    assert.equal(session.events.some((event) => event.type === 'execution/completed'), false);
  } finally {
    await session.adapter.stop();
  }
});

test('keeps the thread closing and blocks new work after a close timeout', async () => {
  const session = await open('hang-close');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await assert.rejects(session.adapter.closeConversation(nativeId), /timed out|timeout/i);
    await assert.rejects(session.adapter.submit(nativeId, 'exec-2', 'again'), /closing/);
  } finally {
    await session.adapter.stop();
  }
});

test('interrupts in-flight work before closing the thread', async () => {
  const session = await open('hang-turn');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'wait');
    await session.adapter.closeConversation(nativeId);
    await waitForEvent(session.events, (event) => event.type === 'execution/cancelled');
    await assert.rejects(session.adapter.submit(nativeId, 'exec-2', 'again'), /Unknown Codex thread/);
  } finally {
    await session.adapter.stop();
  }
});

test('marks a running execution unknown when the app-server exits', async () => {
  const session = await open('exit');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'die');
    const unknown = await waitForEvent(session.events, (event) => event.type === 'execution/unknown');
    assert.match(unknown.type === 'execution/unknown' ? unknown.reason : '', /exited/);
  } finally {
    await session.adapter.stop();
  }
});

test('rejects start when the executable does not exist', async () => {
  const adapter = new CodexAppServerAdapter({
    launch: { file: join(tmpdir(), `uw-missing-codex-${Date.now()}`), args: ['app-server'] },
    initializeTimeoutMs: 100,
  });
  try {
    await assert.rejects(adapter.start(), /ENOENT|spawn/i);
  } finally {
    await adapter.stop();
  }
});

test('does not advertise an unimplemented resume capability', () => {
  const adapter = new CodexAppServerAdapter({ launch: { file: 'unused', args: [] } });
  assert.equal(adapter.capabilities.resume, false);
});

test('satisfies the harness adapter contract', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-contract-project-'));
  const secondProjectDir = mkdtempSync(join(tmpdir(), 'uw-contract-project-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('hang-turn'),
    requestTimeoutMs: 1_000,
  });

  try {
    await assertHarnessAdapterContract({
      adapter,
      project: { id: 'contract-project', directory: projectDir },
      secondProject: { id: 'contract-project-2', directory: secondProjectDir },
    });
  } finally {
    await adapter.stop().catch(() => undefined);
  }
});

test('treats a timed-out turn/start without acceptance as unknown and keeps the conversation busy', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-uncertain-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('no-accept'),
    requestTimeoutMs: 100,
    closeTerminalTimeoutMs: 200,
  });
  const workspace = new Workspace(adapter);
  const states: string[] = [];
  workspace.onEvent((event) => {
    if (event.type === 'execution/state') {
      states.push(event.state);
    }
  });

  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'uncertain', directory: projectDir });
    await assert.rejects(workspace.submit(conversation.id, 'first'), SubmitOutcomeUnknownError);
    assert.equal(states[0], 'unknown');
    await assert.rejects(workspace.submit(conversation.id, 'second'), ConversationBusyError);
  } finally {
    await workspace.stop();
  }
});

test('keeps a timed-out turn alive when turn/started arrives later and releases it afterwards', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-late-start-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('late-start'),
    requestTimeoutMs: 100,
    closeTerminalTimeoutMs: 1_000,
  });
  const workspace = new Workspace(adapter);

  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'late', directory: projectDir });
    await assert.rejects(workspace.submit(conversation.id, 'first'), SubmitOutcomeUnknownError);
    await delay(300);
    const second = await workspace.submit(conversation.id, 'second');
    assert.equal(second.state, 'running');
  } finally {
    await workspace.stop();
  }
});

test('does not report cancelled when close cannot confirm a native terminal', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-no-terminal-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('no-terminal'),
    requestTimeoutMs: 200,
    closeTerminalTimeoutMs: 200,
  });
  const workspace = new Workspace(adapter);
  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'no-terminal', directory: projectDir });
    const execution = await workspace.submit(conversation.id, 'first');
    await assert.rejects(workspace.closeConversation(conversation.id), /did not reach a terminal/);
    assert.equal(workspace.getExecution(execution.id)?.state, 'unknown');
    await assert.rejects(workspace.submit(conversation.id, 'second'), ConversationClosingError);
  } finally {
    await workspace.stop();
  }
});

test('closes only after a late native terminal event arrives', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-late-terminal-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('late-terminal'),
    requestTimeoutMs: 200,
    closeTerminalTimeoutMs: 1_000,
  });
  const workspace = new Workspace(adapter);
  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'late-terminal', directory: projectDir });
    const execution = await workspace.submit(conversation.id, 'first');
    await workspace.closeConversation(conversation.id);
    assert.equal(workspace.getExecution(execution.id)?.state, 'cancelled');
  } finally {
    await workspace.stop();
  }
});

test('ignores a stale turn completion instead of settling the new execution', async () => {
  const session = await open('stale-terminal');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'first');
    await delay(20);
    await session.adapter.cancel(nativeId);
    await waitForEvent(session.events, (event) => event.type === 'execution/cancelled');

    await session.adapter.submit(nativeId, 'exec-2', 'second');
    await delay(60);
    assert.equal(
      session.events.some((event) => event.type === 'execution/completed'),
      false,
      'stale turn-1 completion settled the second execution',
    );
    const completed = await waitForEvent(session.events, (event) => event.type === 'execution/completed', 2_000);
    assert.equal(completed.type === 'execution/completed' ? completed.executionId : '', 'exec-2');
  } finally {
    await session.adapter.stop();
  }
});

test('declines an approval request that belongs to a previous turn', async () => {
  const session = await open('stale-approval');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'first');
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');

    await session.adapter.submit(nativeId, 'exec-2', 'second');
    await waitForEvent(
      session.events,
      (event) => event.type === 'execution/completed' && event.executionId === 'exec-2',
      2_000,
    );
    assert.equal(
      session.events.some((event) => event.type === 'execution/approval-requested'),
      false,
      'an old-turn approval was presented to the new execution',
    );
  } finally {
    await session.adapter.stop();
  }
});
