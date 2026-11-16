import type { TestContext } from 'node:test';
import { join } from 'node:path';

import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
import type { HarnessKind } from '../../src/session/connection.js';
import type { FakeAdapterOptions } from './fake-adapter.js';
import {
  TrackingFakeAdapter,
  deferred,
  tempDir,
  withTimeout,
} from './control-cli-fixtures.js';

export interface TestDaemon {
  readonly adapter: TrackingFakeAdapter;
  readonly stateRoot: string;
  readonly daemonDir: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly started: WaxdStartedInfo;
  stop(): Promise<number>;
}

export interface MultiTestDaemon {
  readonly adapters: ReadonlyMap<HarnessKind, TrackingFakeAdapter>;
  readonly stateRoot: string;
  readonly daemonDir: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly started: WaxdStartedInfo;
  stop(): Promise<number>;
}

export interface MultiWaxdOptions {
  readonly createAdapter?: (harness: HarnessKind) => TrackingFakeAdapter;
  readonly apiary?: string;
}

export async function startWaxd(
  t: TestContext,
  extraArgs: readonly string[] = [],
  adapterOptions: FakeAdapterOptions = {},
): Promise<TestDaemon> {
  const adapter = new TrackingFakeAdapter(adapterOptions);
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
      ...extraArgs,
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

export async function startMultiWaxd(
  t: TestContext,
  options: MultiWaxdOptions = {},
): Promise<MultiTestDaemon> {
  const adapters = new Map<HarnessKind, TrackingFakeAdapter>();
  const stateRoot = tempDir('wax-control-cli-multi-state-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const started = deferred<WaxdStartedInfo>();
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
      onStarted: (info) => started.resolve(info),
    },
  );
  run.catch(() => undefined);

  const startedInfo = await withTimeout(started.promise, 5_000, 'multi waxd start');
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
    started: startedInfo,
    stop,
  };
}
