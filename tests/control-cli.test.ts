import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runCli } from '../src/cli/cli.js';
import { CliUsageError } from '../src/cli/cli-shared.js';
import {
  runGraphCli,
  runTriggerCli,
  type ControlCliDependencies,
} from '../src/cli/control-cli.js';
import {
  parseWaxdArgs,
  runWaxdCli,
  type WaxdStartedInfo,
} from '../src/cli/waxd-cli.js';
import { ControlClient, discoverDaemon } from '../src/control/client.js';
import type { HarnessKind } from '../src/session/connection.js';
import { FakeAdapter } from './support/fake-adapter.js';

interface Invocation {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

type ControlRunner = (
  argv: readonly string[],
  deps: ControlCliDependencies,
) => Promise<number>;

interface TestDaemon {
  readonly adapter: TrackingFakeAdapter;
  readonly stateRoot: string;
  readonly daemonDir: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly started: WaxdStartedInfo;
  stop(): Promise<number>;
}

interface MultiTestDaemon {
  readonly adapters: ReadonlyMap<HarnessKind, TrackingFakeAdapter>;
  readonly stateRoot: string;
  readonly daemonDir: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly started: readonly WaxdStartedInfo[];
  stop(): Promise<number>;
}

interface MultiWaxdOptions {
  readonly createAdapter?: (harness: HarnessKind) => TrackingFakeAdapter;
  readonly apiary?: string;
}

class TrackingFakeAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
    await super.closeConversation(nativeId);
  }
}

class FailingStartAdapter extends FakeAdapter {
  override async start(): Promise<void> {
    this.startCalls += 1;
    throw new Error('adapter start failed');
  }
}

class FailingStopAdapter extends TrackingFakeAdapter {
  override async stop(): Promise<void> {
    this.stopCalls += 1;
    throw new Error('adapter stop failed');
  }
}

class OrderedStopAdapter extends TrackingFakeAdapter {
  constructor(
    private readonly order: HarnessKind[],
    private readonly harness: HarnessKind,
  ) {
    super();
  }

  override async stop(): Promise<void> {
    this.order.push(this.harness);
    this.stopCalls += 1;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    settle = resolvePromise;
  });
  return {
    promise,
    resolve: (value: T) => {
      settle?.(value);
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tempJson(value: unknown, name = 'input.json'): string {
  const path = join(tempDir('wax-control-cli-file-'), name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function tempRaw(text: string, name = 'input.json'): string {
  const path = join(tempDir('wax-control-cli-file-'), name);
  writeFileSync(path, text);
  return path;
}

function foragerComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'echo {{input}}' },
      },
    },
    edges: [],
  };
}

function parkedComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'echo {{input}}' },
      },
      ask: {
        kind: 'user',
        config: { modality: 'text', prompt: 'Approve?' },
      },
    },
    edges: [],
  };
}

function freshBindings(): Record<string, unknown> {
  return { only: { kind: 'fresh' } };
}

interface ManifestFixture {
  readonly root: string;
  readonly project: string;
  readonly composition: string;
  readonly manifestPath: string;
  readonly manifest: Record<string, unknown>;
}

interface ManifestFixtureOptions {
  readonly graphId?: string;
  readonly projectId?: string;
  readonly idleTtlMs?: number;
  readonly harness?: HarnessKind;
}

function manifestFixture(options: ManifestFixtureOptions = {}): ManifestFixture {
  const root = tempDir('wax-control-cli-manifest-');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const composition = join(root, 'composition.json');
  writeFileSync(
    composition,
    JSON.stringify(foragerComposition(options.graphId ?? 'manifest-graph')),
  );
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    composition: 'composition.json',
    project: { id: options.projectId ?? 'manifest-project-id', directory: 'project' },
    harness: options.harness ?? 'codex',
    bindings: freshBindings(),
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
  };
  const manifestPath = join(root, 'graph.wax.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, project, composition, manifestPath, manifest };
}

function writeManifestVariant(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

async function startWaxd(t: TestContext): Promise<TestDaemon> {
  const adapter = new TrackingFakeAdapter();
  const stateRoot = tempDir('wax-control-cli-state-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const started = deferred<WaxdStartedInfo>();
  const controller = new AbortController();

  const run = runWaxdCli(
    [
      '--harness',
      'codex',
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      'apiary',
    ],
    {
      createAdapter: async () => adapter,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => started.resolve(info),
    },
  );
  // Keep an unexpected startup rejection from becoming an unhandled rejection
  // while the helper is still waiting for onStarted.
  run.catch(() => undefined);

  const startedInfo = await withTimeout(started.promise, 5_000, 'waxd start');
  const stop = async (): Promise<number> => {
    controller.abort();
    return await run;
  };
  t.after(async () => {
    controller.abort();
    await run.catch(() => undefined);
  });

  return {
    adapter,
    stateRoot,
    daemonDir,
    stdout,
    stderr,
    started: startedInfo,
    stop,
  };
}

async function startMultiWaxd(
  t: TestContext,
  options: MultiWaxdOptions = {},
): Promise<MultiTestDaemon> {
  const adapters = new Map<HarnessKind, TrackingFakeAdapter>();
  const stateRoot = tempDir('wax-control-cli-multi-state-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const started: WaxdStartedInfo[] = [];
  const bothStarted = deferred<readonly WaxdStartedInfo[]>();
  const controller = new AbortController();

  const run = runWaxdCli(
    [
      '--harnesses',
      'codex,dsh',
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      options.apiary ?? 'apiary',
      '--dsh-root',
      'C:/unused-dsh-root',
    ],
    {
      createAdapter: async (request) => {
        const adapter =
          options.createAdapter?.(request.harness) ?? new TrackingFakeAdapter();
        adapters.set(request.harness, adapter);
        return adapter;
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => {
        started.push(info);
        if (started.length === 2) {
          bothStarted.resolve([...started]);
        }
      },
    },
  );
  run.catch(() => undefined);

  const startedInfos = await withTimeout(
    bothStarted.promise,
    5_000,
    'multi waxd start',
  );
  const stop = async (): Promise<number> => {
    controller.abort();
    return await run;
  };
  t.after(async () => {
    controller.abort();
    await run.catch(() => undefined);
  });

  return {
    adapters,
    stateRoot,
    daemonDir,
    stdout,
    stderr,
    started: startedInfos,
    stop,
  };
}

async function invokeControl(
  runner: ControlRunner,
  argv: readonly string[],
  options: { readonly daemonDir?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<Invocation> {
  const full = [...argv];
  if (options.daemonDir !== undefined) {
    full.push('--daemon-dir', options.daemonDir);
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: ControlCliDependencies = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: {},
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const code = await runner(full, deps);
  return { code, stdout, stderr };
}

function singleJson(invocation: Invocation): Record<string, unknown> {
  assert.equal(invocation.code, 0, `stderr: ${invocation.stderr.join(' | ')}`);
  assert.equal(
    invocation.stdout.length,
    1,
    `expected exactly one stdout line, got ${JSON.stringify(invocation.stdout)}`,
  );
  const text = invocation.stdout[0] as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`stdout is not JSON: ${text}`);
  }
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, any> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, any>;
}

function assertUsage(run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof CliUsageError);
}

function assertNoSecret(haystack: readonly string[], secret: string): void {
  for (const text of haystack) {
    assert.equal(text.includes(secret), false, 'error output leaked a secret');
  }
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = probe.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}

test('parseWaxdArgs applies defaults and rejects usage errors', () => {
  assert.deepEqual(parseWaxdArgs(['--harness', 'codex']), {
    harness: 'codex',
    stateRoot: '~/.wax',
    apiary: 'default',
    daemonDir: '~/.wax/waxd',
    port: 0,
  });

  const codex = parseWaxdArgs([
    'waxd',
    '--harness',
    'codex',
    '--codex-exe',
    'C:/codex.exe',
    '--state-root',
    'C:/state',
    '--apiary',
    'demo',
    '--daemon-dir',
    'C:/daemon',
    '--port',
    '4321',
  ]);
  assert.ok('harness' in codex);
  assert.equal(codex.harness, 'codex');
  assert.equal(codex.codexExe, 'C:/codex.exe');
  assert.equal(codex.stateRoot, 'C:/state');
  assert.equal(codex.apiary, 'demo');
  assert.equal(codex.daemonDir, 'C:/daemon');
  assert.equal(codex.port, 4321);

  const dsh = parseWaxdArgs(['--harness', 'dsh', '--dsh-root', 'C:/dsh']);
  assert.ok('harness' in dsh);
  assert.equal(dsh.harness, 'dsh');
  assert.equal(dsh.dshRoot, 'C:/dsh');

  const fromEnv = parseWaxdArgs(['--harness', 'dsh'], { DSH_ROOT: 'C:/dsh-env' });
  assert.equal(fromEnv.dshRoot, 'C:/dsh-env');

  assertUsage(() => parseWaxdArgs([]));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--unknown', 'x']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--json']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--harness', 'codex']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', 'positional']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--codex-exe']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--port', '70000']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--port', '-1']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--port', 'abc']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--dsh-root', 'C:/dsh']));
  assertUsage(() =>
    parseWaxdArgs(['--harness', 'dsh', '--dsh-root', 'C:/dsh', '--codex-exe', 'x']),
  );
});

test('parseWaxdArgs parses --harnesses strictly and preserves order', () => {
  const multi = parseWaxdArgs([
    '--harnesses',
    'dsh,codex',
    '--codex-exe',
    'C:/codex.exe',
    '--dsh-root',
    'C:/dsh',
  ]);
  assert.ok('harnesses' in multi);
  assert.deepEqual(multi.harnesses, ['dsh', 'codex']);
  assert.equal(multi.codexExe, 'C:/codex.exe');
  assert.equal(multi.dshRoot, 'C:/dsh');
  assert.equal(multi.stateRoot, '~/.wax');
  assert.equal(multi.apiary, 'default');
  assert.equal(multi.daemonDir, '~/.wax/waxd');
  assert.equal(multi.port, 0);

  const codexOnly = parseWaxdArgs(['--harnesses', 'codex']);
  assert.ok('harnesses' in codexOnly);
  assert.deepEqual(codexOnly.harnesses, ['codex']);
  assert.equal(codexOnly.dshRoot, undefined);
  assert.equal(codexOnly.codexExe, undefined);

  const dshFromEnv = parseWaxdArgs(['--harnesses', 'dsh'], { DSH_ROOT: 'C:/dsh-env' });
  assert.ok('harnesses' in dshFromEnv);
  assert.equal(dshFromEnv.dshRoot, 'C:/dsh-env');

  // Both overrides are valid when both harnesses are selected.
  parseWaxdArgs([
    '--harnesses',
    'codex,dsh',
    '--codex-exe',
    'C:/codex.exe',
    '--dsh-root',
    'C:/dsh',
  ]);

  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--harnesses', 'codex']));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'codex,codex']));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'dsh,dsh']));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'codex,,dsh']));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'codex,']));
  assertUsage(() => parseWaxdArgs(['--harnesses', ',codex']));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'codex,claude']));
  assertUsage(() => parseWaxdArgs(['--harnesses', '']));
  assertUsage(() => parseWaxdArgs(['--harnesses']));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'codex', '--dsh-root', 'C:/dsh']));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'dsh', '--codex-exe', 'x'], {}));
  assertUsage(() => parseWaxdArgs(['--harnesses', 'dsh'], {}));
});

test('runWaxdCli starts the control server and aborts cleanly without printing the token', async (t) => {
  const daemon = await startWaxd(t);
  const token = readFileSync(daemon.started.tokenPath, 'utf8').trim();
  const stdoutText = daemon.stdout.join('\n');

  assert.equal(daemon.stdout.length, 5);
  assert.equal(daemon.stdout[0], `waxd listening ${daemon.started.url}`);
  assert.equal(daemon.stdout[1], 'harness  codex');
  assert.equal(daemon.stdout[2], `state    ${daemon.stateRoot}`);
  assert.equal(daemon.stdout[3], `daemon   ${daemon.daemonDir}`);
  assert.equal(daemon.stdout[4], `token    ${daemon.started.tokenPath}`);
  assert.equal(stdoutText.includes(token), false);
  assert.equal(daemon.stderr.length, 0);

  const lockPath = join(daemon.daemonDir, 'daemon.lock');
  assert.equal(existsSync(lockPath), true);

  const discovery = discoverDaemon({ daemonDir: daemon.daemonDir });
  const client = new ControlClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
  });
  const health = await client.health();
  assert.equal(health['ok'], true);
  assert.equal(health['harness'], 'codex');
  assert.equal(health['pid'], process.pid);

  const code = await daemon.stop();
  assert.equal(code, 0);
  assert.equal(daemon.stderr.length, 0);
  assert.equal(daemon.adapter.stopCalls, 1);
  assert.equal(existsSync(daemon.started.tokenPath), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'server.json')), false);
  assert.equal(existsSync(lockPath), false);
  await assert.rejects(
    fetch(`${daemon.started.url}/health`, { signal: AbortSignal.timeout(2_000) }),
  );
});

test('runWaxdCli installs and removes the default SIGINT/SIGTERM handlers', async () => {
  const adapter = new TrackingFakeAdapter();
  const stateRoot = tempDir('wax-control-cli-signal-');
  const daemonDir = join(stateRoot, 'waxd');
  const started = deferred<WaxdStartedInfo>();
  const controller = new AbortController();
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  let run: Promise<number> | undefined;

  try {
    run = runWaxdCli(
      ['--harness', 'codex', '--state-root', stateRoot, '--daemon-dir', daemonDir],
      {
        createAdapter: async () => adapter,
        stdout: () => undefined,
        stderr: () => undefined,
        signal: controller.signal,
        // installSignalHandlers is omitted: the production default is on.
        onStarted: (info) => started.resolve(info),
      },
    );
    await withTimeout(started.promise, 5_000, 'waxd signal startup');
    assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
  } finally {
    controller.abort();
    if (run !== undefined) {
      assert.equal(await run, 0);
    }
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  }
});

test('runWaxdCli exits 1 and stops a partially started adapter when start fails', async () => {
  const adapter = new FailingStartAdapter();
  const stateRoot = tempDir('wax-control-cli-fail-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  let onStartedCalled = false;

  const code = await runWaxdCli(
    ['--harness', 'codex', '--state-root', stateRoot, '--daemon-dir', daemonDir],
    {
      createAdapter: async () => adapter,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      installSignalHandlers: false,
      onStarted: () => {
        onStartedCalled = true;
      },
    },
  );

  assert.equal(code, 1);
  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0] as string, /adapter start failed/);
  assert.equal((stderr[0] as string).includes('\n'), false);
  assert.equal(onStartedCalled, false);
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(existsSync(daemonDir), false);
});

test('runWaxdCli exits 1 and releases the workspace when the control port is taken', async () => {
  const probe = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = probe.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;
  const adapter = new TrackingFakeAdapter();
  const stateRoot = tempDir('wax-control-cli-port-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const code = await withTimeout(
      runWaxdCli(
        [
          '--harness',
          'codex',
          '--state-root',
          stateRoot,
          '--daemon-dir',
          daemonDir,
          '--port',
          String(port),
        ],
        {
          createAdapter: async () => adapter,
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          installSignalHandlers: false,
        },
      ),
      5_000,
      'waxd port-conflict startup',
    );

    assert.equal(code, 1);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 1);
    assert.equal((stderr[0] as string).includes('\n'), false);
    assert.equal(adapter.stopCalls, 1);
    assert.equal(existsSync(join(daemonDir, 'token')), false);
    assert.equal(existsSync(join(daemonDir, 'server.json')), false);
    assert.equal(existsSync(join(daemonDir, 'daemon.lock')), false);
  } finally {
    await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  }
});

test('runWaxdCli runs two harnesses as independent daemons and aborts both cleanly', async (t) => {
  const stopOrder: HarnessKind[] = [];
  const daemon = await startMultiWaxd(t, {
    createAdapter: (harness) => new OrderedStopAdapter(stopOrder, harness),
  });
  const infos = daemon.started;

  assert.equal(infos.length, 2);
  assert.deepEqual(
    infos.map((info) => info.harness),
    ['codex', 'dsh'],
  );
  assert.equal(new Set(infos.map((info) => info.url)).size, 2);
  assert.equal(new Set(infos.map((info) => info.daemonDir)).size, 2);

  const tokenValues: string[] = [];
  for (const info of infos) {
    assert.equal(info.stateRoot, join(daemon.stateRoot, info.harness));
    assert.equal(info.daemonDir, join(daemon.daemonDir, info.harness));
    assert.equal(existsSync(join(info.daemonDir, 'token')), true);
    assert.equal(existsSync(join(info.daemonDir, 'server.json')), true);
    assert.equal(existsSync(join(info.daemonDir, 'daemon.lock')), true);
    assert.equal(existsSync(join(info.daemonDir, 'sessions.json')), false);

    const token = readFileSync(info.tokenPath, 'utf8').trim();
    assert.ok(token.length > 0);
    tokenValues.push(token);
    assert.equal(token, discoverDaemon({ daemonDir: info.daemonDir }).token);

    const discovery = discoverDaemon({ daemonDir: info.daemonDir });
    const client = new ControlClient({
      baseUrl: discovery.baseUrl,
      token: discovery.token,
    });
    const health = await client.health();
    assert.equal(health['ok'], true);
    assert.equal(health['harness'], info.harness);
    assert.equal(health['pid'], process.pid);
  }

  assert.equal(daemon.stdout.length, infos.length * 6);
  assert.deepEqual(
    daemon.stdout,
    infos.flatMap((info) => [
      `harness ${info.harness}`,
      `waxd listening ${info.url}`,
      `harness  ${info.harness}`,
      `state    ${info.stateRoot}`,
      `daemon   ${info.daemonDir}`,
      `token    ${info.tokenPath}`,
    ]),
  );
  for (const token of tokenValues) {
    assertNoSecret(daemon.stdout, token);
  }
  assert.equal(daemon.stderr.length, 0);

  const code = await daemon.stop();
  assert.equal(code, 0);
  assert.equal(daemon.stderr.length, 0);
  // Workspaces stop in reverse start order; the failing path is covered below.
  assert.deepEqual(stopOrder, ['dsh', 'codex']);

  for (const info of infos) {
    assert.equal(daemon.adapters.get(info.harness)?.stopCalls, 1);
    assert.equal(existsSync(info.tokenPath), false);
    assert.equal(existsSync(join(info.daemonDir, 'server.json')), false);
    assert.equal(existsSync(join(info.daemonDir, 'daemon.lock')), false);
    await assert.rejects(
      fetch(`${info.url}/health`, { signal: AbortSignal.timeout(2_000) }),
    );
  }
});

test('runWaxdCli unwinds an already-started harness when a later harness fails to start', async () => {
  const stateRoot = tempDir('wax-control-cli-multi-fail-state-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const adapters = new Map<HarnessKind, FakeAdapter>();
  let onStartedCalls = 0;

  const code = await runWaxdCli(
    [
      '--harnesses',
      'codex,dsh',
      '--dsh-root',
      'C:/unused-dsh-root',
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      'apiary',
    ],
    {
      createAdapter: async (request) => {
        const adapter =
          request.harness === 'dsh' ? new FailingStartAdapter() : new TrackingFakeAdapter();
        adapters.set(request.harness, adapter);
        return adapter;
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      installSignalHandlers: false,
      onStarted: () => {
        onStartedCalls += 1;
      },
    },
  );

  assert.equal(code, 1);
  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 1);
  assert.equal(stderr[0], 'error: harness dsh: adapter start failed');
  assert.equal(onStartedCalls, 0);
  // codex had started and was rolled back; dsh cleaned up its own adapter.
  assert.equal(adapters.get('codex')?.stopCalls, 1);
  assert.equal(adapters.get('dsh')?.stopCalls, 1);
  assert.equal(existsSync(join(daemonDir, 'codex', 'token')), false);
  assert.equal(existsSync(join(daemonDir, 'codex', 'server.json')), false);
  assert.equal(existsSync(join(daemonDir, 'codex', 'daemon.lock')), false);
  assert.equal(existsSync(join(daemonDir, 'dsh')), false);
});

test('runWaxdCli keeps cleaning up other harnesses when one stop fails', async (t) => {
  const stateRoot = tempDir('wax-control-cli-multi-stop-state-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const adapters = new Map<HarnessKind, TrackingFakeAdapter>();
  const startedInfos: WaxdStartedInfo[] = [];
  const bothStarted = deferred<readonly WaxdStartedInfo[]>();
  const controller = new AbortController();

  const run = runWaxdCli(
    [
      '--harnesses',
      'codex,dsh',
      '--dsh-root',
      'C:/unused-dsh-root',
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      'apiary',
    ],
    {
      createAdapter: async (request) => {
        const adapter =
          request.harness === 'dsh' ? new FailingStopAdapter() : new TrackingFakeAdapter();
        adapters.set(request.harness, adapter);
        return adapter;
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => {
        startedInfos.push(info);
        if (startedInfos.length === 2) {
          bothStarted.resolve([...startedInfos]);
        }
      },
    },
  );
  run.catch(() => undefined);
  t.after(async () => {
    controller.abort();
    await run.catch(() => undefined);
  });

  const infos = await withTimeout(bothStarted.promise, 5_000, 'multi stop start');
  assert.equal(infos.length, 2);
  controller.abort();
  const code = await run;

  assert.equal(code, 1);
  assert.equal(stderr.length, 1);
  assert.equal(stderr[0], 'error: harness dsh: adapter stop failed');
  // The dsh failure did not prevent codex workspace cleanup.
  assert.equal(adapters.get('codex')?.stopCalls, 1);
  assert.equal(adapters.get('dsh')?.stopCalls, 1);

  for (const info of infos) {
    assert.equal(existsSync(info.tokenPath), false);
    assert.equal(existsSync(join(info.daemonDir, 'server.json')), false);
    assert.equal(existsSync(join(info.daemonDir, 'daemon.lock')), false);
    await assert.rejects(
      fetch(`${info.url}/health`, { signal: AbortSignal.timeout(2_000) }),
    );
  }
});

test('graph commands round-trip load, status, list, trigger, unload and sweep over real HTTP', async (t) => {
  const daemon = await startWaxd(t);
  const composition = tempJson(foragerComposition('cli-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-project-');

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const loaded = singleJson(load);
  assert.equal(loaded['graphId'], 'cli-graph');
  assert.equal(loaded['rest'], true);
  assert.equal(loaded['hovered'], false);
  assert.equal(daemon.adapter.displayNames.length, 1);

  // A duplicate load is a 409 from the server, not a second session.
  const duplicateLoad = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(duplicateLoad.code, 1);
  assert.equal(duplicateLoad.stdout.length, 0);
  assert.equal(duplicateLoad.stderr.length, 1);
  assert.match(duplicateLoad.stderr[0] as string, /conflict|409/);
  assert.equal(daemon.adapter.displayNames.length, 1);

  const status = singleJson(
    await invokeControl(runGraphCli, ['graph', 'status', 'cli-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal(status['graphId'], 'cli-graph');
  assert.equal(status['rest'], true);

  const humanList = await invokeControl(runGraphCli, ['graph', 'list'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(humanList.code, 0);
  assert.equal(humanList.stderr.length, 0);
  assert.equal(humanList.stdout.length, 1);
  assert.match(
    humanList.stdout[0] as string,
    /^cli-graph rest=true hovered=false nodes=1 refCount=[0-9]+$/,
  );

  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'cli-graph', 'only', '--input', 'hello graph', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(trigger);
  assert.equal(result['graphId'], 'cli-graph');
  assert.equal(result['rest'], true);
  assert.equal(result['hovered'], false);
  assert.ok((result['pumps'] as number) >= 1);
  assert.equal(result['persisted'], true);
  const resultStatus = asRecord(result['status']);
  assert.equal(resultStatus['rest'], true);
  assert.equal(asRecord((resultStatus['nodes'] as unknown[])[0])['queue'], 0);
  assert.equal(daemon.adapter.prompts.length, 1);
  assert.match(daemon.adapter.prompts[0] as string, /hello graph/);

  const unload = singleJson(
    await invokeControl(runGraphCli, ['graph', 'unload', 'cli-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal(unload['graphId'], 'cli-graph');
  assert.equal(unload['unloaded'], true);
  assert.equal(daemon.adapter.closedNativeIds.length, 1);

  const emptyList = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(emptyList['status'], []);

  const humanSweep = await invokeControl(runGraphCli, ['graph', 'sweep'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(humanSweep.code, 0);
  assert.equal(humanSweep.stderr.length, 0);
  assert.equal(humanSweep.stdout.length, 1);
  assert.equal(humanSweep.stdout[0], 'unloaded=0 skipped=0 failed=0');

  const sweep = singleJson(
    await invokeControl(runGraphCli, ['graph', 'sweep', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(sweep['unloaded'], []);
  assert.deepEqual(sweep['skipped'], []);
  assert.deepEqual(sweep['failed'], []);
});

test('graph and trigger --harness address each multi-harness daemon independently', async (t) => {
  const daemon = await startMultiWaxd(t);
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-multi-cli-project-');
  const codexComposition = tempJson(foragerComposition('codex-graph'));
  const dshComposition = tempJson(foragerComposition('dsh-graph'));

  const loadCodex = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      codexComposition,
      '--project',
      project,
      '--bindings',
      bindings,
      '--harness',
      'codex',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(loadCodex)['graphId'], 'codex-graph');

  const loadDsh = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      dshComposition,
      '--project',
      project,
      '--bindings',
      bindings,
      '--harness',
      'dsh',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(loadDsh)['graphId'], 'dsh-graph');

  const codexSessions = JSON.parse(
    readFileSync(join(daemon.daemonDir, 'codex', 'sessions.json'), 'utf8'),
  ) as Array<Record<string, unknown>>;
  const dshSessions = JSON.parse(
    readFileSync(join(daemon.daemonDir, 'dsh', 'sessions.json'), 'utf8'),
  ) as Array<Record<string, unknown>>;
  assert.equal(codexSessions.length, 1);
  assert.equal(codexSessions[0]?.['harness'], 'codex');
  assert.equal(dshSessions.length, 1);
  assert.equal(dshSessions[0]?.['harness'], 'dsh');

  const codexList = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--harness', 'codex', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(
    (codexList['status'] as unknown[]).map((status) => asRecord(status)['graphId']),
    ['codex-graph'],
  );
  const dshList = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--harness', 'dsh', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(
    (dshList['status'] as unknown[]).map((status) => asRecord(status)['graphId']),
    ['dsh-graph'],
  );

  const codexTrigger = singleJson(
    await invokeControl(
      runTriggerCli,
      ['trigger', 'codex-graph', 'only', '--input', 'to codex', '--harness', 'codex', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(codexTrigger['graphId'], 'codex-graph');
  const dshTrigger = singleJson(
    await invokeControl(
      runTriggerCli,
      ['trigger', 'dsh-graph', 'only', '--input', 'to dsh', '--harness', 'dsh', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(dshTrigger['graphId'], 'dsh-graph');
  assert.equal(daemon.adapters.get('codex')?.prompts.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.prompts.length, 1);
  assert.match(daemon.adapters.get('codex')?.prompts[0] ?? '', /to codex/);
  assert.match(daemon.adapters.get('dsh')?.prompts[0] ?? '', /to dsh/);

  // A graph id from the other harness is not visible.
  const wrongHarnessStatus = await invokeControl(
    runGraphCli,
    ['graph', 'status', 'dsh-graph', '--harness', 'codex', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(wrongHarnessStatus.code, 1);
  assert.equal(wrongHarnessStatus.stdout.length, 0);
  assert.match(wrongHarnessStatus.stderr[0] as string, /not loaded/);

  const unloadCodex = singleJson(
    await invokeControl(
      runGraphCli,
      ['graph', 'unload', 'codex-graph', '--harness', 'codex', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(unloadCodex['unloaded'], true);
  assert.equal(daemon.adapters.get('codex')?.closedNativeIds.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.closedNativeIds.length, 0);

  const dshStillLoaded = singleJson(
    await invokeControl(
      runGraphCli,
      ['graph', 'status', 'dsh-graph', '--harness', 'dsh', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(dshStillLoaded['graphId'], 'dsh-graph');
  assert.deepEqual(
    JSON.parse(readFileSync(join(daemon.daemonDir, 'codex', 'sessions.json'), 'utf8')),
    [],
  );
  assert.equal(
    (
      JSON.parse(
        readFileSync(join(daemon.daemonDir, 'dsh', 'sessions.json'), 'utf8'),
      ) as unknown[]
    ).length,
    1,
  );

  const codexToken = readFileSync(join(daemon.daemonDir, 'codex', 'token'), 'utf8').trim();
  const dshToken = readFileSync(join(daemon.daemonDir, 'dsh', 'token'), 'utf8').trim();
  const ambiguousGraph = await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(ambiguousGraph.code, 1);
  assert.equal(ambiguousGraph.stdout.length, 0);
  assert.equal(ambiguousGraph.stderr.length, 1);
  assert.match(ambiguousGraph.stderr[0] as string, /--harness/);
  assertNoSecret(ambiguousGraph.stderr, codexToken);
  assertNoSecret(ambiguousGraph.stderr, dshToken);

  const ambiguousTrigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'dsh-graph', 'only', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(ambiguousTrigger.code, 1);
  assert.equal(ambiguousTrigger.stdout.length, 0);
  assert.equal(ambiguousTrigger.stderr.length, 1);
  assert.match(ambiguousTrigger.stderr[0] as string, /--harness/);
  assertNoSecret(ambiguousTrigger.stderr, codexToken);
  assertNoSecret(ambiguousTrigger.stderr, dshToken);

  const invalidHarness = await invokeControl(
    runGraphCli,
    ['graph', 'list', '--harness', 'claude', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(invalidHarness.code, 2);
  assert.equal(invalidHarness.stdout.length, 0);
  assert.equal(invalidHarness.stderr.length, 1);
  assert.match(invalidHarness.stderr[0] as string, /--harness must be/);
});

test('multi-harness state roots isolate the same graph id and apiary', async (t) => {
  const daemon = await startMultiWaxd(t, { apiary: 'smoke' });
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-honey-project-');
  const composition = tempJson(foragerComposition('shared-graph'));
  const harnesses = ['codex', 'dsh'] as const;

  for (const harness of harnesses) {
    const load = await invokeControl(
      runGraphCli,
      [
        'graph',
        'load',
        composition,
        '--project',
        project,
        '--bindings',
        bindings,
        '--harness',
        harness,
        '--json',
      ],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(singleJson(load)['graphId'], 'shared-graph');
  }

  for (const harness of harnesses) {
    const trigger = await invokeControl(
      runTriggerCli,
      [
        'trigger',
        'shared-graph',
        'only',
        '--input',
        `from ${harness}`,
        '--harness',
        harness,
        '--json',
      ],
      { daemonDir: daemon.daemonDir },
    );
    const result = singleJson(trigger);
    assert.equal(result['rest'], true);
    assert.equal(result['persisted'], true);
  }

  for (const harness of harnesses) {
    const status = singleJson(
      await invokeControl(
        runGraphCli,
        ['graph', 'status', 'shared-graph', '--harness', harness, '--json'],
        { daemonDir: daemon.daemonDir },
      ),
    );
    assert.equal(status['rest'], true);
  }

  const codexField = join(
    daemon.stateRoot,
    'codex',
    'apiaries',
    'smoke',
    'compositions',
    'shared-graph',
    'honey',
    'field.json',
  );
  const dshField = join(
    daemon.stateRoot,
    'dsh',
    'apiaries',
    'smoke',
    'compositions',
    'shared-graph',
    'honey',
    'field.json',
  );
  assert.equal(existsSync(codexField), true);
  assert.equal(existsSync(dshField), true);
  // The pre-fix shared path must not be used.
  assert.equal(
    existsSync(
      join(
        daemon.stateRoot,
        'apiaries',
        'smoke',
        'compositions',
        'shared-graph',
        'honey',
        'field.json',
      ),
    ),
    false,
  );
  assert.equal(
    (JSON.parse(readFileSync(codexField, 'utf8')) as Record<string, unknown>)['compositionId'],
    'shared-graph',
  );
  assert.equal(
    (JSON.parse(readFileSync(dshField, 'utf8')) as Record<string, unknown>)['compositionId'],
    'shared-graph',
  );

  const unloadCodex = singleJson(
    await invokeControl(
      runGraphCli,
      ['graph', 'unload', 'shared-graph', '--harness', 'codex', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(unloadCodex['unloaded'], true);
  const dshAfterUnload = singleJson(
    await invokeControl(
      runGraphCli,
      ['graph', 'status', 'shared-graph', '--harness', 'dsh', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(dshAfterUnload['rest'], true);

  const codexSweep = singleJson(
    await invokeControl(runGraphCli, ['graph', 'sweep', '--harness', 'codex', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(codexSweep['unloaded'], []);
  const dshAfterSweep = singleJson(
    await invokeControl(
      runGraphCli,
      ['graph', 'status', 'shared-graph', '--harness', 'dsh', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(dshAfterSweep['rest'], true);
  assert.equal(existsSync(dshField), true);
});

test('a one-entry --harnesses list keeps the single-harness root layout', async (t) => {
  const adapter = new TrackingFakeAdapter();
  const stateRoot = tempDir('wax-control-cli-single-list-state-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const started = deferred<WaxdStartedInfo>();
  const controller = new AbortController();

  const run = runWaxdCli(
    [
      '--harnesses',
      'codex',
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      'smoke',
    ],
    {
      createAdapter: async () => adapter,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => started.resolve(info),
    },
  );
  run.catch(() => undefined);
  t.after(async () => {
    controller.abort();
    await run.catch(() => undefined);
  });

  const info = await withTimeout(started.promise, 5_000, 'single-list waxd start');
  assert.equal(info.harness, 'codex');
  assert.equal(info.stateRoot, stateRoot);
  assert.equal(info.daemonDir, daemonDir);
  assert.equal(stdout.length, 5);
  assert.equal(stdout[2], `state    ${stateRoot}`);
  assert.equal(stdout[3], `daemon   ${daemonDir}`);
  assert.equal(existsSync(join(daemonDir, 'token')), true);
  assert.equal(existsSync(join(daemonDir, 'codex')), false);
  assert.equal(existsSync(join(stateRoot, 'codex')), false);

  const composition = tempJson(foragerComposition('single-list-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-single-list-project-');
  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir },
  );
  assert.equal(singleJson(load)['graphId'], 'single-list-graph');
  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'single-list-graph', 'only', '--input', 'single', '--json'],
    { daemonDir },
  );
  assert.equal(singleJson(trigger)['persisted'], true);
  assert.equal(
    existsSync(
      join(
        stateRoot,
        'apiaries',
        'smoke',
        'compositions',
        'single-list-graph',
        'honey',
        'field.json',
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      join(
        stateRoot,
        'codex',
        'apiaries',
        'smoke',
        'compositions',
        'single-list-graph',
        'honey',
        'field.json',
      ),
    ),
    false,
  );

  controller.abort();
  const code = await run;
  assert.equal(code, 0);
  assert.equal(stderr.length, 0);
  assert.equal(adapter.stopCalls, 1);
});

test('waxd persists a fresh session and removes it when the graph unloads', async (t) => {
  const daemon = await startWaxd(t);
  const sessionsPath = join(daemon.daemonDir, 'sessions.json');
  assert.equal(existsSync(sessionsPath), false);

  const composition = tempJson(foragerComposition('persisted-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-persisted-project-');

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0, load.stderr.join(' | '));

  const stored = JSON.parse(readFileSync(sessionsPath, 'utf8')) as Array<Record<string, unknown>>;
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.['harness'], 'codex');
  assert.equal(stored[0]?.['projectDirectory'], project);
  assert.equal(typeof stored[0]?.['conversationId'], 'string');
  assert.equal(typeof stored[0]?.['nativeId'], 'string');
  assert.equal(typeof stored[0]?.['updatedAt'], 'string');

  const unload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'persisted-graph', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(unload.code, 0, unload.stderr.join(' | '));
  assert.deepEqual(JSON.parse(readFileSync(sessionsPath, 'utf8')), []);
});

test('runWaxdCli exits 1 before daemon files exist when sessions.json is corrupt', async () => {
  const adapter = new TrackingFakeAdapter();
  const stateRoot = tempDir('wax-control-cli-corrupt-store-');
  const daemonDir = join(stateRoot, 'waxd');
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(daemonDir, 'sessions.json'), JSON.stringify({ not: 'an array' }), 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runWaxdCli(
    ['--harness', 'codex', '--state-root', stateRoot, '--daemon-dir', daemonDir],
    {
      createAdapter: async () => adapter,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      installSignalHandlers: false,
    },
  );

  assert.equal(code, 1);
  assert.equal(stdout.length, 0);
  assert.match(stderr.join('\n'), /must contain an array/);
  assert.equal(existsSync(join(daemonDir, 'token')), false);
  assert.equal(existsSync(join(daemonDir, 'server.json')), false);
  assert.equal(existsSync(join(daemonDir, 'daemon.lock')), false);
  // The adapter was started and then stopped by the startup unwind.
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
});

test('one waxd process serves multiple graphs for its single harness', async (t) => {
  const daemon = await startWaxd(t);
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-multi-project-');

  for (const id of ['graph-a', 'graph-b']) {
    const composition = tempJson(foragerComposition(id));
    const load = await invokeControl(
      runGraphCli,
      ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(load.code, 0, load.stderr.join(' | '));
  }

  const list = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  const ids = (list['status'] as unknown[])
    .map((status) => asRecord(status)['graphId'] as string)
    .sort();
  assert.deepEqual(ids, ['graph-a', 'graph-b']);
  assert.equal(daemon.adapter.displayNames.length, 2);

  for (const id of ['graph-a', 'graph-b']) {
    const unload = await invokeControl(
      runGraphCli,
      ['graph', 'unload', id, '--json'],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(unload.code, 0, unload.stderr.join(' | '));
  }
  assert.equal(daemon.adapter.closedNativeIds.length, 2);

  const empty = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(empty['status'], []);
});

test('every --json command writes exactly one parseable JSON object', async (t) => {
  const daemon = await startWaxd(t);
  const token = readFileSync(daemon.started.tokenPath, 'utf8').trim();
  const composition = tempJson(foragerComposition('json-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-json-project-');
  const invocations: Invocation[] = [];

  invocations.push(
    await invokeControl(
      runGraphCli,
      ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'status', 'json-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  invocations.push(
    await invokeControl(
      runTriggerCli,
      ['trigger', 'json-graph', 'only', '--input', 'json', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'sweep', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'unload', 'json-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );

  for (const invocation of invocations) {
    assert.equal(invocation.code, 0, invocation.stderr.join(' | '));
    assert.equal(invocation.stderr.length, 0);
    const parsed = singleJson(invocation);
    assert.equal(typeof parsed, 'object');
    assertNoSecret(invocation.stdout, token);
    assertNoSecret(invocation.stderr, token);
  }

  const listJson = asRecord(JSON.parse(invocations[2]?.stdout[0] as string));
  assert.ok(Array.isArray(listJson['status']));
});

test('graph load rejects bad local input before any session is created', async (t) => {
  const daemon = await startWaxd(t);
  const composition = tempJson(foragerComposition('local-validation'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-validate-project-');
  const missingComposition = join(tempDir('wax-control-cli-missing-'), 'missing.json');
  const badComposition = tempRaw('{"nodes": {"only": "PROMPT_SECRET_BAD_JSON"');
  const badBindings = tempRaw('{"only": "BINDINGS_SECRET_BAD_JSON"');
  const arrayBindings = tempJson([]);

  const usageCases: (readonly string[])[] = [
    ['load', badComposition, '--project', project, '--bindings', bindings, '--json'],
    ['load', composition, '--bindings', bindings, '--json'],
    ['load', composition, '--project', project, '--bindings', badBindings, '--json'],
    ['load', composition, '--project', project, '--bindings', arrayBindings, '--json'],
    [
      'load',
      composition,
      '--project',
      project,
      '--bindings',
      bindings,
      '--idle-ttl-ms',
      '-1',
      '--json',
    ],
  ];

  for (const args of usageCases) {
    const invocation = await invokeControl(runGraphCli, ['graph', ...args], {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(invocation.code, 2, invocation.stderr.join(' | '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
    assertNoSecret(invocation.stderr, 'PROMPT_SECRET_BAD_JSON');
    assertNoSecret(invocation.stderr, 'BINDINGS_SECRET_BAD_JSON');
  }

  const ioFailure = await invokeControl(
    runGraphCli,
    ['graph', 'load', missingComposition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(ioFailure.code, 1);
  assert.equal(ioFailure.stdout.length, 0);
  assert.equal(ioFailure.stderr.length, 1);

  // None of the rejected commands reached /graphs/load.
  assert.equal(daemon.adapter.displayNames.length, 0);

  // The same daemon still accepts a valid load.
  const valid = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(valid.code, 0);
  assert.equal(daemon.adapter.displayNames.length, 1);
});

test('unknown status/unload exit 1 and a non-Rest unload returns a 409 without crashing the daemon', async (t) => {
  const daemon = await startWaxd(t);

  const missingStatus = await invokeControl(
    runGraphCli,
    ['graph', 'status', 'missing', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(missingStatus.code, 1);
  assert.equal(missingStatus.stdout.length, 0);
  assert.equal(missingStatus.stderr.length, 1);
  assert.match(missingStatus.stderr[0] as string, /not loaded/);

  const missingUnload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'missing', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(missingUnload.code, 1);
  assert.equal(missingUnload.stdout.length, 0);
  assert.equal(missingUnload.stderr.length, 1);

  const composition = tempJson(parkedComposition('parked'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-parked-project-');
  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0);

  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'parked', 'ask', '--input', 'waiting', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(trigger);
  assert.equal(result['rest'], false);
  assert.equal(result['hovered'], true);

  const unload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'parked', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(unload.code, 1);
  assert.equal(unload.stdout.length, 0);
  assert.equal(unload.stderr.length, 1);
  assert.match(unload.stderr[0] as string, /409/);

  const list = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal((list['status'] as unknown[]).length, 1);
});

test('daemon discovery and network failures exit 1 without printing a token', async () => {
  const missingDir = join(tempDir('wax-control-cli-missing-daemon-'), 'waxd');
  const missing = await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
    daemonDir: missingDir,
  });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout.length, 0);
  assert.equal(missing.stderr.length, 1);
  assert.match(missing.stderr[0] as string, /discovery/);

  const malformedDir = tempDir('wax-control-cli-bad-daemon-');
  writeFileSync(join(malformedDir, 'server.json'), '{');
  const malformed = await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
    daemonDir: malformedDir,
  });
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stdout.length, 0);
  assert.equal(malformed.stderr.length, 1);

  const secret = 'TOKEN_MARKER_4f1a';
  const daemonDir = tempDir('wax-control-cli-network-');
  const tokenPath = join(daemonDir, 'token');
  writeFileSync(tokenPath, `${secret}\n`);
  const port = await freePort();
  writeFileSync(
    join(daemonDir, 'server.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${String(port)}`,
      host: '127.0.0.1',
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      tokenPath,
    }),
  );
  const network = await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
    daemonDir,
  });
  assert.equal(network.code, 1);
  assert.equal(network.stdout.length, 0);
  assert.equal(network.stderr.length, 1);
  assert.match(network.stderr[0] as string, /network/);
  assertNoSecret(network.stderr, secret);
});

test('trigger usage errors exit 2 and a failed trigger is attempted exactly once', async (t) => {
  const noArguments = await invokeControl(runTriggerCli, ['trigger']);
  assert.equal(noArguments.code, 2);
  assert.equal(noArguments.stdout.length, 0);
  assert.equal(noArguments.stderr.length, 1);

  const oneArgument = await invokeControl(runTriggerCli, ['trigger', 'only']);
  assert.equal(oneArgument.code, 2);
  assert.equal(oneArgument.stdout.length, 0);
  assert.equal(oneArgument.stderr.length, 1);

  const daemon = await startWaxd(t);
  const composition = tempJson(foragerComposition('trigger-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-trigger-project-');
  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0);

  let calls = 0;
  const countingFetch: typeof fetch = (input, init) => {
    calls += 1;
    return globalThis.fetch(input, init);
  };
  const failed = await invokeControl(
    runTriggerCli,
    ['trigger', 'trigger-graph', 'missing-node', '--json'],
    { daemonDir: daemon.daemonDir, fetchImpl: countingFetch },
  );
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout.length, 0);
  assert.equal(failed.stderr.length, 1);
  assert.equal(calls, 1);

  const triggered = await invokeControl(
    runTriggerCli,
    ['trigger', 'trigger-graph', 'only', '--input', 'once', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(triggered.code, 0);
  assert.equal(daemon.adapter.prompts.length, 1);
});

test('graph load --manifest keeps its own project id, relative paths and idle ttl', async (t) => {
  const daemon = await startWaxd(t);
  const fixture = manifestFixture({
    graphId: 'manifest-graph',
    projectId: 'manifest-project-not-the-basename',
    idleTtlMs: 1_234,
  });

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', '--manifest', fixture.manifestPath, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const loaded = singleJson(load);
  assert.equal(loaded['graphId'], 'manifest-graph');
  assert.equal(loaded['rest'], true);
  assert.equal(asRecord(loaded['residency'])['idleTtlMs'], 1_234);

  // The server received the manifest's project id, not a basename of the dir.
  const sessionsPath = join(daemon.daemonDir, 'sessions.json');
  const sessions = JSON.parse(
    readFileSync(sessionsPath, 'utf8'),
  ) as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.['projectId'], 'manifest-project-not-the-basename');
  assert.equal(sessions[0]?.['projectDirectory'], resolve(fixture.project));

  // A second load is the existing 409 conflict, not a second session.
  const duplicate = await invokeControl(
    runGraphCli,
    ['graph', 'load', '--manifest', fixture.manifestPath, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.stdout.length, 0);
  assert.equal(duplicate.stderr.length, 1);
  assert.match(duplicate.stderr[0] as string, /conflict|409/);
  assert.equal(daemon.adapter.displayNames.length, 1);
});

test('graph load --manifest rejects conflicting flags and bad manifests before any session', async (t) => {
  const daemon = await startWaxd(t);
  const fixture = manifestFixture();
  const bindings = tempJson(freshBindings());
  const base = fixture.manifest;

  const usageCases: (readonly string[])[] = [
    // --manifest is mutually exclusive with a positional composition file.
    ['graph', 'load', fixture.composition, '--manifest', fixture.manifestPath, '--json'],
    // The manifest owns project, bindings and idle ttl.
    ['graph', 'load', '--manifest', fixture.manifestPath, '--project', fixture.project, '--json'],
    ['graph', 'load', '--manifest', fixture.manifestPath, '--bindings', bindings, '--json'],
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--idle-ttl-ms',
      '5',
      '--json',
    ],
    // Explicit harness must agree with the manifest.
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--harness',
      'dsh',
      '--json',
    ],
  ];

  for (const args of usageCases) {
    const invocation = await invokeControl(runGraphCli, args, {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(
      daemon.adapter.displayNames.length,
      0,
      `rejected load created a session: ${args.join(' ')}`,
    );
    assert.equal(invocation.code, 2, invocation.stderr.join(' | '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
  }

  const badManifests = [
    writeManifestVariant(fixture.root, 'bad-version.wax.json', {
      ...base,
      schemaVersion: 2,
    }),
    writeManifestVariant(fixture.root, 'unknown-field.wax.json', {
      ...base,
      typoField: true,
    }),
    writeManifestVariant(fixture.root, 'missing-composition.wax.json', {
      ...base,
      composition: 'missing.json',
    }),
    writeManifestVariant(fixture.root, 'bad-idle.wax.json', {
      ...base,
      idleTtlMs: -5,
    }),
    writeManifestVariant(fixture.root, 'broken.wax.json', '{"schemaVersion": 1,'),
    join(fixture.root, 'absent.wax.json'),
  ];

  for (const manifestPath of badManifests) {
    const invocation = await invokeControl(
      runGraphCli,
      ['graph', 'load', '--manifest', manifestPath, '--json'],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(
      daemon.adapter.displayNames.length,
      0,
      `bad manifest created a session: ${manifestPath}`,
    );
    assert.equal(invocation.code, 2, invocation.stderr.join(' | '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
  }

  // None of the rejected commands reached /graphs/load.
  assert.equal(daemon.adapter.displayNames.length, 0);
  assert.equal(existsSync(join(daemon.daemonDir, 'sessions.json')), false);

  // The same daemon still accepts a valid manifest load.
  const valid = await invokeControl(
    runGraphCli,
    ['graph', 'load', '--manifest', fixture.manifestPath, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(valid.code, 0, valid.stderr.join(' | '));
  assert.equal(daemon.adapter.displayNames.length, 1);
});

test('graph load --manifest accepts a matching --harness and stays on that daemon', async (t) => {
  const daemon = await startMultiWaxd(t);
  const fixture = manifestFixture({ graphId: 'manifest-codex', harness: 'codex' });

  const load = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--harness',
      'codex',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(load)['graphId'], 'manifest-codex');
  assert.equal(daemon.adapters.get('codex')?.displayNames.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.displayNames.length, 0);

  const mismatch = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--harness',
      'dsh',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(mismatch.code, 2);
  assert.equal(mismatch.stdout.length, 0);
  assert.equal(mismatch.stderr.length, 1);
  assert.match(mismatch.stderr[0] as string, /harness/);
  assert.equal(daemon.adapters.get('codex')?.displayNames.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.displayNames.length, 0);
});

test('runCli dispatches graph, trigger and waxd without changing wax run', async (t) => {
  const daemon = await startWaxd(t);

  const graphStdout: string[] = [];
  const graphStderr: string[] = [];
  const graphCode = await runCli(
    ['graph', 'list', '--json', '--daemon-dir', daemon.daemonDir],
    {
      stdout: (line) => graphStdout.push(line),
      stderr: (line) => graphStderr.push(line),
      env: {},
    },
  );
  assert.equal(graphCode, 0);
  assert.equal(graphStderr.length, 0);
  assert.equal(graphStdout.length, 1);
  assert.equal(Array.isArray(JSON.parse(graphStdout[0] as string)['status']), true);

  const triggerStderr: string[] = [];
  const triggerCode = await runCli(
    ['trigger', 'missing-graph', 'node', '--daemon-dir', daemon.daemonDir],
    {
      stdout: () => undefined,
      stderr: (line) => triggerStderr.push(line),
      env: {},
    },
  );
  assert.equal(triggerCode, 1);
  assert.equal(triggerStderr.length, 1);

  const waxdStdout: string[] = [];
  const waxdStderr: string[] = [];
  const waxdCode = await runCli(['waxd', '--harness', 'bogus'], {
    stdout: (line) => waxdStdout.push(line),
    stderr: (line) => waxdStderr.push(line),
    env: {},
  });
  assert.equal(waxdCode, 2);
  assert.equal(waxdStdout.length, 0);
  assert.equal(waxdStderr.length, 1);
  assert.equal((waxdStderr[0] as string).includes('usage: wax run'), false);

  const runStdout: string[] = [];
  const runStderr: string[] = [];
  const runCode = await runCli(['run'], {
    stdout: (line) => runStdout.push(line),
    stderr: (line) => runStderr.push(line),
    env: {},
  });
  assert.equal(runCode, 2);
  assert.equal(runStdout.length, 0);
  assert.equal(runStderr.length, 1);
  assert.match(runStderr[0] as string, /wax run/);
});
