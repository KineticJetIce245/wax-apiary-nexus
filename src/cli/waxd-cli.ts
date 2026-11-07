import { join, resolve } from 'node:path';

import type { HarnessAdapter } from '../adapters/harness.js';
import type { ControlServerInfo } from '../control/server.js';
import { ControlServer } from '../control/server.js';
import type { HarnessKind } from '../session/connection.js';
import { SessionRegistry } from '../session/session-registry.js';
import { Workspace } from '../session/workspace.js';
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
}

/** One harness keeps the original `<root>` layout. */
export interface WaxdSingleCommand extends WaxdCommonCommand {
  readonly harness: HarnessKind;
}

/** Two or more harnesses each get `<root>/<harness>`. */
export interface WaxdMultiCommand extends WaxdCommonCommand {
  readonly harnesses: readonly HarnessKind[];
}

export type WaxdCommand = WaxdSingleCommand | WaxdMultiCommand;

/** Metadata handed to `deps.onStarted`; it never contains the token value. */
export interface WaxdStartedInfo {
  readonly url: string;
  readonly harness: HarnessKind;
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
  /** Tests can stop the foreground daemon without sending a process signal. */
  readonly signal?: AbortSignal;
  /** Default true; tests inject `signal` and disable this. */
  readonly installSignalHandlers?: boolean;
  /** Tests wait on this; production output is the five stdout lines per harness. */
  readonly onStarted?: (info: WaxdStartedInfo) => void;
}

const WAXD_USAGE =
  'usage: waxd (--harness <codex|dsh> | --harnesses <codex,dsh>) ' +
  '[--codex-exe <path>] [--dsh-root <path>] [--state-root <dir>] ' +
  '[--apiary <id>] [--daemon-dir <dir>] [--port <n>]';

const WAXD_VALUE_FLAGS = new Set([
  '--harness',
  '--harnesses',
  '--codex-exe',
  '--dsh-root',
  '--state-root',
  '--apiary',
  '--daemon-dir',
  '--port',
]);

const DEFAULT_STATE_ROOT = '~/.wax';
const DEFAULT_DAEMON_DIR = '~/.wax/waxd';
const DEFAULT_APIARY = 'default';

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
    harness: selection.harness,
    ...(selection.codexExe === undefined ? {} : { codexExe: selection.codexExe }),
    ...(selection.dshRoot === undefined ? {} : { dshRoot: selection.dshRoot }),
    stateRoot,
    apiary,
    daemonDir,
    port,
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

interface HarnessPlan {
  readonly harness: HarnessKind;
  /** `<root>` for a single harness, `<root>/<harness>` for a multi-harness run. */
  readonly daemonDir: string;
  /** `<stateRoot>` for a single harness, `<stateRoot>/<harness>` for a multi run. */
  readonly stateRoot: string;
  readonly codexExe?: string;
  readonly dshRoot?: string;
}

function harnessPlans(command: WaxdCommand): readonly HarnessPlan[] {
  const harnesses = 'harnesses' in command ? command.harnesses : [command.harness];
  const multi = harnesses.length > 1;
  return harnesses.map((harness) => ({
    harness,
    daemonDir: multi ? join(command.daemonDir, harness) : command.daemonDir,
    // Honey (field, scheduler and graph log) lives under the state root.
    // Multi-harness runs give each harness its own subtree so two graphs with
    // the same composition id can never share those files. The `~` is left in
    // place; ControlServer and HoneyStore expand it.
    stateRoot: multi ? join(command.stateRoot, harness) : command.stateRoot,
    ...(harness === 'codex' && command.codexExe !== undefined
      ? { codexExe: command.codexExe }
      : {}),
    ...(harness === 'dsh' && command.dshRoot !== undefined
      ? { dshRoot: command.dshRoot }
      : {}),
  }));
}

interface RunningHarness {
  readonly plan: HarnessPlan;
  readonly workspace: Workspace;
  readonly server: ControlServer;
  readonly info: ControlServerInfo;
}

/**
 * Start one harness. The adapter, workspace/session registry and control
 * server are independent per harness, so a failure here only has to unwind
 * this harness's own partial state; already-running harnesses are unwound by
 * the caller.
 */
async function startHarness(
  plan: HarnessPlan,
  command: WaxdCommand,
  deps: WaxdDependencies,
): Promise<RunningHarness> {
  const createAdapter = deps.createAdapter ?? createDefaultAdapter;
  const request: AdapterRequest = {
    harness: plan.harness,
    ...(plan.codexExe === undefined ? {} : { executable: plan.codexExe }),
    ...(plan.dshRoot === undefined ? {} : { dshRoot: plan.dshRoot }),
  };

  let adapter: HarnessAdapter | undefined;
  let workspace: Workspace | undefined;
  let server: ControlServer | undefined;

  try {
    adapter = await createAdapter(request);
    await adapter.start();

    workspace = new Workspace(adapter);
    // Resolve the daemon directory exactly like ControlServer does so the
    // session store and the daemon's own files live side by side even when the
    // flag contains `~`. Construction loads and validates the store; a corrupt
    // file fails here, before ControlServer.start creates a token or lock.
    const daemonDirectory = resolve(expandHomePath(plan.daemonDir));
    const sessionStore = new ConversationStore(join(daemonDirectory, 'sessions.json'));
    const registry = new SessionRegistry({
      workspace,
      harness: plan.harness,
      store: sessionStore,
    });
    server = new ControlServer({
      workspace,
      registry,
      harness: plan.harness,
      stateRoot: plan.stateRoot,
      apiary: command.apiary,
      daemonDir: plan.daemonDir,
      port: command.port,
    });

    const info = await server.start();
    return { plan, workspace, server, info };
  } catch (error) {
    await server?.stop().catch(() => undefined);
    if (workspace !== undefined) {
      await workspace.stop().catch(() => undefined);
    } else if (adapter !== undefined) {
      // adapter.start() may have failed after reserving resources.
      await adapter.stop().catch(() => undefined);
    }
    throw error;
  }
}

/** Best-effort rollback: every server, then every workspace, always reversed. */
async function unwindHarnesses(running: readonly RunningHarness[]): Promise<void> {
  const reverse = [...running].reverse();
  for (const item of reverse) {
    await item.server.stop().catch(() => undefined);
  }
  for (const item of reverse) {
    await item.workspace.stop().catch(() => undefined);
  }
}

/** Graceful stop: report each failure but keep cleaning up everything else. */
async function stopHarnesses(
  running: readonly RunningHarness[],
  err: (line: string) => void,
  multi: boolean,
): Promise<number> {
  const reverse = [...running].reverse();
  let code = 0;

  for (const item of reverse) {
    try {
      await item.server.stop();
    } catch (error) {
      err(harnessErrorLine(item.plan.harness, error, multi));
      code = 1;
    }
  }
  for (const item of reverse) {
    try {
      await item.workspace.stop();
    } catch (error) {
      err(harnessErrorLine(item.plan.harness, error, multi));
      code = 1;
    }
  }
  return code;
}

function harnessErrorLine(
  harness: HarnessKind,
  error: unknown,
  multi: boolean,
): string {
  const prefix = multi ? `harness ${harness}: ` : '';
  return `error: ${prefix}${oneLine(messageOf(error))}`;
}

function printHarness(
  out: (line: string) => void,
  running: RunningHarness,
  multi: boolean,
): void {
  if (multi) {
    out(`harness ${running.plan.harness}`);
  }
  out(`waxd listening ${running.info.url}`);
  out(`harness  ${running.plan.harness}`);
  out(`state    ${running.plan.stateRoot}`);
  out(`daemon   ${running.plan.daemonDir}`);
  out(`token    ${running.info.tokenPath}`);
}

/**
 * Foreground daemon for one or more harnesses.
 *
 * Each harness owns its adapter, Workspace, SessionRegistry, ControlServer,
 * token, lock and port. A single harness keeps the original `<root>` layout;
 * multiple harnesses use `<root>/<harness>` so their daemon files never
 * collide. Startup is ordered; any failure unwinds every harness that had
 * already started. Signal handling stops servers in reverse start order and
 * then workspaces in reverse start order, continuing after individual errors.
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

  const plans = harnessPlans(command);
  const multi = plans.length > 1;

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

  const running: RunningHarness[] = [];
  try {
    for (const plan of plans) {
      try {
        running.push(await startHarness(plan, command, deps));
      } catch (error) {
        // The failing harness cleaned its own partial state inside
        // startHarness; this only unwinds earlier harnesses.
        await unwindHarnesses(running);
        err(harnessErrorLine(plan.harness, error, multi));
        return 1;
      }
    }

    // Print only after every harness is up, so a startup failure never leaves
    // a misleading "listening" block behind.
    for (const item of running) {
      printHarness(out, item, multi);
    }
    for (const item of running) {
      deps.onStarted?.({
        url: item.info.url,
        harness: item.plan.harness,
        stateRoot: item.plan.stateRoot,
        daemonDir: item.plan.daemonDir,
        tokenPath: item.info.tokenPath,
      });
    }

    await waitForAbort(controller.signal);
    return await stopHarnesses(running, err, multi);
  } catch (error) {
    // A failure in output or an onStarted callback still tears down every
    // harness that had started.
    await unwindHarnesses(running);
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
