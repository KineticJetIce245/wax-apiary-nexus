import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../src/adapters/dsh-acp/adapter.js';
import type { HarnessEvent } from '../src/adapters/harness.js';
import { assertHarnessAdapterContract } from './support/harness-adapter-contract.js';

const FAKE_ACP_SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let sessionSeq = 0;
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
    sessionSeq += 1;
    send(message.id, { sessionId: 'fake-session-' + sessionSeq });
  }
  // Deliberately never answer session/prompt or session/close.
});
`;

const FAKE_ACP_RECORDER = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const recordPath = process.argv[4];
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
    fs.writeFileSync(recordPath, JSON.stringify(message.params));
    send(message.id, { sessionId: 'recorded-session' });
    return;
  }
  if (message.method === 'session/resume') {
    fs.writeFileSync(recordPath, JSON.stringify(message.params));
    send(message.id, { configOptions: [] });
    return;
  }  if (message.method === 'session/close') {
    send(message.id, {});
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

test('passes mcpServers through to ACP session/new', async () => {
  const root = makeFakeDshRoot(FAKE_ACP_RECORDER);
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-fake-mcp-project-'));
  const recordPath = join(projectDir, 'session-new.json');
  const mcpServers = [
    {
      name: 'unified_delegate',
      command: 'node',
      args: ['bridge.js'],
      env: [{ name: 'UW_WORKER', value: 'dsh' }],
    },
  ];
  const adapter = new DshAcpAdapter({
    dshRoot: root,
    dshArgs: [recordPath],
    sessionTimeoutMs: 100,
    mcpServers,
  });
  try {
    await adapter.start();
    await adapter.createConversation({ id: 'fake', directory: projectDir });
    const recorded = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      mcpServers?: unknown;
    };
    assert.deepEqual(recorded.mcpServers, mcpServers);
  } finally {
    await adapter.stop();
  }
});

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
      /closing/i,
    );
  } finally {
    await adapter.stop();
  }
});

test('keeps an idle session non-submittable after a close timeout', async () => {
  const root = makeFakeDshRoot(FAKE_ACP_SERVER);
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-fake-idle-project-'));
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 100 });

  try {
    await adapter.start();
    const nativeId = await adapter.createConversation({ id: 'fake', directory: projectDir });
    await assert.rejects(adapter.closeConversation(nativeId), /timed out|timeout/i);
    await assert.rejects(
      adapter.submit(nativeId, 'execution-after-close', 'hello'),
      /closing/i,
    );
  } finally {
    await adapter.stop();
  }
});

test('advertises its implemented resume capability', () => {
  const adapter = new DshAcpAdapter({ dshRoot: join(tmpdir(), 'unused-dsh-root') });
  assert.equal(adapter.capabilities.resume, true);
  assert.equal(typeof adapter.resume, 'function');
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

test('satisfies the harness adapter contract', async () => {
  const root = makeFakeDshRoot(FAKE_ACP_SERVER);
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-contract-project-'));
  const secondProjectDir = mkdtempSync(join(tmpdir(), 'uw-contract-project-'));
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 1_000 });

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

const CAPTURE_ACP_SERVER = (imageEnabled: boolean) => String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const rl = readline.createInterface({ input: process.stdin });
let sessionSeq = 0;
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: ${String(imageEnabled)} } },
    });
    return;
  }
  if (message.method === 'session/new') {
    sessionSeq += 1;
    send(message.id, { sessionId: 'capture-session-' + sessionSeq });
    return;
  }
  if (message.method === 'session/prompt') {
    fs.appendFileSync(process.env.DSH_PROMPT_CAPTURE, JSON.stringify(message.params) + '\n');
    send(message.id, { stopReason: 'end_turn' });
  }
});
`;

async function capturePrompt(imageEnabled: boolean): Promise<unknown[]> {
  const root = makeFakeDshRoot(CAPTURE_ACP_SERVER(imageEnabled));
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-capture-project-'));
  const imagePath = join(projectDir, 'input.png');
  writeFileSync(imagePath, Buffer.from('capture-image'));
  const capture = join(projectDir, 'prompts.jsonl');
  const previous = process.env.DSH_PROMPT_CAPTURE;
  process.env.DSH_PROMPT_CAPTURE = capture;
  const adapter = new DshAcpAdapter({ dshRoot: root, sessionTimeoutMs: 1_000 });
  try {
    await adapter.start();
    const nativeId = await adapter.createConversation({ id: 'capture', directory: projectDir });
    await adapter.submit(nativeId, 'capture-execution', 'look', [
      { kind: 'image', path: imagePath, mimeType: 'image/png', name: 'input.png' },
    ]);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !existsSync(capture)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(capture), true);
    const lines = readFileSync(capture, 'utf8').trim().split('\n');
    return JSON.parse(lines.at(-1) as string).prompt as unknown[];
  } finally {
    if (previous === undefined) {
      delete process.env.DSH_PROMPT_CAPTURE;
    } else {
      process.env.DSH_PROMPT_CAPTURE = previous;
    }
    await adapter.stop().catch(() => undefined);
  }
}

test('sends ACP image content when the agent advertises image prompts', async () => {
  const prompt = await capturePrompt(true);
  assert.equal(prompt.length, 2);
  assert.deepEqual(prompt[0], { type: 'text', text: 'look' });
  assert.deepEqual(prompt[1], {
    type: 'image',
    data: Buffer.from('capture-image').toString('base64'),
    mimeType: 'image/png',
  });
});

test('keeps the text fallback when the agent does not advertise image prompts', async () => {
  const prompt = await capturePrompt(false);
  assert.deepEqual(prompt, [{ type: 'text', text: 'look' }]);
});


test('resumes a session with the project cwd and advertises resume capability', async () => {
  const root = makeFakeDshRoot(FAKE_ACP_RECORDER);
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-fake-resume-project-'));
  const recordPath = join(projectDir, 'session-resume.json');
  const adapter = new DshAcpAdapter({ dshRoot: root, dshArgs: [recordPath], sessionTimeoutMs: 2_000 });
  await adapter.start();
  try {
    assert.equal(adapter.capabilities.resume, true);
    await adapter.resume('session-old', projectDir);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')), {
      sessionId: 'session-old',
      cwd: projectDir,
    });
  } finally {
    await adapter.stop();
  }
});

