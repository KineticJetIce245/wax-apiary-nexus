import { basename, join, resolve } from 'node:path';

import type { HarnessAdapter } from '../adapters/harness.js';
import type { ControlServerInfo } from '../control/server.js';
import { ControlServer } from '../control/server.js';
import { LiveHiveCatalog } from '../daemon/live-hive-catalog.js';
import { GraphBindingStore } from '../graph/binding-store.js';
import { AdapterPool } from '../session/adapter-pool.js';
import type { HarnessKind } from '../session/connection.js';
import { SessionRegistry } from '../session/session-registry.js';
import { ConversationStore, expandHomePath } from '../storage/conversation-store.js';
import {
  CliUsageError,
  createDefaultAdapter,
  messageOf,
  selectHarness,
  type AdapterRequest,
} from './cli-shared.js';
import { parseCliTokens } from './control-cli.js';

interface WaxdCommonCommand {
  readonly codexExe?: string;
  readonly dshRoot?: string;
  /** WAX state root; `~` is expanded by the storage layer. */
  readonly stateRoot: string;
  readonly apiary: string;
  readonly daemonDir: string;
  /** 0 lets the operating system choose a loopback port. */
  readonly port: number;
  /** Idle TTL for sessions; 0 disables automatic session cleanup. */
  readonly sessionTtlMs: number;
  /** Sweep period; only used when `sessionTtlMs > 0`. */
  readonly sessionSweepIntervalMs: number;
}

/** One daemon serving one or more harnesses from one state root. */
export interface WaxdCommand extends WaxdCommonCommand {
  readonly harnesses: readonly HarnessKind[];
}

/** Metadata handed to `deps.onStarted`; it never contains the token value. */
export interface WaxdStartedInfo {
  readonly url: string;
  /** Harnesses that started successfully, in configured order. */
  readonly harnesses: readonly HarnessKind[];
  readonly stateRoot: string;
  readonly daemonDir: string;
  readonly tokenPath: string;
}

export interface WaxdDependencies {
  /** Test seam: replace the native adapter factory. */
  readonly createAdapter?: (request: AdapterRequest) => Promise<HarnessAdapter>;
  /** Test seam: environment used to resolve DSH_ROOT. */
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Test seam: receives the control server's metadata-only request log. */
  readonly logger?: (line: string) => void;
  /** Tests can stop the foreground daemon without sending a process signal. */
  readonly signal?: AbortSignal;
  /** Default true; tests inject `signal` and disable this. */
  readonly installSignalHandlers?: boolean;
  /** Tests wait on this; production output is the five stdout lines. */
  readonly onStarted?: (info: WaxdStartedInfo) => void;
}

const WAXD_USAGE =
  'usage: waxd (--harness <codex|dsh> | --harnesses <codex,dsh>) ' +
  '[--codex-exe <path>] [--dsh-root <path>] [--state-root <dir>] ' +
  '[--apiary <id>] [--daemon-dir <dir>] [--port <n>] ' +
  '[--session-ttl-ms <n>] [--session-sweep-interval-ms <n>]';

const WAXD_VALUE_FLAGS = new Set([
  '--harness',
  '--harnesses',
  '--codex-exe',
  '--dsh-root',
  '--state-root',
  '--apiary',
  '--daemon-dir',
  '--port',
  '--session-ttl-ms',
  '--session-sweep-interval-ms',
]);

const DEFAULT_STATE_ROOT = '~/.wax';
const DEFAULT_DAEMON_DIR = '~/.wax/waxd';
const DEFAULT_APIARY = 'default';
/** Two hours, matching the daemon's idle-session cleanup policy. */
const DEFAULT_SESSION_TTL_MS = 7_200_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;

export function parseWaxdArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WaxdCommand {
  // The package entry point receives only the options, while the `wax waxd`
  // dispatch passes the command word as argv[0]. Accept both forms without
  // changing either entry point.
  const tokens = argv[0] === 'waxd' ? argv.slice(1) : argv;
  const parsed = parseCliTokens(tokens, WAXD_VALUE_FLAGS, { allowJson: false });
  if (parsed.positionals.length !== 0) {
    throw new CliUsageError('expected no positional arguments after "waxd"');
  }

  const rawHarness = parsed.flags.get('--harness');
  const rawHarnesses = parsed.flags.get('--harnesses');
  if (rawHarness !== undefined && rawHarnesses !== undefined) {
    throw new CliUsageError('--harness and --harnesses cannot be used together');
  }
  if (rawHarness === undefined && rawHarnesses === undefined) {
    throw new CliUsageError('one of --harness or --harnesses is required');
  }

  const dshRootFlag = parsed.flags.get('--dsh-root');
  const codexExe = parsed.flags.get('--codex-exe');
  const rawPort = parsed.flags.get('--port');
  const stateRoot = parsed.flags.get('--state-root') ?? DEFAULT_STATE_ROOT;
  const apiary = parsed.flags.get('--apiary') ?? DEFAULT_APIARY;
  const daemonDir = parsed.flags.get('--daemon-dir') ?? DEFAULT_DAEMON_DIR;
  const port = rawPort === undefined ? 0 : parsePort(rawPort);
  const rawSessionTtlMs = parsed.flags.get('--session-ttl-ms');
  const rawSessionSweepIntervalMs = parsed.flags.get('--session-sweep-interval-ms');
  const sessionTtlMs =
    rawSessionTtlMs === undefined
      ? DEFAULT_SESSION_TTL_MS
      : parseNonNegativeInteger(rawSessionTtlMs, '--session-ttl-ms');
  const sessionSweepIntervalMs =
    rawSessionSweepIntervalMs === undefined
      ? DEFAULT_SESSION_SWEEP_INTERVAL_MS
      : parseNonNegativeInteger(rawSessionSweepIntervalMs, '--session-sweep-interval-ms');
  if (sessionTtlMs > 0 && sessionSweepIntervalMs === 0) {
    throw new CliUsageError(
      '--session-sweep-interval-ms must be positive when --session-ttl-ms is enabled',
    );
  }
  const sessionOptions = { sessionTtlMs, sessionSweepIntervalMs };

  if (rawHarnesses !== undefined) {
    const harnesses = parseHarnessList(rawHarnesses);
    if (codexExe !== undefined && !harnesses.includes('codex')) {
      throw new CliUsageError('--codex-exe only applies when --harnesses includes codex');
    }
    if (dshRootFlag !== undefined && !harnesses.includes('dsh')) {
      throw new CliUsageError('--dsh-root only applies when --harnesses includes dsh');
    }

    let dshRoot: string | undefined;
    if (harnesses.includes('dsh')) {
      dshRoot = dshRootFlag ?? env.DSH_ROOT;
      if (dshRoot === undefined || dshRoot === '') {
        throw new CliUsageError(
          '--harnesses with dsh requires --dsh-root <path> or DSH_ROOT',
        );
      }
    }

    return {
      harnesses,
      ...(codexExe === undefined ? {} : { codexExe }),
      ...(dshRoot === undefined ? {} : { dshRoot }),
      stateRoot,
      apiary,
      daemonDir,
      port,
      ...sessionOptions,
    };
  }

  const selection = selectHarness(
    rawHarness,
    {
      ...(dshRootFlag === undefined ? {} : { dshRoot: dshRootFlag }),
      ...(codexExe === undefined ? {} : { codexExe }),
    },
    env,
  );

  return {
    harnesses: [selection.harness],
    ...(selection.codexExe === undefined ? {} : { codexExe: selection.codexExe }),
    ...(selection.dshRoot === undefined ? {} : { dshRoot: selection.dshRoot }),
    stateRoot,
    apiary,
    daemonDir,
    port,
    ...sessionOptions,
  };
}

function parseHarnessList(raw: string): readonly HarnessKind[] {
  const harnesses: HarnessKind[] = [];
  const seen = new Set<HarnessKind>();
  for (const entry of raw.split(',')) {
    if (entry === '') {
      throw new CliUsageError('--harnesses must not contain an empty entry');
    }
    if (entry !== 'codex' && entry !== 'dsh') {
      throw new CliUsageError(`--harnesses contains unknown harness '${entry}'`);
    }
    if (seen.has(entry)) {
      throw new CliUsageError(`--harnesses lists '${entry}' more than once`);
    }
    seen.add(entry);
    harnesses.push(entry);
  }
  return harnesses;
}

function parsePort(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliUsageError('--port must be an integer between 0 and 65535');
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new CliUsageError('--port must be an integer between 0 and 65535');
  }
  return port;
}

function parseNonNegativeInteger(raw: string, flag: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliUsageError(`${flag} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliUsageError(`${flag} must be a non-negative integer`);
  }
  return value;
}

function adapterRequest(
  harness: HarnessKind,
  command: WaxdCommand,
): AdapterRequest {
  return {
    harness,
    ...(harness === 'codex' && command.codexExe !== undefined
      ? { executable: command.codexExe }
      : {}),
    ...(harness === 'dsh' && command.dshRoot !== undefined
      ? { dshRoot: command.dshRoot }
      : {}),
  };
}

/**
 * Foreground daemon for one or more harnesses.
 *
 * There is exactly one AdapterPool, SessionRegistry, LiveHiveHost, ControlServer,
 * daemon directory, state root, token and endpoint. A harness whose adapter
 * fails is marked unavailable by the pool; the daemon starts if at least one
 * harness is available. Stop releases the server/host and then the pool once.
 */
export async function runWaxdCli(
  argv: readonly string[],
  deps: WaxdDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let command: WaxdCommand;
  try {
    command = parseWaxdArgs(argv, deps.env);
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    throw error;
  }

  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (deps.signal !== undefined) {
    if (deps.signal.aborted) {
      controller.abort();
    } else {
      deps.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  if (deps.installSignalHandlers !== false) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  const createAdapter = deps.createAdapter ?? createDefaultAdapter;
  const pool = new AdapterPool({
    createAdapter: (harness) => createAdapter(adapterRequest(harness as HarnessKind, command)),
  });
  let server: ControlServer | undefined;
  let runningHarnesses: readonly HarnessKind[] = [];

  const stopAll = async (): Promise<number> => {
    let code = 0;
    if (server !== undefined) {
      const current = server;
      server = undefined;
      try {
        await current.stop();
      } catch (error) {
        err(`error: ${oneLine(messageOf(error))}`);
        code = 1;
      }
    }
    try {
      await pool.stop();
    } catch (error) {
      err(`error: ${oneLine(messageOf(error))}`);
      code = 1;
    }
    return code;
  };

  try {
    await pool.start(command.harnesses);
    runningHarnesses = pool.harnesses() as readonly HarnessKind[];
    if (runningHarnesses.length === 0) {
      await stopAll();
      err('error: no harness available');
      return 1;
    }

    const daemonDirectory = resolve(expandHomePath(command.daemonDir));
    const workspaces = new Map(
      runningHarnesses.map((harness) => [harness, pool.workspaceFor(harness)] as const),
    );
    const sessionStore = new ConversationStore(join(daemonDirectory, 'sessions.json'));
    const bindingStore = new GraphBindingStore(
      join(daemonDirectory, 'graph-bindings.json'),
    );
    const catalog = new LiveHiveCatalog(join(daemonDirectory, 'live-catalog.json'));
    const registry = new SessionRegistry({ workspaces, store: sessionStore });

    server = new ControlServer({
      registry,
      stateRoot: command.stateRoot,
      apiary: command.apiary,
      daemonDir: command.daemonDir,
      port: command.port,
      bindingStore,
      catalog,
      sessionIdleTtlMs: command.sessionTtlMs,
      sessionSweepIntervalMs: command.sessionSweepIntervalMs,
      liveProject: {
        id: basename(process.cwd()) || 'project',
        directory: process.cwd(),
      },
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });

    const info = await server.start();
    out(`waxd listening ${info.url}`);
    out(`harnesses ${runningHarnesses.join(',')}`);
    out(`state    ${command.stateRoot}`);
    out(`daemon   ${command.daemonDir}`);
    out(`token    ${info.tokenPath}`);
    deps.onStarted?.({
      url: info.url,
      harnesses: runningHarnesses,
      stateRoot: command.stateRoot,
      daemonDir: command.daemonDir,
      tokenPath: info.tokenPath,
    });

    await waitForAbort(controller.signal);
    return await stopAll();
  } catch (error) {
    await stopAll();
    err(`error: ${oneLine(messageOf(error))}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    deps.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolvePromise) => {
    signal.addEventListener('abort', () => resolvePromise(), { once: true });
  });
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}
