// Delegation CLI: one command enters a host session that already has the
// unified_delegate MCP tools, with the gateway and a worker session assembled
// around it. It composes existing pieces only; it does not change DSH, the
// gateway semantics, or the adapter contracts.
import { createInterface } from 'node:readline';
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
}

const DEFAULT_MAX_TASK_CHARS = 20_000;
const TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;

function usage(): string {
  return [
    'Usage: node dist/src/delegation-cli.js <project-dir> [options]',
    '',
    'Starts a worker session and a gateway, then a host session that can call',
    'delegate_to_worker / start_delegation / get_delegation_result.',
    '',
    'Options:',
    '  --host <codex|dsh>        Harness that receives the delegation tools (default codex)',
    '  --worker <codex|dsh>      Harness that runs delegated tasks (default dsh)',
    '  --task <text>             Run one task, print the result, and exit',
    '  --dsh-root <path>         DSH checkout (or DSH_ROOT)',
    '  --codex-exe <path>        Codex executable (or CODEX_EXE, or PATH)',
    '  --state-dir <path>        Delegation ledger directory (default under ~/.unified-workspace)',
    '  --max-task-chars <n>      Task size limit (default 20000)',
    '  -h, --help                Show this help',
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

export function parseDelegationCliArgs(argv: readonly string[]): DelegationCliOptions | undefined {
  let projectDir: string | undefined;
  let host: HarnessName = 'codex';
  let worker: HarnessName = 'dsh';
  let task: string | undefined;
  let dshRoot: string | undefined;
  let codexExe: string | undefined;
  let stateDirectory: string | undefined;
  let maxTaskChars = DEFAULT_MAX_TASK_CHARS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      return undefined;
    }
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return next;
    };
    if (arg === '--host') {
      host = parseHarness(value(), '--host');
      continue;
    }
    if (arg === '--worker') {
      worker = parseHarness(value(), '--worker');
      continue;
    }
    if (arg === '--task') {
      task = value();
      continue;
    }
    if (arg === '--dsh-root') {
      dshRoot = value();
      continue;
    }
    if (arg === '--codex-exe') {
      codexExe = value();
      continue;
    }
    if (arg === '--state-dir') {
      stateDirectory = value();
      continue;
    }
    if (arg === '--max-task-chars') {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid --max-task-chars: ${String(argv[index])}`);
      }
      maxTaskChars = parsed;
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

/** CLI flag wins, then CODEX_EXE, then PATH lookup by the connection helper. */
export function resolveCodexExecutableOption(
  options: Pick<DelegationCliOptions, 'codexExe'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return options.codexExe ?? (env.CODEX_EXE === undefined || env.CODEX_EXE.trim() === '' ? undefined : env.CODEX_EXE);
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

/** Host approvals are limited to delegation-related prompts; workers may act. */
function wireApprovals(workbench: Workbench, role: 'host' | 'worker'): void {
  workbench.onEvent((tagged) => {
    const event = tagged.event;
    if (event.type !== 'execution/approval-requested') {
      return;
    }
    const allow =
      role === 'worker' || /unified_delegate|mcp|delegate|permission/i.test(event.request.summary);
    process.stdout.write(`\n[${role}] approval ${allow ? 'allow' : 'reject'}: ${event.request.summary}\n`);
    void workbench
      .decideApproval(
        tagged.connection,
        event.executionId,
        event.request.requestId,
        allow ? 'allow_once' : 'reject_once',
      )
      .catch((error: unknown) => process.stderr.write(`approval failed: ${messageOf(error)}\n`));
  });
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

  let workerWorkbench: Workbench | undefined;
  let hostWorkbench: Workbench | undefined;
  let gateway: CollaborationGateway | undefined;
  try {
    workerWorkbench = new Workbench({
      project,
      connections: [{ name: options.worker, adapter: await createAdapter(options.worker, options, undefined) }],
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
      connections: [{ name: options.host, adapter: await createAdapter(options.host, options, hostConfig) }],
    });
    wireApprovals(hostWorkbench, 'host');
    wireApprovals(workerWorkbench, 'worker');
    const renderState = createRenderState();
    hostWorkbench.onEvent((tagged) => {
      renderTaggedEvent(tagged, renderState, (text) => process.stdout.write(text));
    });
    await hostWorkbench.start();

    const runTask = async (text: string): Promise<boolean> => {
      const submitted = await hostWorkbench?.submit(text, options.host);
      if (submitted === undefined) {
        return false;
      }
      const execution = await waitForTerminal(hostWorkbench as Workbench, options.host, submitted.execution.id);
      process.stdout.write(`\n${execution.output}\n`);
      return execution.state === 'completed';
    };

    if (options.task !== undefined) {
      const ok = await runTask(options.task);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        readline.setPrompt(`${options.host}> `);
        readline.prompt();
        const line = await new Promise<string | undefined>((resolveLine) => {
          const onLine = (text: string): void => {
            readline.off('close', onClose);
            resolveLine(text);
          };
          const onClose = (): void => {
            readline.off('line', onLine);
            resolveLine(undefined);
          };
          readline.once('line', onLine);
          readline.once('close', onClose);
        });
        if (line === undefined) {
          break;
        }
        const text = line.trim();
        if (text === '') {
          continue;
        }
        if (text === '/quit') {
          break;
        }
        const ok = await runTask(text);
        if (!ok) {
          process.stderr.write('host execution did not complete\n');
        }
      }
    } finally {
      readline.close();
    }
  } finally {
    try {
      await hostWorkbench?.stop();
    } catch (error) {
      process.stderr.write(`host cleanup failed: ${messageOf(error)}\n`);
    }
    try {
      await gateway?.stop();
    } catch (error) {
      process.stderr.write(`gateway cleanup failed: ${messageOf(error)}\n`);
    }
    try {
      await workerWorkbench?.stop();
    } catch (error) {
      process.stderr.write(`worker cleanup failed: ${messageOf(error)}\n`);
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
