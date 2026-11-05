import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../src/mcp-delegate-bridge.js', import.meta.url));

test('returns protocol errors for malformed lines and unknown methods', async () => {
  const child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, UW_GATEWAY_URL: '', UW_GATEWAY_TOKEN: '', UW_WORKER: 'dsh' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const messages: Array<Record<string, unknown>> = [];
    const ready = new Promise<void>((resolve) => {
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() !== '') {
            messages.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
        if (messages.length >= 3) {
          resolve();
        }
      });
    });
    child.stdin.write('not-json\n');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'does/not/exist' })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'delegate_to_worker', arguments: { task: 'x' } },
    })}\n`);
    await ready;
    assert.equal((messages[0]?.error as { code?: number } | undefined)?.code, -32700);
    assert.equal((messages[1]?.error as { code?: number } | undefined)?.code, -32601);
    assert.equal((messages[2]?.result as { isError?: boolean } | undefined)?.isError, true);
  } finally {
    child.kill();
  }
});

test('starts an async delegation and reads its result through the bridge tools', async () => {
  const workItemId = '11111111-1111-1111-1111-111111111111';
  const seen: Array<{ method: string | undefined; url: string | undefined }> = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(request.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
      if (request.method === 'POST') {
        response.end(JSON.stringify({ workItemId, state: 'accepted', executionId: 'exec-1' }));
      } else {
        response.end(JSON.stringify({ workItemId, state: 'completed', output: 'WORKER-OK' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server has no port');
  }
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      UW_GATEWAY_URL: `http://127.0.0.1:${String(address.port)}/delegate`,
      UW_GATEWAY_TOKEN: 'test-token',
      UW_WORKER: 'dsh',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const messages: Array<Record<string, unknown>> = [];
    const waitForMessages = new Promise<void>((resolve) => {
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() !== '') {
            messages.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
        if (messages.length >= 4) {
          resolve();
        }
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'start_delegation', arguments: { task: 'reply WORKER-OK' } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_delegation_result', arguments: { workItemId } },
    })}\n`);
    await waitForMessages;

    const byId = new Map(messages.map((message) => [message.id, message]));
    const tools = (byId.get(2)?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools;
    assert.deepEqual(
      tools?.map((tool) => tool.name),
      ['delegate_to_worker', 'start_delegation', 'get_delegation_result'],
    );
    const started = byId.get(3)?.result as { content?: Array<{ text?: string }> } | undefined;
    assert.equal(JSON.parse(started?.content?.[0]?.text ?? '{}').workItemId, workItemId);
    const result = byId.get(4)?.result as { content?: Array<{ text?: string }> } | undefined;
    assert.equal(JSON.parse(result?.content?.[0]?.text ?? '{}').output, 'WORKER-OK');
    const calls = seen.map((entry) => `${String(entry.method)} ${String(entry.url)}`).sort();
    assert.deepEqual(calls, ['GET /delegations/' + workItemId, 'POST /delegations'].sort());
  } finally {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('MCP bridge initializes, lists the tool and forwards a call to the gateway', async () => {
  let received: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output: 'WORKER-OK' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server has no port');
  }
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      UW_GATEWAY_URL: `http://127.0.0.1:${String(address.port)}/delegate`,
      UW_GATEWAY_TOKEN: 'test-token',
      UW_WORKER: 'dsh',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const messages: Array<Record<string, unknown>> = [];
    const waitForMessages = new Promise<void>((resolve) => {
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() !== '') {
            messages.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
        if (messages.length >= 3) {
          resolve();
        }
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'delegate_to_worker', arguments: { task: 'reply WORKER-OK' } },
    })}\n`);
    await waitForMessages;

    assert.equal(messages.length, 3);
    const initialize = messages[0]?.result as Record<string, unknown> | undefined;
    assert.equal((initialize?.serverInfo as Record<string, unknown> | undefined)?.name, 'wax-apiary-nexus-delegate');
    const tools = (messages[1]?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools;
    assert.equal(tools?.[0]?.name, 'delegate_to_worker');
    const result = messages[2]?.result as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    } | undefined;
    assert.equal(result?.isError, false);
    assert.equal(result?.content?.[0]?.text, 'WORKER-OK');
    assert.deepEqual(received, { task: 'reply WORKER-OK', worker: 'dsh' });
  } finally {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
