import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { compositionAuditPath } from '../src/composition/composition-edit.js';
import { runMcpCommand } from '../src/cli/mcp-server.js';
import { honeyPaths } from '../src/storage/honey.js';

const SERVER_ENTRY = resolve('dist/src/cli/mcp-server.js');
const CLI_ENTRY = resolve('dist/src/cli/cli.js');

interface RpcErrorShape {
  readonly code: number;
  readonly message: string;
}

interface RpcResponse {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: RpcErrorShape;
}

interface Waiter {
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** A minimal MCP client that speaks newline-delimited JSON-RPC to a child. */
class McpSession {
  readonly lines: string[] = [];
  readonly parseFailures: string[] = [];
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters = new Map<number, Waiter>();
  private buffer = '';
  private seq = 0;

  constructor(entry: string, args: readonly string[] = []) {
    this.child = spawn(process.execPath, [entry, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.onData(chunk);
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr.push(chunk);
    });
  }

  request(method: string, params?: unknown): Promise<RpcResponse> {
    this.seq += 1;
    const id = this.seq;
    return new Promise<RpcResponse>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 10_000);
      this.waiters.set(id, { resolve: resolvePromise, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  async close(): Promise<number> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
    }
    const code = await new Promise<number>((resolvePromise) => {
      if (this.child.exitCode !== null) {
        resolvePromise(this.child.exitCode);
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill();
        resolvePromise(-1);
      }, 10_000);
      this.child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolvePromise(exitCode ?? -1);
      });
    });
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('session closed'));
    }
    this.waiters.clear();
    return code;
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === '') {
        continue;
      }
      this.lines.push(line);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.parseFailures.push(line);
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      const id = parsed['id'];
      if (typeof id === 'number') {
        const waiter = this.waiters.get(id);
        if (waiter !== undefined) {
          this.waiters.delete(id);
          clearTimeout(waiter.timer);
          waiter.resolve(parsed as RpcResponse);
        }
      }
    }
  }
}

interface CompositionPair {
  readonly directory: string;
  readonly currentPath: string;
  readonly nextPath: string;
  readonly nextText: string;
}

function compositionText(options: { readonly id?: string; readonly prompt?: string } = {}): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id: options.id ?? 'mcp-demo',
      nodes: {
        start: {
          kind: 'forager',
          config: { connection: 'codex', prompt: options.prompt ?? 'SECRET-OLD-PROMPT {{input}}' },
        },
      },
      edges: [],
    },
    null,
    2,
  )}\n`;
}

function writeCompositionPair(
  currentText: string = compositionText(),
  nextText: string = compositionText({ prompt: 'SECRET-NEW-PROMPT {{input}}' }),
): CompositionPair {
  const directory = mkdtempSync(join(tmpdir(), 'wax-mcp-composition-'));
  const currentPath = join(directory, 'composition.json');
  const nextPath = join(directory, 'next.json');
  writeFileSync(currentPath, currentText);
  writeFileSync(nextPath, nextText);
  return { directory, currentPath, nextPath, nextText };
}

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-mcp-state-'));
}

/** A Honey field whose `start` node still holds a queued Pheromone. */
function writeActiveQueueField(
  stateDir: string,
  apiary: string,
  compositionId: string,
): string {
  const paths = honeyPaths(stateDir, apiary, compositionId);
  mkdirSync(dirname(paths.field), { recursive: true });
  writeFileSync(
    paths.field,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        compositionId,
        graphRevision: 'field-revision',
        rest: false,
        nodes: {
          start: {
            queue: [
              {
                id: 'ph_1',
                traceId: 'tr_1',
                value: { kind: 'text', text: 'payload' },
                at: '2026-03-01T00:00:00.000Z',
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return paths.field;
}

interface ToolResult {
  readonly raw: string;
  readonly json: Record<string, unknown>;
  readonly isError: unknown;
}

/** Asserts the MCP result carries exactly one text content item. */
function toolResult(response: RpcResponse): ToolResult {
  const result = response.result;
  assert.ok(isRecord(result), 'tools/call result must be an object');
  const content = result['content'];
  assert.ok(Array.isArray(content), 'tools/call result must carry content');
  assert.equal(content.length, 1, 'tools/call must return exactly one content item');
  const item = content[0];
  assert.ok(isRecord(item), 'the content item must be an object');
  assert.equal(item['type'], 'text');
  const text = item['text'];
  assert.equal(typeof text, 'string');
  const json: unknown = JSON.parse(text as string);
  assert.ok(isRecord(json), 'the text content must be a JSON object');
  return { raw: text as string, json, isError: result['isError'] };
}

function assertProtocolIsClean(session: McpSession): void {
  assert.deepEqual(session.parseFailures, [], 'stdout must contain only JSON-RPC lines');
  assert.deepEqual(session.stderr, [], 'stderr must stay empty');
  for (const line of session.lines) {
    assert.ok(isRecord(JSON.parse(line)), 'every stdout line must be a JSON object');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('serves the MCP handshake and ping on a spawned stdio server', async () => {
  const session = new McpSession(SERVER_ENTRY);
  try {
    const initialized = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0' },
    });
    assert.deepEqual(initialized.result, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'wax-composition', version: '0.0.0' },
    });

    session.notify('notifications/initialized');
    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    assert.equal(
      session.lines.length,
      2,
      'notifications/initialized must not receive a response',
    );
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0, 'the server exits cleanly on stdout end');
  }
});

test('tools/list exposes both composition tools with closed schemas', async () => {
  const session = new McpSession(SERVER_ENTRY);
  try {
    const listed = await session.request('tools/list');
    assert.ok(isRecord(listed.result));
    const tools = listed.result['tools'];
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 2);
    const byName = new Map<string, Record<string, unknown>>();
    for (const tool of tools) {
      assert.ok(isRecord(tool));
      byName.set(String(tool['name']), tool);
    }
    assert.deepEqual([...byName.keys()], ['composition_validate', 'composition_replace']);

    const validate = byName.get('composition_validate');
    assert.ok(validate !== undefined);
    const validateSchema = validate['inputSchema'];
    assert.ok(isRecord(validateSchema));
    assert.equal(validateSchema['type'], 'object');
    assert.deepEqual(validateSchema['required'], ['file']);
    assert.equal(validateSchema['additionalProperties'], false);
    assert.deepEqual(Object.keys(asRecord(validateSchema['properties'])), ['file']);

    const replace = byName.get('composition_replace');
    assert.ok(replace !== undefined);
    const replaceSchema = replace['inputSchema'];
    assert.ok(isRecord(replaceSchema));
    assert.deepEqual(replaceSchema['required'], ['file', 'withFile']);
    assert.equal(replaceSchema['additionalProperties'], false);
    assert.deepEqual(Object.keys(asRecord(replaceSchema['properties'])), [
      'file',
      'withFile',
      'stateDir',
      'apiary',
    ]);
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('composition_validate returns the 4B-A JSON result and no body', async () => {
  const pair = writeCompositionPair();
  const session = new McpSession(SERVER_ENTRY);
  try {
    const response = await session.request('tools/call', {
      name: 'composition_validate',
      arguments: { file: pair.currentPath },
    });
    const result = toolResult(response);
    assert.equal(result.isError, false);
    assert.equal(result.json['ok'], true);
    assert.equal(result.json['command'], 'validate');
    assert.equal(result.json['compositionId'], 'mcp-demo');
    assert.match(String(result.json['graphRevision']), /^[0-9a-f]{12}$/);
    assert.equal(result.raw.includes('SECRET-OLD-PROMPT'), false);
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('composition_validate maps a parse failure to isError true', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wax-mcp-bad-'));
  const badPath = join(directory, 'broken.json');
  writeFileSync(badPath, '{ not json');
  const session = new McpSession(SERVER_ENTRY);
  try {
    const response = await session.request('tools/call', {
      name: 'composition_validate',
      arguments: { file: badPath },
    });
    const result = toolResult(response);
    assert.equal(result.isError, true);
    assert.equal(result.json['ok'], false);
    assert.equal(result.json['command'], 'validate');
    assert.equal(result.json['code'], 'parse');
    assert.equal(result.raw.includes('{ not json'), false);
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('composition_replace succeeds through the guarded service and audits once', async () => {
  const pair = writeCompositionPair();
  const state = stateDirectory();
  const session = new McpSession(SERVER_ENTRY);
  try {
    const response = await session.request('tools/call', {
      name: 'composition_replace',
      arguments: {
        file: pair.currentPath,
        withFile: pair.nextPath,
        stateDir: state,
      },
    });
    const result = toolResult(response);
    assert.equal(result.isError, false);
    assert.equal(result.json['ok'], true);
    assert.equal(result.json['command'], 'replace');
    assert.equal(result.json['compositionId'], 'mcp-demo');
    assert.equal(result.raw.includes('SECRET-OLD-PROMPT'), false);
    assert.equal(result.raw.includes('SECRET-NEW-PROMPT'), false);

    assert.equal(readFileSync(pair.currentPath, 'utf8'), pair.nextText);
    const auditPath = compositionAuditPath(state);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const audit = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(audit['compositionId'], 'mcp-demo');
    assert.equal(audit['mode'], 'replace');
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('composition_replace refuses an active reference and does not write', async () => {
  const pair = writeCompositionPair();
  const state = stateDirectory();
  writeActiveQueueField(state, 'mcp-apiary', 'mcp-demo');
  const before = readFileSync(pair.currentPath, 'utf8');
  const session = new McpSession(SERVER_ENTRY);
  try {
    const response = await session.request('tools/call', {
      name: 'composition_replace',
      arguments: {
        file: pair.currentPath,
        withFile: pair.nextPath,
        stateDir: state,
        apiary: 'mcp-apiary',
      },
    });
    const result = toolResult(response);
    assert.equal(result.isError, true);
    assert.equal(result.json['ok'], false);
    assert.equal(result.json['command'], 'replace');
    assert.equal(result.json['code'], 'refused');
    assert.match(String(result.json['error']), /active references/);
    assert.equal(readFileSync(pair.currentPath, 'utf8'), before, 'a refusal never writes');
    assert.equal(existsSync(compositionAuditPath(state)), false);
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('malformed JSON is a parse error and the server keeps serving', async () => {
  const session = new McpSession(SERVER_ENTRY);
  try {
    session.sendRaw('{');
    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    assert.equal(session.lines.length, 2);
    const first = JSON.parse(session.lines[0] as string) as Record<string, unknown>;
    assert.equal(first['id'], null);
    const error = first['error'];
    assert.ok(isRecord(error));
    assert.equal(error['code'], -32700);
    assert.match(String(error['message']), /Parse error/);
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('an unknown method is a JSON-RPC error and does not stop the server', async () => {
  const session = new McpSession(SERVER_ENTRY);
  try {
    const unknown = await session.request('resources/list');
    assert.equal(unknown.error?.code, -32601);
    assert.match(String(unknown.error?.message), /Method not found/);

    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('unknown tools and invalid arguments are invalid params', async () => {
  const pair = writeCompositionPair();
  const session = new McpSession(SERVER_ENTRY);
  try {
    const unknownTool = await session.request('tools/call', {
      name: 'composition_delete',
      arguments: {},
    });
    assert.equal(unknownTool.error?.code, -32602);
    assert.match(String(unknownTool.error?.message), /unknown tool/);

    const missingFile = await session.request('tools/call', {
      name: 'composition_validate',
      arguments: {},
    });
    assert.equal(missingFile.error?.code, -32602);

    const badType = await session.request('tools/call', {
      name: 'composition_validate',
      arguments: { file: 42 },
    });
    assert.equal(badType.error?.code, -32602);

    const extraArgument = await session.request('tools/call', {
      name: 'composition_validate',
      arguments: { file: pair.currentPath, apiary: 'mcp-apiary' },
    });
    assert.equal(extraArgument.error?.code, -32602);
    assert.match(String(extraArgument.error?.message), /unknown argument/);

    const missingWithFile = await session.request('tools/call', {
      name: 'composition_replace',
      arguments: { file: pair.currentPath },
    });
    assert.equal(missingWithFile.error?.code, -32602);

    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('the wax mcp CLI entry serves the same handshake', async () => {
  const session = new McpSession(CLI_ENTRY, ['mcp']);
  try {
    const initialized = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-cli-test', version: '0' },
    });
    assert.deepEqual(initialized.result, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'wax-composition', version: '0.0.0' },
    });
    const ping = await session.request('ping');
    assert.deepEqual(ping.result, {});
    assertProtocolIsClean(session);
  } finally {
    assert.equal(await session.close(), 0);
  }
});

test('wax mcp rejects extra arguments instead of guessing a transport', async () => {
  const stderr: string[] = [];
  const code = await runMcpCommand(['mcp', '--http'], { stderr: (line) => stderr.push(line) });
  assert.equal(code, 2);
  assert.match(stderr.join('\n'), /usage: wax mcp/);
});

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
