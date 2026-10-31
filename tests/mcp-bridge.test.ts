import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../src/mcp-delegate-bridge.js', import.meta.url));

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
    assert.equal((initialize?.serverInfo as Record<string, unknown> | undefined)?.name, 'unified-workspace-delegate');
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
