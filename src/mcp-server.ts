import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  replaceCompositionTool,
  validateCompositionTool,
  type CompositionToolResult,
} from './composition-tool.js';

/**
 * Minimal newline-delimited JSON-RPC 2.0 MCP server over stdio.
 *
 * It is intentionally transport-only: every tool call goes through
 * `composition-tool.ts`, so parse/validate, active-reference, daemon-lock,
 * atomic-write and revision-audit policy stays in the existing service. The
 * server never shells out, never writes composition bodies, and never forces an
 * edit. stdout carries protocol lines only; stdout logging is forbidden.
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'wax-composition';
export const MCP_SERVER_VERSION = '0.0.0';

export const COMPOSITION_VALIDATE_TOOL = 'composition_validate';
export const COMPOSITION_REPLACE_TOOL = 'composition_replace';

/** A protocol line larger than this is refused instead of buffered forever. */
const MAX_LINE_LENGTH = 4 * 1024 * 1024;

type JsonRpcId = string | number | null;

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

const TOOL_DEFINITIONS = [
  {
    name: COMPOSITION_VALIDATE_TOOL,
    description:
      'Validate one composition JSON file. Read-only: parses and validates without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the composition JSON file.',
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: COMPOSITION_REPLACE_TOOL,
    description:
      'Atomically replace one composition JSON file. Refused when the composition id differs, ' +
      'when an active reference exists in the Honey field, or when a live daemon lock is present. ' +
      'There is no force option.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the composition file to replace.',
        },
        withFile: {
          type: 'string',
          description: 'Path to the complete next composition file.',
        },
        stateDir: {
          type: 'string',
          description: 'Wax state root; defaults to ~/.wax.',
        },
        apiary: {
          type: 'string',
          description: 'Apiary id used to resolve the Honey field for active-reference checks.',
        },
      },
      required: ['file', 'withFile'],
      additionalProperties: false,
    },
  },
] as const;

interface ParsedRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

interface ParsedNotification {
  readonly method: string;
}

type ParsedMessage =
  | { readonly kind: 'request'; readonly request: ParsedRequest }
  | { readonly kind: 'notification'; readonly notification: ParsedNotification };

export interface CompositionMcpServerOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export interface McpCommandDependencies {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly stderr?: (line: string) => void;
}

/**
 * Serves JSON-RPC until the input stream ends. One message per line; responses
 * are written as one line each. A notification (no `id`) never gets a response.
 */
export async function startCompositionMcpServer(
  options: CompositionMcpServerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const sendResult = (id: JsonRpcId, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result });
  };
  const sendError = (id: JsonRpcId, code: number, message: string): void => {
    const error: JsonRpcError = { code, message };
    send({ jsonrpc: '2.0', id, error });
  };

  const handleToolCall = (id: JsonRpcId, params: unknown): void => {
    if (!isRecord(params) || typeof params['name'] !== 'string') {
      sendError(id, -32602, 'Invalid params: tools/call needs a tool name');
      return;
    }
    const args = params['arguments'] ?? {};
    if (!isRecord(args)) {
      sendError(id, -32602, 'Invalid params: tool arguments must be an object');
      return;
    }

    let result: CompositionToolResult;
    try {
      result = callCompositionTool(params['name'], args);
    } catch (error) {
      if (error instanceof ToolArgumentError) {
        sendError(id, -32602, `Invalid params: ${error.message}`);
        return;
      }
      sendError(id, -32603, `Internal error: ${messageOf(error)}`);
      return;
    }

    sendResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: result.ok !== true,
    });
  };

  const handleMessage = (line: string): void => {
    if (line.length > MAX_LINE_LENGTH) {
      sendError(null, -32700, 'Parse error: line exceeds the size limit');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      sendError(null, -32700, 'Parse error');
      return;
    }

    const message = parseMessage(parsed);
    if (message === undefined) {
      sendError(null, -32600, 'Invalid Request');
      return;
    }
    if (message.kind === 'notification') {
      // Only `notifications/initialized` is defined here, and no notification
      // ever receives a response. Unknown notifications are ignored.
      return;
    }

    const { id, method, params } = message.request;
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
        return;
      case 'ping':
        sendResult(id, {});
        return;
      case 'tools/list':
        sendResult(id, { tools: TOOL_DEFINITIONS });
        return;
      case 'tools/call':
        handleToolCall(id, params);
        return;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  };

  const readline = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      if (line.trim() === '') {
        continue;
      }
      handleMessage(line);
    }
  } finally {
    readline.close();
  }
}

/**
 * `wax mcp`: serve on the real process streams. Takes no arguments so a typo
 * cannot silently expose a different transport.
 */
export async function runMcpCommand(
  argv: readonly string[],
  deps: McpCommandDependencies = {},
): Promise<number> {
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (argv[0] !== 'mcp') {
    err('usage: wax mcp');
    return 2;
  }
  if (argv.length !== 1) {
    err('usage: wax mcp (takes no arguments; JSON-RPC is read from stdin and written to stdout)');
    return 2;
  }
  await startCompositionMcpServer({
    ...(deps.input === undefined ? {} : { input: deps.input }),
    ...(deps.output === undefined ? {} : { output: deps.output }),
  });
  return 0;
}

function parseMessage(parsed: unknown): ParsedMessage | undefined {
  if (!isRecord(parsed) || parsed['jsonrpc'] !== '2.0' || typeof parsed['method'] !== 'string') {
    return undefined;
  }
  if (!Object.hasOwn(parsed, 'id')) {
    return { kind: 'notification', notification: { method: parsed['method'] } };
  }
  const id = parsed['id'];
  if (typeof id !== 'string' && typeof id !== 'number' && id !== null) {
    return undefined;
  }
  return {
    kind: 'request',
    request: { id, method: parsed['method'], params: parsed['params'] },
  };
}

class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

function callCompositionTool(name: string, args: Record<string, unknown>): CompositionToolResult {
  if (name === COMPOSITION_VALIDATE_TOOL) {
    rejectUnknownArguments(args, ['file']);
    const file = requiredStringArgument(args, 'file');
    return validateCompositionTool(file);
  }
  if (name === COMPOSITION_REPLACE_TOOL) {
    rejectUnknownArguments(args, ['file', 'withFile', 'stateDir', 'apiary']);
    const file = requiredStringArgument(args, 'file');
    const withFile = requiredStringArgument(args, 'withFile');
    const stateDir = optionalStringArgument(args, 'stateDir');
    const apiary = optionalStringArgument(args, 'apiary');
    return replaceCompositionTool({
      file,
      withFile,
      ...(stateDir === undefined ? {} : { stateDir }),
      ...(apiary === undefined ? {} : { apiary }),
    });
  }
  throw new ToolArgumentError(`unknown tool '${name}'`);
}

function rejectUnknownArguments(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolArgumentError(`unknown argument '${key}'`);
    }
  }
}

function requiredStringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolArgumentError(`argument '${name}' must be a non-empty string`);
  }
  return value;
}

function optionalStringArgument(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolArgumentError(`argument '${name}' must be a non-empty string when present`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runMcpCommand(['mcp']).then((code) => {
    process.exitCode = code;
  });
}
