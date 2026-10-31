import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../src/adapters/dsh-acp/adapter.js';
import type { HarnessEvent } from '../src/adapters/harness.js';

const FAKE_ACP_SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
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
    send(message.id, { sessionId: 'fake-session' });
  }
  // Deliberately never answer session/prompt or session/close.
});
`;

function makeFakeDshRoot(binSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'uw-fake-dsh-'));
  const dir = join(root, 'apps', 'cli', 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bin.js'), binSource, 'utf8');
  return root;
}

test('keeps an active execution after a close timeout', async () => {
  const root = makeFakeDshRoot(FAKE_ACP_SERVER);
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-fake-project-'));
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 100 });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => {
    events.push(event);
  });

  try {
    await adapter.start();
    const nativeId = await adapter.createConversation({ id: 'fake', directory: projectDir });
    await adapter.submit(nativeId, 'execution-1', 'hello');

    await assert.rejects(adapter.closeConversation(nativeId), /timed out|timeout/i);
    assert.equal(events.some((event) => event.type === 'execution/cancelled'), false);
    await assert.rejects(
      adapter.submit(nativeId, 'execution-2', 'again'),
      /already has an active execution/,
    );
  } finally {
    await adapter.stop();
  }
});

test('does not advertise an unimplemented resume capability', () => {
  const adapter = new DshAcpAdapter({ dshRoot: join(tmpdir(), 'unused-dsh-root') });
  assert.equal(adapter.capabilities.resume, false);
});

test('turns a missing executable spawn error into a controlled rejection', async () => {
  const root = makeFakeDshRoot('');
  const adapter = new DshAcpAdapter({
    dshRoot: root,
    nodePath: join(tmpdir(), `uw-missing-node-${Date.now()}`),
    initializeTimeoutMs: 100,
    sessionTimeoutMs: 100,
  });

  try {
    await assert.rejects(adapter.start(), /ENOENT|spawn/i);
  } finally {
    await adapter.stop();
  }
});
