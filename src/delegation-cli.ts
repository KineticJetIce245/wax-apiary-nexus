// Delegation CLI: one command enters a host session that already has the
// unified_delegate MCP tools, with the gateway and a worker session assembled
// around it. It composes existing pieces only; it does not change DSH, the
// gateway semantics, or the adapter contracts.
import { existsSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerAdapter } from './adapters/codex/adapter.js';
import { DshAcpAdapter } from './adapters/dsh-acp/adapter.js';
import type { HarnessAdapter } from './adapters/harness.js';
import { CollaborationGateway, type CollaborationGatewayInfo } from './collaboration-gateway.js';
import { createCodexConnection } from './connection.js';
import { createKernel } from './kernel.js';
import { createRenderState, renderTaggedEvent } from './workbench-renderer.js';
import { Workbench } from './workbench.js';

export type HarnessName = 'codex' | 'dsh';

export interface DelegationCliOptions {
  readonly projectDir: string;
  readonly host: HarnessName;
  readonly worker: HarnessName;
  readonly task?: string;
  readonly dshRoot?: string;
  readonly codexExe?: string;
  readonly stateDirectory?: string;
  readonly maxTaskChars: number;
  /** Accept Codex permission-profile approvals on the host. Off by default. */
  readonly allowHostPermissions: boolean;
  /** Auto-accept every worker approval. Off by default. */
  readonly trustWorker: boolean;
}

const DEFAULT_MAX_TASK_CHARS = 20_000;
/** Mirrors the gateway's policy upper bound. */
const MAX_TASK_CHARS_LIMIT = 1_000_000;
const TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;

function usage(): string {
  return [
    'Usage: node dist/src/delegation-cli.js <project-dir> [options]',
    '',
    'Starts a worker session and a gateway, then a host session that can call',
    'delegate_to_worker / start_delegation / get_delegation_result.',
    '',
    'Options:',
    '  --host <codex|dsh>          Harness that receives the delegation tools (default codex)',
    '  --worker <codex|dsh>        Harness that runs delegated tasks (default dsh)',
    '  --task <text>               Run one task, print the result, and exit',
    '  --dsh-root <path>           DSH checkout (or DSH_ROOT)',
    '  --codex-exe <path>          Codex executable (or CODEX_EXE, or PATH)',
    '  --state-dir <path>          Delegation ledger directory (default under ~/.unified-workspace)',
    '  --max-task-chars <n>        Task size limit, 1..1000000 (default 20000)',
    '  --allow-host-permissions    Let the host approve Codex permission-profile requests',
    '  --trust-worker              Auto-approve every worker approval (trusted project only)',
    '  -h, --help                  Show this help',
    '',
    'Delegation-related host approvals are always accepted; other host approvals',
    'are rejected unless --allow-host-permissions is set. Worker approvals are',
    'rejected unless --trust-worker is set.',
    '',
    'Interactive input is submitted to the host; /quit exits.',
  ].join('\n');
}

function parseHarness(value: string | undefined, flag: string): HarnessName {
  if (value !== 'codex' && value !== 'dsh') {
    throw new Error(`${flag} must be "codex" or "dsh": ${String(value)}`);
  }
  return value;
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} must not be empty`);
  }
  return value;
}

export function parseDelegationCliArgs(argv: readonly string[]): DelegationCliOptions | undefined {
  let projectDir: string | undefined;
  let host: HarnessName = 'codex';
  let worker: HarnessName = 'dsh';
  let task: string | undefined;
  let dshRoot: string | undefined;
  let codexExe: string | undefined;
  let stateDirectory: string | undefined;
  let maxTaskChars = DEFAULT_MAX_TASK_CHARS;
  let allowHostPermissions = false;
  let trustWorker = false;
  const seen = new Set<string>();
  let literal = false;

  const mark = (flag: string): void => {
    if (seen.has(flag)) {
      throw new Error(`Duplicate option: ${flag}`);
    }
    seen.add(flag);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (literal) {
      if (projectDir !== undefined) {
        throw new Error(`Unexpected extra argument: ${arg}`);
      }
      projectDir = arg;
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      return undefined;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const valueFor = (): string => {
      if (inline !== undefined) {
        return requireValue(inline, flag);
      }
      const next = argv[index + 1];
      index += 1;
      return requireValue(next, flag);
    };
    if (flag === '--host') {
      mark(flag);
      host = parseHarness(valueFor(), '--host');
      continue;
    }
    if (flag === '--worker') {
      mark(flag);
      worker = parseHarness(valueFor(), '--worker');
      continue;
    }
    if (flag === '--task') {
      mark(flag);
      task = valueFor();
      continue;
    }
    if (flag === '--dsh-root') {
      mark(flag);
      dshRoot = valueFor();
      continue;
    }
    if (flag === '--codex-exe') {
      mark(flag);
      codexExe = valueFor();
      continue;
    }
    if (flag === '--state-dir') {
      mark(flag);
      stateDirectory = valueFor();
      continue;
    }
    if (flag === '--max-task-chars') {
      mark(flag);
      const parsed = Number(valueFor());
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TASK_CHARS_LIMIT) {
        throw new Error(
          `--max-task-chars must be an integer between 1 and ${String(MAX_TASK_CHARS_LIMIT)}`,
        );
      }
      maxTaskChars = parsed;
      continue;
    }
    if (arg === '--allow-host-permissions') {
      mark(arg);
      allowHostPermissions = true;
      continue;
    }
    if (arg === '--trust-worker') {
      mark(arg);
      trustWorker = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (projectDir !== undefined) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    projectDir = arg;
  }

  if (projectDir === undefined) {
    throw new Error('Missing project directory');
  }
  return {
    projectDir,
    host,
    worker,
    maxTaskChars,
    allowHostPermissions,
    trustWorker,
    ...(task === undefined ? {} : { task }),
    ...(dshRoot === undefined ? {} : { dshRoot }),
    ...(codexExe === undefined ? {} : { codexExe }),
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
  };
}

/** Codex injects MCP servers through thread/start config; env is an object. */
export function buildCodexHostConfig(
  bridgePath: string,
  info: Pick<CollaborationGatewayInfo, 'url' | 'token'>,
  worker: HarnessName,
): Record<string, unknown> {
  return {
    mcp_servers: {
      unified_delegate: {
        command: process.execPath,
        args: [bridgePath],
        env: {
          UW_GATEWAY_URL: info.url,
          UW_GATEWAY_TOKEN: info.token,
          UW_WORKER: worker,
        },
      },
    },
  };
}

/** DSH declares MCP servers in ACP session/new; env is an array. */
export function buildDshMcpServers(
  bridgePath: string,
  info: Pick<CollaborationGatewayInfo, 'url' | 'token'>,
  worker: HarnessName,
): Array<Record<string, unknown>> {
  return [
    {
      name: 'unified_delegate',
      command: process.execPath,
      args: [bridgePath],
      env: [
        { name: 'UW_GATEWAY_URL', value: info.url },
        { name: 'UW_GATEWAY_TOKEN', value: info.token },
        { name: 'UW_WORKER', value: worker },
      ],
    },
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** CLI flag wins, then CODEX_EXE (trimmed), then PATH lookup by the helper. */
export function resolveCodexExecutableOption(
  options: Pick<DelegationCliOptions, 'codexExe'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.CODEX_EXE?.trim();
  return options.codexExe ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv);
}

export type ApprovalRole = 'host' | 'worker';
export type ApprovalDecision = 'allow_once' | 'reject_once';

/**
 * Host approvals are limited to our own MCP server; permission-profile
 * approvals need an explicit opt-in. Worker approvals need --trust-worker.
 */
export function decideApprovalDecision(
  role: ApprovalRole,
  summary: string,
  options: Pick<DelegationCliOptions, 'allowHostPermissions' | 'trustWorker'>,
): ApprovalDecision {
  if (role === 'worker') {
    return options.trustWorker ? 'allow_once' : 'reject_once';
  }
  if (/permissions/i.test(summary)) {
    return options.allowHostPermissions ? 'allow_once' : 'reject_once';
  }
  return /unified_delegate/i.test(summary) ? 'allow_once' : 'reject_once';
}

async function createAdapter(
  harness: HarnessName,
  options: DelegationCliOptions,
  hostConfig: Record<string, unknown> | Array<Record<string, unknown>> | undefined,
): Promise<HarnessAdapter> {
  if (harness === 'dsh') {
    const dshRoot = options.dshRoot ?? process.env.DSH_ROOT;
    if (dshRoot === undefined || dshRoot.trim() === '') {
      throw new Error('dsh needs DSH_ROOT or --dsh-root');
    }
    return new DshAcpAdapter({
      dshRoot,
      ...(hostConfig === undefined
        ? {}
        : { mcpServers: hostConfig as Array<Record<string, unknown>> }),
    });
  }
  const codexExecutable = resolveCodexExecutableOption(options);
  const codex = await createCodexConnection(
    codexExecutable === undefined ? {} : { executable: codexExecutable },
  );
  return new CodexAppServerAdapter({
    launch: codex.launch,
    ...(hostConfig === undefined ? {} : { config: hostConfig as Record<string, unknown> }),
  });
}

async function waitForTerminal(
  workbench: Workbench,
  connection: string,
  executionId: string,
): Promise<{ state: string; output: string }> {
  const started = Date.now();
  while (Date.now() - started < TERMINAL_TIMEOUT_MS) {
    const found = workbench.getExecution(connection, executionId);
    if (found !== undefined && found.execution.state !== 'running') {
      return { state: found.execution.state, output: found.execution.output };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`execution ${executionId} did not settle within ${String(TERMINAL_TIMEOUT_MS)}ms`);
}

function wireApprovals(
  workbench: Workbench,
  role: ApprovalRole,
  options: DelegationCliOptions,
): void {
  workbench.onEvent((tagged) => {
    const event = tagged.event;
    if (event.type !== 'execution/approval-requested') {
      return;
    }
    const decision = decideApprovalDecision(role, event.request.summary, options);
    process.stdout.write(
      `\n[${role}] approval ${decision === 'allow_once' ? 'allow' : 'reject'}: ${event.request.summary}\n`,
    );
    if (decision === 'reject_once' && role === 'worker' && !options.trustWorker) {
      process.stdout.write('  worker approvals need --trust-worker\n');
    }
    if (decision === 'reject_once' && role === 'host' && /permissions/i.test(event.request.summary)) {
      process.stdout.write('  host permission requests need --allow-host-permissions\n');
    }
    void workbench
      .decideApproval(tagged.connection, event.executionId, event.request.requestId, decision)
      .catch((error: unknown) => process.stderr.write(`approval failed: ${messageOf(error)}\n`));
  });
}

/**
 * Line loop that never loses a close: `for await` buffers lines and ends on
 * EOF even while a task is still running.
 */
export async function runInteractive(
  readline: Interface,
  runTask: (text: string) => Promise<boolean>,
  promptLabel: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  let interrupted = false;
  let closed = false;
  const onSigint = (): void => {
    interrupted = true;
    readline.close();
  };
  const onClose = (): void => {
    closed = true;
  };
  const prompt = (): void => {
    if (interrupted || closed) {
      return;
    }
    readline.setPrompt(`${promptLabel}> `);
    readline.prompt();
  };
  readline.on('SIGINT', onSigint);
  readline.on('close', onClose);
  try {
    prompt();
    for await (const raw of readline) {
      const text = raw.trim();
      if (text === '/quit') {
        break;
      }
      if (text !== '') {
        const ok = await runTask(text);
        if (!ok) {
          write('host execution did not complete\n');
        }
      }
      prompt();
    }
  } finally {
    readline.off('SIGINT', onSigint);
    readline.off('close', onClose);
  }
}

async function main(): Promise<void> {
  let options: DelegationCliOptions | undefined;
  try {
    options = parseDelegationCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options === undefined) {
    return;
  }

  const kernel = createKernel();
  const project = kernel.registerProject(options.projectDir);
  const bridgePath = join(dirname(fileURLToPath(import.meta.url)), 'mcp-delegate-bridge.js');
  if (!existsSync(bridgePath)) {
    throw new Error(`MCP bridge not found at ${bridgePath}; run npm run build first`);
  }

  let workerWorkbench: Workbench | undefined;
  let hostWorkbench: Workbench | undefined;
  let gateway: CollaborationGateway | undefined;
  let cleanupFailed = false;
  let stopped = false;

  const stopAll = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      await hostWorkbench?.stop();
    } catch (error) {
      cleanupFailed = true;
      process.stderr.write(`host cleanup failed: ${messageOf(error)}\n`);
    }
    try {
      await gateway?.stop();
    } catch (error) {
      cleanupFailed = true;
      process.stderr.write(`gateway cleanup failed: ${messageOf(error)}\n`);
    }
    try {
      await workerWorkbench?.stop();
    } catch (error) {
      cleanupFailed = true;
      process.stderr.write(`worker cleanup failed: ${messageOf(error)}\n`);
    }
  };

  const onSignal = (code: number): void => {
    void stopAll().finally(() => process.exit(code));
  };
  process.once('SIGINT', () => onSignal(130));
  process.once('SIGTERM', () => onSignal(143));

  try {
    workerWorkbench = new Workbench({
      project,
      connections: [
        { name: options.worker, adapter: await createAdapter(options.worker, options, undefined) },
      ],
    });
    await workerWorkbench.start();

    gateway = new CollaborationGateway(workerWorkbench, {
      workerConnection: options.worker,
      maxTaskChars: options.maxTaskChars,
      ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
    });
    const info = await gateway.start();
    process.stdout.write(
      `delegation: worker=${options.worker} host=${options.host}\n` +
        `gateway ${info.url} state ${gateway.stateDirectory ?? '(default)'}\n`,
    );

    const hostConfig =
      options.host === 'codex'
        ? buildCodexHostConfig(bridgePath, info, options.worker)
        : buildDshMcpServers(bridgePath, info, options.worker);
    hostWorkbench = new Workbench({
      project,
      connections: [
        { name: options.host, adapter: await createAdapter(options.host, options, hostConfig) },
      ],
    });
    wireApprovals(hostWorkbench, 'host', options);
    wireApprovals(workerWorkbench, 'worker', options);
    await hostWorkbench.start();

    const runTask = async (text: string): Promise<{ ok: boolean; output: string }> => {
      const submitted = await hostWorkbench?.submit(text, options.host);
      if (submitted === undefined) {
        return { ok: false, output: '' };
      }
      const execution = await waitForTerminal(
        hostWorkbench as Workbench,
        options.host,
        submitted.execution.id,
      );
      return { ok: execution.state === 'completed', output: execution.output };
    };

    if (options.task !== undefined) {
      const result = await runTask(options.task);
      process.stdout.write(`\n${result.output}\n`);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    const renderState = createRenderState();
    hostWorkbench.onEvent((tagged) => {
      renderTaggedEvent(tagged, renderState, (text) => process.stdout.write(text));
    });
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await runInteractive(readline, async (text) => (await runTask(text)).ok, options.host);
    } finally {
      readline.close();
    }
  } finally {
    await stopAll();
    if (cleanupFailed && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  void main().catch((error: unknown) => {
    process.stderr.write(`delegation-cli failed: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
