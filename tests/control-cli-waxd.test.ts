import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runCli } from '../src/cli/cli.js';
import { runLiveCli } from '../src/cli/live-cli.js';
import { CliUsageError } from '../src/cli/cli-shared.js';
import {
  runSessionCli,
  type ControlCliDependencies,
} from '../src/cli/control-cli.js';
import {
  parseWaxdArgs,
  runWaxdCli,
  type WaxdStartedInfo,
} from '../src/cli/waxd-cli.js';
import { ControlClient, discoverDaemon } from '../src/control/client.js';
import type { HarnessKind } from '../src/session/connection.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';
import {
  TrackingFakeAdapter,
  foragerComposition,
  parkedComposition,
  userForagerComposition,
  freshBindings,
  tempDir,
  tempJson,
  tempRaw,
  manifestFixture,
  writeManifestVariant,
  invokeControl,
  singleJson,
  asRecord,
  assertUsage,
  assertNoSecret,
  freePort,
  deferred,
  withTimeout,
} from './support/control-cli-fixtures.js';
import { startWaxd, startMultiWaxd } from './support/control-cli-daemons.js';

class FailingStartAdapter extends TrackingFakeAdapter {
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
test('parseWaxdArgs applies defaults and rejects usage errors', () => {
  assert.deepEqual(parseWaxdArgs(['--harness', 'codex']), {
    harnesses: ['codex'],
    stateRoot: '~/.wax',
    apiary: 'default',
    daemonDir: '~/.wax/waxd',
    port: 0,
    sessionTtlMs: 7_200_000,
    sessionSweepIntervalMs: 60_000,
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
  assert.deepEqual(codex.harnesses, ['codex']);
  assert.equal(codex.codexExe, 'C:/codex.exe');
  assert.equal(codex.stateRoot, 'C:/state');
  assert.equal(codex.apiary, 'demo');
  assert.equal(codex.daemonDir, 'C:/daemon');
  assert.equal(codex.port, 4321);
  assert.equal(codex.sessionTtlMs, 7_200_000);
  assert.equal(codex.sessionSweepIntervalMs, 60_000);

  const customSession = parseWaxdArgs([
    '--harness',
    'codex',
    '--session-ttl-ms',
    '500',
    '--session-sweep-interval-ms',
    '25',
  ]);
  assert.equal(customSession.sessionTtlMs, 500);
  assert.equal(customSession.sessionSweepIntervalMs, 25);

  // TTL 0 disables automatic cleanup; a 0 interval is then irrelevant but valid.
  const disabled = parseWaxdArgs([
    '--harness',
    'codex',
    '--session-ttl-ms',
    '0',
    '--session-sweep-interval-ms',
    '0',
  ]);
  assert.equal(disabled.sessionTtlMs, 0);
  assert.equal(disabled.sessionSweepIntervalMs, 0);

  const dsh = parseWaxdArgs(['--harness', 'dsh', '--dsh-root', 'C:/dsh']);
  assert.deepEqual(dsh.harnesses, ['dsh']);
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
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--session-ttl-ms', '-1']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--session-ttl-ms', '1.5']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--session-ttl-ms', 'abc']));
  assertUsage(() => parseWaxdArgs(['--harness', 'codex', '--session-sweep-interval-ms', '-1']));
  // A positive TTL requires a positive sweep interval.
  assertUsage(() =>
    parseWaxdArgs(['--harness', 'codex', '--session-ttl-ms', '1000', '--session-sweep-interval-ms', '0']),
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
  assert.equal(multi.sessionTtlMs, 7_200_000);
  assert.equal(multi.sessionSweepIntervalMs, 60_000);

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
  assert.deepEqual(daemon.started.harnesses, ['codex']);
  assert.equal(daemon.stdout[1], 'harnesses codex');
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
  assert.deepEqual(health['harnesses'], ['codex']);
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
  assert.match(stderr[0] as string, /no harness available/);
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

test('runWaxdCli serves two harnesses from one daemon and endpoint and stops both once', async (t) => {
  const stopOrder: HarnessKind[] = [];
  const daemon = await startMultiWaxd(t, {
    createAdapter: (harness) => new OrderedStopAdapter(stopOrder, harness),
  });
  const info = daemon.started;

  assert.deepEqual(info.harnesses, ['codex', 'dsh']);
  assert.equal(info.stateRoot, daemon.stateRoot);
  assert.equal(info.daemonDir, daemon.daemonDir);
  assert.equal(existsSync(join(daemon.daemonDir, 'token')), true);
  assert.equal(existsSync(join(daemon.daemonDir, 'server.json')), true);
  assert.equal(existsSync(join(daemon.daemonDir, 'daemon.lock')), true);
  assert.equal(existsSync(join(daemon.daemonDir, 'sessions.json')), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'codex')), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'dsh')), false);

  const discovery = discoverDaemon({ daemonDir: daemon.daemonDir });
  const token = readFileSync(info.tokenPath, 'utf8').trim();
  assert.equal(token, discovery.token);
  const client = new ControlClient({ baseUrl: discovery.baseUrl, token: discovery.token });
  const health = await client.health();
  assert.equal(health['ok'], true);
  assert.deepEqual(health['harnesses'], ['codex', 'dsh']);
  assert.equal(health['pid'], process.pid);

  assert.deepEqual(daemon.stdout, [
    `waxd listening ${info.url}`,
    'harnesses codex,dsh',
    `state    ${info.stateRoot}`,
    `daemon   ${info.daemonDir}`,
    `token    ${info.tokenPath}`,
  ]);
  assertNoSecret(daemon.stdout, token);
  assert.equal(daemon.stderr.length, 0);

  const code = await daemon.stop();
  assert.equal(code, 0);
  assert.equal(daemon.stderr.length, 0);
  // AdapterPool stops in reverse start order; one endpoint, one stop each.
  assert.deepEqual(stopOrder, ['dsh', 'codex']);
  assert.equal(daemon.adapters.get('codex')?.stopCalls, 1);
  assert.equal(daemon.adapters.get('dsh')?.stopCalls, 1);
  assert.equal(existsSync(info.tokenPath), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'server.json')), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'daemon.lock')), false);
  await assert.rejects(fetch(`${info.url}/health`, { signal: AbortSignal.timeout(2_000) }));
});

test('one failed adapter does not block the daemon; health lists only available harnesses', async (t) => {
  const daemon = await startMultiWaxd(t, {
    createAdapter: (harness) =>
      harness === 'dsh' ? new FailingStartAdapter() : new TrackingFakeAdapter(),
  });

  assert.deepEqual(daemon.started.harnesses, ['codex']);
  assert.equal(daemon.stderr.length, 0);
  const discovery = discoverDaemon({ daemonDir: daemon.daemonDir });
  const client = new ControlClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
  });
  assert.deepEqual((await client.health())['harnesses'], ['codex']);
  assert.equal(daemon.adapters.get('codex')?.startCalls, 1);
  assert.equal(daemon.adapters.get('dsh')?.startCalls, 1);
  assert.equal(daemon.adapters.get('dsh')?.stopCalls, 1);
  assert.equal(existsSync(join(daemon.daemonDir, 'token')), true);

  assert.equal(await daemon.stop(), 0);
  assert.equal(existsSync(join(daemon.daemonDir, 'token')), false);
});

test('a stop failure still releases the other adapter and the only endpoint', async (t) => {
  const daemon = await startMultiWaxd(t, {
    createAdapter: (harness) =>
      harness === 'dsh' ? new FailingStopAdapter() : new TrackingFakeAdapter(),
  });
  const info = daemon.started;

  assert.equal(await daemon.stop(), 1);
  assert.equal(daemon.stderr.length, 1);
  assert.equal(daemon.stderr[0], 'error: adapter stop failed');
  assert.equal(daemon.adapters.get('codex')?.stopCalls, 1);
  assert.equal(daemon.adapters.get('dsh')?.stopCalls, 1);
  assert.equal(existsSync(info.tokenPath), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'server.json')), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'daemon.lock')), false);
  await assert.rejects(fetch(`${info.url}/health`, { signal: AbortSignal.timeout(2_000) }));
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

test('daemon discovery and network failures exit 1 without printing a token', async () => {
  const missingDir = join(tempDir('wax-control-cli-missing-daemon-'), 'waxd');
  const missing = await invokeControl(runLiveCli, ['live', 'list', '--json'], {
    daemonDir: missingDir,
  });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout.length, 0);
  assert.equal(missing.stderr.length, 1);
  assert.match(missing.stderr[0] as string, /discovery/);

  const malformedDir = tempDir('wax-control-cli-bad-daemon-');
  writeFileSync(join(malformedDir, 'server.json'), '{');
  const malformed = await invokeControl(runLiveCli, ['live', 'list', '--json'], {
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
  const network = await invokeControl(runLiveCli, ['live', 'list', '--json'], {
    daemonDir,
  });
  assert.equal(network.code, 1);
  assert.equal(network.stdout.length, 0);
  assert.equal(network.stderr.length, 1);
  assert.match(network.stderr[0] as string, /network/);
  assertNoSecret(network.stderr, secret);
});

test('runCli dispatches live, wake, session and waxd', async (t) => {
  const daemon = await startWaxd(t);

  const liveStdout: string[] = [];
  const liveStderr: string[] = [];
  const liveCode = await runCli(
    ['live', 'list', '--json', '--daemon-dir', daemon.daemonDir],
    {
      stdout: (line) => liveStdout.push(line),
      stderr: (line) => liveStderr.push(line),
      env: {},
    },
  );
  assert.equal(liveCode, 0);
  assert.equal(liveStderr.length, 0);
  assert.equal(liveStdout.length, 1);
  assert.equal(Array.isArray(JSON.parse(liveStdout[0] as string)['lives']), true);

  const sessionStdout: string[] = [];
  const sessionStderr: string[] = [];
  const sessionCode = await runCli(
    ['session', 'list', '--json', '--daemon-dir', daemon.daemonDir],
    {
      stdout: (line) => sessionStdout.push(line),
      stderr: (line) => sessionStderr.push(line),
      env: {},
    },
  );
  assert.equal(sessionCode, 0);
  assert.equal(sessionStderr.length, 0);
  assert.equal(sessionStdout.length, 1);
  assert.deepEqual(JSON.parse(sessionStdout[0] as string)['sessions'], []);

  const triggerStderr: string[] = [];
  const triggerCode = await runCli(
    ['wake', 'missing-live', 'node', '--daemon-dir', daemon.daemonDir],
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
