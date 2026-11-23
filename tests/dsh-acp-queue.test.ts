import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DshAcpAdapter } from '../src/adapters/dsh-acp/adapter.js';
import type { HarnessEvent } from '../src/adapters/harness.js';

const QUEUE_ACP_SERVER = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let seq = 0;
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: 1 });
    return;
  }
  if (message.method === 'session/new') {
    seq += 1;
    send(message.id, { sessionId: 'queue-session-' + seq });
    return;
  }
  if (message.method === 'session/prompt') {
    const text = (message.params.prompt || [])
      .map((part) => part.text || '')
      .join('');
    fs.appendFileSync(process.env.WAX_QUEUE_CAPTURE, text + '\n');
    // Answer asynchronously so only a later prompt turn can be observed after.
    setTimeout(() => send(message.id, { stopReason: 'end_turn' }), 25);
    return;
  }
  if (message.method === 'session/close') {
    send(message.id, {});
  }
});
`;

/** Answers lifecycle requests but never a prompt: the turn stays active. */
const HOLDING_ACP_SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let seq = 0;
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: 1 });
    return;
  }
  if (message.method === 'session/new') {
    seq += 1;
    send(message.id, { sessionId: 'holding-session-' + seq });
    return;
  }
  if (message.method === 'session/close') {
    send(message.id, {});
  }
});
`;

function makeFakeDshRoot(binSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'wax-queue-dsh-'));
  const dir = join(root, 'apps', 'cli', 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bin.js'), binSource, 'utf8');
  return root;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

test('queues overlapping prompts FIFO and starts each only after the previous terminal', async () => {
  const root = makeFakeDshRoot(QUEUE_ACP_SERVER);
  const projectDir = mkdtempSync(join(tmpdir(), 'wax-queue-project-'));
  const capturePath = join(projectDir, 'prompts.txt');
  const previousCapture = process.env.WAX_QUEUE_CAPTURE;
  process.env.WAX_QUEUE_CAPTURE = capturePath;
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 1_000 });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => {
    events.push(event);
  });

  try {
    assert.equal(adapter.capabilities.queue, true);
    await adapter.start();
    const nativeId = await adapter.createConversation({ id: 'queue', directory: projectDir });
    await adapter.submit(nativeId, 'execution-1', 'one');
    await adapter.submit(nativeId, 'execution-2', 'two');
    await adapter.submit(nativeId, 'execution-3', 'three');

    // submit() is admission: only the first prompt may have reached ACP.
    assert.deepEqual(startedIds(events), ['execution-1']);
    await waitFor(
      () => terminalIds(events).length === 3,
      'the three queued executions never settled',
    );
    assert.deepEqual(startedIds(events), ['execution-1', 'execution-2', 'execution-3']);
    assert.deepEqual(terminalIds(events), ['execution-1', 'execution-2', 'execution-3']);
    assert.deepEqual(
      readFileSync(capturePath, 'utf8').trim().split('\n'),
      ['one', 'two', 'three'],
      'the native side must receive the prompts in admission order',
    );
  } finally {
    if (previousCapture === undefined) {
      delete process.env.WAX_QUEUE_CAPTURE;
    } else {
      process.env.WAX_QUEUE_CAPTURE = previousCapture;
    }
    await adapter.stop().catch(() => undefined);
  }
});

test('dropQueued removes one waiting prompt and emits its cancelled terminal', async () => {
  const root = makeFakeDshRoot(HOLDING_ACP_SERVER);
  const projectDir = mkdtempSync(join(tmpdir(), 'wax-queue-drop-project-'));
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 100 });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => {
    events.push(event);
  });

  try {
    await adapter.start();
    const nativeId = await adapter.createConversation({ id: 'drop', directory: projectDir });
    await adapter.submit(nativeId, 'execution-1', 'one');
    await adapter.submit(nativeId, 'execution-2', 'two');
    assert.deepEqual(startedIds(events), ['execution-1']);

    assert.equal(await adapter.dropQueued(nativeId, 'execution-2'), true);
    assert.deepEqual(startedIds(events), ['execution-1']);
    assert.deepEqual(
      events.filter((event) => event.type === 'execution/cancelled').map((event) => event.executionId),
      ['execution-2'],
    );
    assert.equal(await adapter.dropQueued(nativeId, 'execution-2'), false);
    assert.equal(await adapter.dropQueued(nativeId, 'execution-1'), false);
  } finally {
    await adapter.stop().catch(() => undefined);
  }
});

test('closing a session cancels queued prompts before it closes', async () => {
  const root = makeFakeDshRoot(HOLDING_ACP_SERVER);
  const projectDir = mkdtempSync(join(tmpdir(), 'wax-queue-close-project-'));
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 500 });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => {
    events.push(event);
  });

  try {
    await adapter.start();
    const nativeId = await adapter.createConversation({ id: 'close', directory: projectDir });
    await adapter.submit(nativeId, 'execution-1', 'one');
    await adapter.submit(nativeId, 'execution-2', 'two');

    await adapter.closeConversation(nativeId);
    assert.deepEqual(startedIds(events), ['execution-1']);
    assert.deepEqual(
      events.filter((event) => event.type === 'execution/cancelled').map((event) => event.executionId),
      ['execution-2', 'execution-1'],
    );
  } finally {
    await adapter.stop().catch(() => undefined);
  }
});

test('stop cancels prompts that were still waiting in the queue', async () => {
  const root = makeFakeDshRoot(HOLDING_ACP_SERVER);
  const projectDir = mkdtempSync(join(tmpdir(), 'wax-queue-stop-project-'));
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 100 });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => {
    events.push(event);
  });

  try {
    await adapter.start();
    const nativeId = await adapter.createConversation({ id: 'stop', directory: projectDir });
    await adapter.submit(nativeId, 'execution-1', 'one');
    await adapter.submit(nativeId, 'execution-2', 'two');
    assert.deepEqual(startedIds(events), ['execution-1']);

    await adapter.stop();
    assert.deepEqual(
      events.filter((event) => event.type === 'execution/cancelled').map((event) => event.executionId),
      ['execution-2'],
    );
  } finally {
    await adapter.stop().catch(() => undefined);
  }
});

function startedIds(events: readonly HarnessEvent[]): string[] {
  return events
    .filter((event): event is Extract<HarnessEvent, { type: 'execution/started' }> =>
      event.type === 'execution/started')
    .map((event) => event.executionId);
}

function terminalIds(events: readonly HarnessEvent[]): string[] {
  return events
    .filter((event) =>
      event.type === 'execution/completed' ||
      event.type === 'execution/failed' ||
      event.type === 'execution/cancelled' ||
      event.type === 'execution/unknown')
    .map((event) => (event as { readonly executionId: string }).executionId);
}
