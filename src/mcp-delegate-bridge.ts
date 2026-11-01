// Minimal MCP stdio bridge. The native harness (Codex/DSH) launches this file;
// it forwards one tool call to the local CollaborationGateway. It deliberately
// implements only initialize/tools/list/tools/call/ping.
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const GATEWAY_URL = process.env.UW_GATEWAY_URL;
const GATEWAY_TOKEN = process.env.UW_GATEWAY_TOKEN;
const DEFAULT_WORKER = process.env.UW_WORKER ?? 'dsh';

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: string | number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOL = {
  name: 'delegate_to_worker',
  description:
    'Delegate one task to another native AI harness (default worker: dsh). Returns the completed worker output.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task to give the worker.' },
      worker: {
        type: 'string',
        description: 'Optional worker connection name; defaults to the configured worker.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
};

async function callGateway(args: Record<string, unknown>): Promise<string> {
  if (GATEWAY_URL === undefined || GATEWAY_TOKEN === undefined) {
    throw new Error('Collaboration gateway is not configured');
  }
  const task = args.task;
  if (typeof task !== 'string' || task.trim() === '') {
    throw new Error('task must be a non-empty string');
  }
  const worker = typeof args.worker === 'string' && args.worker.trim() !== ''
    ? args.worker
    : DEFAULT_WORKER;
  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      // One key per tool call: a retry of the same delivery stays one work item.
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ task, worker }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Gateway returned non-JSON (HTTP ${String(response.status)})`);
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : `Gateway HTTP ${String(response.status)}`;
    throw new Error(message);
  }
  const output = typeof body === 'object' && body !== null && 'output' in body
    ? (body as { output: unknown }).output
    : undefined;
  if (typeof output !== 'string') {
    throw new Error('Gateway response has no output');
  }
  return output;
}

async function handle(message: JsonRpcRequest): Promise<void> {
  const id = message.id;
  if (id === undefined) {
    return;
  }
  switch (message.method) {
    case 'initialize': {
      const params = message.params as { protocolVersion?: unknown } | undefined;
      reply(id, {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'unified-workspace-delegate', version: '0.1.0' },
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL] });
      return;
    case 'tools/call': {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      if (params?.name !== 'delegate_to_worker') {
        reply(id, {
          content: [{ type: 'text', text: `Unknown tool: ${String(params?.name)}` }],
          isError: true,
        });
        return;
      }
      const args = typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
      try {
        const output = await callGateway(args);
        reply(id, { content: [{ type: 'text', text: output }], isError: false });
      } catch (error) {
        reply(id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
      return;
    }
    default:
      replyError(id, -32601, `Unsupported method: ${String(message.method)}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(line) as JsonRpcRequest;
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  void handle(message).catch((error: unknown) => {
    if (message.id !== undefined) {
      replyError(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
  });
});
