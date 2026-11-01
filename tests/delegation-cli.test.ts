import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision as HarnessApprovalDecision,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import {
  buildCodexHostConfig,
  buildDshMcpServers,
  decideApprovalDecision,
  parseDelegationCliArgs,
  resolveCodexExecutableOption,
  runDelegationCli,
  runInteractive,
  type DelegationCliOptions,
} from '../src/delegation-cli.js';

const info = { url: 'http://127.0.0.1:1234/delegate', token: 'test-token' };
const bridgePath = 'C:/workspace/dist/src/mcp-delegate-bridge.js';

test('defaults to a Codex host and a DSH worker', () => {
  const options = parseDelegationCliArgs(['./project']);
  assert.equal(options?.projectDir, './project');
  assert.equal(options?.host, 'codex');
  assert.equal(options?.worker, 'dsh');
  assert.equal(options?.maxTaskChars, 20_000);
  assert.equal(options?.task, undefined);
  assert.equal(options?.allowHostPermissions, false);
  assert.equal(options?.trustWorker, false);
});

test('parses host, worker, task, state directory and approval flags', () => {
  const options = parseDelegationCliArgs([
    './project',
    '--host',
    'dsh',
    '--worker',
    'codex',
    '--task',
    'reply WORKER-OK',
    '--state-dir',
    './state',
    '--max-task-chars',
    '500',
    '--allow-host-permissions',
    '--trust-worker',
  ]);
  assert.equal(options?.host, 'dsh');
  assert.equal(options?.worker, 'codex');
  assert.equal(options?.task, 'reply WORKER-OK');
  assert.equal(options?.stateDirectory, './state');
  assert.equal(options?.maxTaskChars, 500);
  assert.equal(options?.allowHostPermissions, true);
  assert.equal(options?.trustWorker, true);
});

test('accepts --flag=value and a literal project path after --', () => {
  const inline = parseDelegationCliArgs(['./project', '--host=dsh', '--worker=codex']);
  assert.equal(inline?.host, 'dsh');
  assert.equal(inline?.worker, 'codex');
  const literal = parseDelegationCliArgs(['--', '-weird-project']);
  assert.equal(literal?.projectDir, '-weird-project');
});

test('rejects missing project, unknown options, duplicates and invalid values', () => {
  assert.throws(() => parseDelegationCliArgs([]), /Missing project directory/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--host', 'other']), /--host/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--worker', 'other']), /--worker/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--nope']), /Unknown option/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--host', 'dsh', '--host', 'codex']), /Duplicate option/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--max-task-chars', '0']), /max-task-chars/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--max-task-chars', '1000001']), /max-task-chars/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--host']), /must not be empty/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--task', '   ']), /must not be empty/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--codex-exe', '']), /must not be empty/);
});

test('builds the Codex MCP config with an object env', () => {
  const config = buildCodexHostConfig(bridgePath, info, 'dsh');
  const server = (config.mcp_servers as Record<string, Record<string, unknown>>).unified_delegate;
  assert.equal(server?.command, process.execPath);
  assert.deepEqual(server?.args, [bridgePath]);
  assert.deepEqual(server?.env, {
    UW_GATEWAY_URL: info.url,
    UW_GATEWAY_TOKEN: info.token,
    UW_WORKER: 'dsh',
  });
});

test('builds the DSH mcpServers declaration with an array env', () => {
  const servers = buildDshMcpServers(bridgePath, info, 'codex');
  assert.equal(servers.length, 1);
  const server = servers[0];
  assert.equal(server?.name, 'unified_delegate');
  assert.equal(server?.command, process.execPath);
  assert.deepEqual(server?.args, [bridgePath]);
  assert.deepEqual(server?.env, [
    { name: 'UW_GATEWAY_URL', value: info.url },
    { name: 'UW_GATEWAY_TOKEN', value: info.token },
    { name: 'UW_WORKER', value: 'codex' },
  ]);
});

test('prefers --codex-exe, then a trimmed CODEX_EXE, then PATH lookup', () => {
  assert.equal(
    resolveCodexExecutableOption({ codexExe: 'C:/flag/codex.exe' }, { CODEX_EXE: 'C:/env/codex.exe' }),
    'C:/flag/codex.exe',
  );
  assert.equal(
    resolveCodexExecutableOption({ codexExe: '  C:/flag/codex.exe  ' }, {}),
    'C:/flag/codex.exe',
  );
  assert.equal(
    resolveCodexExecutableOption({}, { CODEX_EXE: '  C:/env/codex.exe  ' }),
    'C:/env/codex.exe',
  );
  assert.equal(resolveCodexExecutableOption({}, { CODEX_EXE: '   ' }), undefined);
  assert.equal(resolveCodexExecutableOption({}, {}), undefined);
});

test('host approvals stay limited to delegation unless permissions are opted in', () => {
  const strict = { allowHostPermissions: false, trustWorker: false };
  assert.equal(decideApprovalDecision('host', 'MCP server unified_delegate requests input', strict), 'allow_once');
  assert.equal(decideApprovalDecision('host', 'Codex requests additional permissions: network', strict), 'reject_once');
  assert.equal(decideApprovalDecision('host', 'Codex wants to run: rm -rf build', strict), 'reject_once');
  // Command text that merely mentions the tool must not pass.
  assert.equal(
    decideApprovalDecision('host', 'Codex wants to run: unified_delegate --danger', strict),
    'reject_once',
  );
  assert.equal(
    decideApprovalDecision('host', 'Codex requests additional permissions: network', {
      allowHostPermissions: true,
      trustWorker: false,
    }),
    'allow_once',
  );
});

test('worker approvals need an explicit opt-in', () => {
  assert.equal(decideApprovalDecision('worker', 'codex/read_file', { allowHostPermissions: false, trustWorker: false }), 'reject_once');
  assert.equal(decideApprovalDecision('worker', 'codex/read_file', { allowHostPermissions: false, trustWorker: true }), 'allow_once');
});

function makeReadline(): { input: PassThrough; readline: ReturnType<typeof createInterface> } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, readline: createInterface({ input, output }) };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} did not finish`)), 1_000).unref();
    }),
  ]);
}

test('interactive loop ends when stdin closes during a running task', async () => {
  const { input, readline } = makeReadline();
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const loop = runInteractive(
    readline,
    async (text) => {
      seen.push(text);
      await gate;
      return true;
    },
    'host',
    () => {},
  );
  input.write('hello\n');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  input.end();
  release();
  await withTimeout(loop, 'interactive loop');
  assert.deepEqual(seen, ['hello']);
});

test('interactive loop buffers lines and stops on /quit', async () => {
  const { input, readline } = makeReadline();
  const seen: string[] = [];
  const loop = runInteractive(
    readline,
    async (text) => {
      seen.push(text);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      return true;
    },
    'host',
    () => {},
  );
  input.write('a\nb\n/quit\nc\n');
  input.end();
  await withTimeout(loop, 'interactive loop');
  assert.deepEqual(seen, ['a', 'b']);
});

class FakeAdapter implements HarnessAdapter {
  capabilities: HarnessCapabilities = { approval: 'none', cancel: true, streaming: true, resume: false };
  started = false;
  stopped = false;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(
    private readonly options: { failStart?: boolean; failClose?: boolean; failStop?: boolean; output?: string } = {},
  ) {}

  async start(): Promise<void> {
    if (this.options.failStart === true) {
      throw new Error('start failed');
    }
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.options.failStop === true) {
      throw new Error('stop failed');
    }
  }
  async createConversation(): Promise<string> {
    return 'native';
  }
  async submit(_nativeId: string, executionId: string): Promise<void> {
    const output = this.options.output ?? 'WORKER-OK';
    setTimeout(() => {
      this.emit({ type: 'execution/output', executionId, channel: 'assistant', text: output });
      this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, 0);
  }
  async cancel(): Promise<void> {}
  async respondToApproval(_decision: HarnessApprovalDecision): Promise<void> {}
  async closeConversation(): Promise<void> {
    if (this.options.failClose === true) {
      throw new Error('close failed');
    }
  }
  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function cliOptions(overrides: Partial<DelegationCliOptions> = {}): DelegationCliOptions {
  return {
    projectDir: mkdtempSync(join(tmpdir(), 'uw-g013-cli-')),
    host: 'codex',
    worker: 'dsh',
    task: 'reply WORKER-OK',
    maxTaskChars: 1_000,
    allowHostPermissions: false,
    trustWorker: false,
    ...overrides,
  };
}

function fakeDeps(
  worker: FakeAdapter,
  host: FakeAdapter,
  calls: string[],
  output: string[] = [],
): Parameters<typeof runDelegationCli>[1] {
  return {
    installSignalHandlers: false,
    write: (text) => output.push(text),
    writeError: (text) => output.push(text),
    createAdapter: async (harness) => {
      calls.push(harness);
      return harness === 'dsh' ? worker : host;
    },
  };
}

test('stops before creating the host when the worker fails to start', async () => {
  const worker = new FakeAdapter({ failStart: true });
  const host = new FakeAdapter();
  const calls: string[] = [];
  const result = await runDelegationCli(cliOptions(), fakeDeps(worker, host, calls));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, ['dsh']);
  assert.equal(host.started, false);
});

test('cleans up the worker and gateway when the host fails to start', async () => {
  const worker = new FakeAdapter();
  const host = new FakeAdapter({ failStart: true });
  const calls: string[] = [];
  const result = await runDelegationCli(cliOptions(), fakeDeps(worker, host, calls));
  assert.equal(result.exitCode, 1);
  assert.equal(worker.stopped, true);
});

test('runs one task and reports success', async () => {
  const worker = new FakeAdapter();
  const host = new FakeAdapter({ output: 'DELEGATE-DONE WORKER-OK' });
  const calls: string[] = [];
  const output: string[] = [];
  const result = await runDelegationCli(cliOptions(), fakeDeps(worker, host, calls, output));
  assert.equal(result.exitCode, 0);
  assert.equal(output.join('').includes('DELEGATE-DONE WORKER-OK'), true);
  assert.equal(worker.stopped, true);
  assert.equal(host.stopped, true);
});

test('raises the exit code when cleanup fails after a successful task', async () => {
  const worker = new FakeAdapter({ failStop: true });
  const host = new FakeAdapter();
  const calls: string[] = [];
  const result = await runDelegationCli(cliOptions(), fakeDeps(worker, host, calls));
  assert.equal(result.exitCode, 1);
});
