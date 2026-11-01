// Minimal MCP stdio bridge. The native harness (Codex/DSH) launches this file;
// it forwards tool calls to the local CollaborationGateway. It deliberately
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

const DELEGATE_TOOL = {
  name: 'delegate_to_worker',
  description:
    'Delegate one task to another native AI harness (default worker: dsh) and wait for the completed output.',
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

const START_TOOL = {
  name: 'start_delegation',
  description:
    'Start a task on another native AI harness and return immediately with a work item id. ' +
    'Use get_delegation_result later to read the outcome.',
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

const RESULT_TOOL = {
  name: 'get_delegation_result',
  description:
    'Read the current state of a delegation started with start_delegation. ' +
    'Returns the state and, once completed, the stored worker output.',
  inputSchema: {
    type: 'object',
    properties: {
      workItemId: { type: 'string', description: 'The id returned by start_delegation.' },
    },
    required: ['workItemId'],
    additionalProperties: false,
  },
};

function requireConfig(): { url: string; token: string } {
  if (GATEWAY_URL === undefined || GATEWAY_TOKEN === undefined) {
    throw new Error('Collaboration gateway is not configured');
  }
  return { url: GATEWAY_URL, token: GATEWAY_TOKEN };
}

function gatewayBase(): string {
  const { url } = requireConfig();
  // UW_GATEWAY_URL points at /delegate; derive the origin for sibling routes.
  const parsed = new URL(url);
  return parsed.origin;
}

async function requestGateway(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const { token } = requireConfig();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    // One key per tool call: it identifies this call if the same request is
    // delivered twice. The bridge does not retry, so this is not a retry
    // cache across attempts.
    headers['idempotency-key'] = randomUUID();
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gateway returned non-JSON (HTTP ${String(response.status)})`);
  }
  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `Gateway HTTP ${String(response.status)}`;
    throw new Error(message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Gateway response is not an object');
  }
  return parsed as Record<string, unknown>;
}

function readTaskArgs(args: Record<string, unknown>): { task: string; worker: string } {
  const task = args.task;
  if (typeof task !== 'string' || task.trim() === '') {
    throw new Error('task must be a non-empty string');
  }
  const worker = typeof args.worker === 'string' && args.worker.trim() !== ''
    ? args.worker
    : DEFAULT_WORKER;
  return { task, worker };
}

async function delegateToWorker(args: Record<string, unknown>): Promise<string> {
  const { task, worker } = readTaskArgs(args);
  const { url } = requireConfig();
  const body = await requestGateway('POST', url, { task, worker });
  const output = body.output;
  if (typeof output !== 'string') {
    throw new Error('Gateway response has no output');
  }
  return output;
}

async function startDelegation(args: Record<string, unknown>): Promise<string> {
  const { task, worker } = readTaskArgs(args);
  const body = await requestGateway('POST', `${gatewayBase()}/delegations`, { task, worker });
  const workItemId = body.workItemId;
  if (typeof workItemId !== 'string') {
    throw new Error('Gateway response has no workItemId');
  }
  return JSON.stringify({ workItemId, state: body.state, executionId: body.executionId });
}

async function getDelegationResult(args: Record<string, unknown>): Promise<string> {
  const workItemId = args.workItemId;
  if (typeof workItemId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(workItemId)) {
    throw new Error('workItemId must be a work item uuid');
  }
  const body = await requestGateway(
    'GET',
    `${gatewayBase()}/delegations/${encodeURIComponent(workItemId)}`,
  );
  return JSON.stringify(body);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'delegate_to_worker':
      return delegateToWorker(args);
    case 'start_delegation':
      return startDelegation(args);
    case 'get_delegation_result':
      return getDelegationResult(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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
      reply(id, { tools: [DELEGATE_TOOL, START_TOOL, RESULT_TOOL] });
      return;
    case 'tools/call': {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      const args = typeof params?.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
      try {
        const text = await callTool(String(params?.name), args);
        reply(id, { content: [{ type: 'text', text }], isError: false });
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
