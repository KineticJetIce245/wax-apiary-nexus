import { createInterface } from 'node:readline';
import type { ApprovalDecisionKind, ApprovalRequest, HarnessAdapter } from './adapters/harness.js';
import { CodexAppServerAdapter } from './adapters/codex/adapter.js';
import { DshAcpAdapter } from './adapters/dsh-acp/adapter.js';
import {
  createCodexConnection,
  loadConnectionConfig,
  type ConnectionConfig,
  type HarnessKind,
} from './connection.js';
import { createKernel } from './kernel.js';
import {
  ConversationBusyError,
  UnknownApprovalError,
  UnknownExecutionError,
  Workspace,
} from './workspace.js';

interface CliOptions {
  readonly projectDir: string;
  readonly dshRoot?: string;
  readonly harness?: HarnessKind;
  readonly codexExe?: string;
  readonly configPath?: string;
  readonly approvalTimeoutMs: number;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

function usage(): string {
  return [
    'WAX Apiary neXus (harness coordination)',
    'Usage: node dist/src/cli.js <project-dir> [options]',
    '',
    'Options:',
    '  --harness <dsh|codex>        Native harness driver (default: dsh)',
    '  --config <path>              Local connection config: { "harness", "connection": "local", "executable" }',
    '  --dsh-root <path>            DSH checkout containing apps/cli/lib/bin.js',
    '  --codex-exe <path>           Codex executable override; otherwise PATH is searched',
    '  --approval-timeout-ms <n>    Cancel an unanswered approval after n ms (default 120000)',
    '  -h, --help                   Show this help',
    '',
    'Environment:',
    '  DSH_ROOT                     Used when --dsh-root is omitted (dsh harness)',
    '',
    'Commands:',
    '  /cancel                      Cancel the running execution',
    '  /close                       Close the conversation and exit',
    '  /quit                        Close the conversation and exit',
    '',
    'Approval responses: 1 / allow, 2 / reject, 3 / cancel',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliOptions | undefined {
  let projectDir: string | undefined;
  let dshRoot: string | undefined;
  let harness: HarnessKind | undefined;
  let codexExe: string | undefined;
  let configPath: string | undefined;
  let approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      return undefined;
    }
    if (arg === '--dsh-root') {
      dshRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--harness') {
      const raw = argv[index + 1];
      index += 1;
      if (raw !== 'dsh' && raw !== 'codex') {
        throw new Error(`Invalid --harness: ${String(raw)} (expected dsh or codex)`);
      }
      harness = raw;
      continue;
    }
    if (arg === '--codex-exe') {
      codexExe = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--config') {
      configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--approval-timeout-ms') {
      const raw = argv[index + 1];
      index += 1;
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --approval-timeout-ms: ${String(raw)}`);
      }
      approvalTimeoutMs = parsed;
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
    approvalTimeoutMs,
    ...(dshRoot === undefined ? {} : { dshRoot }),
    ...(harness === undefined ? {} : { harness }),
    ...(codexExe === undefined ? {} : { codexExe }),
    ...(configPath === undefined ? {} : { configPath }),
  };
}

async function createAdapter(
  options: CliOptions,
  config: ConnectionConfig | undefined,
): Promise<{ readonly adapter: HarnessAdapter; readonly label: string }> {
  const harness = options.harness ?? config?.harness ?? 'dsh';
  if (harness === 'codex') {
    const executable = options.codexExe ?? config?.executable;
    const connection = await createCodexConnection(executable === undefined ? {} : { executable });
    return {
      adapter: new CodexAppServerAdapter({ launch: connection.launch }),
      label: `codex ${connection.version.version} (${connection.launch.file})`,
    };
  }

  const dshRoot = options.dshRoot ?? process.env.DSH_ROOT;
  if (dshRoot === undefined || dshRoot.trim() === '') {
    throw new Error('DSH_ROOT or --dsh-root is required for the dsh harness');
  }
  return { adapter: new DshAcpAdapter({ dshRoot }), label: `dsh (${dshRoot})` };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) {
    return;
  }
  const config = options.configPath === undefined ? undefined : loadConnectionConfig(options.configPath);

  const kernel = createKernel();
  const project = kernel.registerProject(options.projectDir);
  const { adapter, label } = await createAdapter(options, config);
  const workspace = new Workspace(adapter, { approvalTimeoutMs: options.approvalTimeoutMs });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  // Keep piped input buffered until startup and the line handler are ready.
  readline.pause();
  let conversationId: string | undefined;
  let activeExecutionId: string | undefined;
  let pendingApproval: ApprovalRequest | undefined;
  let shuttingDown = false;

  const printPrompt = (): void => {
    readline.setPrompt(pendingApproval === undefined ? '> ' : 'approval> ');
    readline.prompt();
  };

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    readline.close();
    try {
      if (conversationId !== undefined) {
        await workspace.closeConversation(conversationId);
      }
    } catch (error) {
      process.stderr.write(`close conversation failed: ${messageOf(error)}\n`);
    }
    try {
      await workspace.stop();
    } catch (error) {
      process.stderr.write(`stop failed: ${messageOf(error)}\n`);
    }
    process.exit(code);
  };

  process.once('SIGINT', () => {
    void shutdown(130);
  });

  workspace.onEvent((event) => {
    switch (event.type) {
      case 'execution/output': {
        if (event.channel === 'assistant') {
          process.stdout.write(event.text);
        }
        return;
      }
      case 'execution/tool': {
        process.stdout.write(`\n[tool] ${event.title} ${event.status}\n`);
        return;
      }
      case 'execution/approval-requested': {
        pendingApproval = event.request;
        process.stdout.write(`\n[approval] ${event.request.summary}\n`);
        for (const [index, option] of event.request.options.entries()) {
          process.stdout.write(`  ${String(index + 1)}. ${option.label} (${option.kind})\n`);
        }
        process.stdout.write('  c. cancel execution\n');
        return;
      }
      case 'execution/approval-decided': {
        if (pendingApproval?.requestId === event.requestId) {
          pendingApproval = undefined;
        }
        process.stdout.write(`\n[approval] ${event.kind}\n`);
        return;
      }
      case 'execution/state': {
        if (activeExecutionId === event.executionId) {
          activeExecutionId = undefined;
        }
        process.stdout.write(`\n[execution] ${event.state}${event.stopReason === undefined ? '' : ` (${event.stopReason})`}\n`);
        if (event.error !== undefined) {
          process.stderr.write(`[execution error] ${event.error}\n`);
        }
        return;
      }
      case 'adapter/error': {
        process.stderr.write(`[adapter error] ${event.message}\n`);
        return;
      }
    }
  });

  try {
    await adapter.start();
    const conversation = await workspace.createConversation(project);
    conversationId = conversation.id;
    process.stdout.write(
      `harness: ${label}\nproject: ${project.directory}\nconversation: ${conversation.id}\n`,
    );
  } catch (error) {
    readline.close();
    await workspace.stop().catch(() => undefined);
    throw error;
  }

  readline.on('line', (line) => {
    void handleLine(line);
  });
  readline.on('close', () => {
    if (!shuttingDown) {
      void shutdown(0);
    }
  });

  readline.resume();
  printPrompt();

  async function handleLine(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    if (line === '') {
      printPrompt();
      return;
    }

    if (pendingApproval !== undefined) {
      const decision = parseApprovalDecision(line);
      if (decision === undefined) {
        process.stdout.write('Reply 1/allow, 2/reject, 3/cancel, or c/cancel.\n');
        printPrompt();
        return;
      }
      const request = pendingApproval;
      try {
        await workspace.decideApproval(request.executionId, request.requestId, decision);
      } catch (error) {
        if (error instanceof UnknownApprovalError) {
          process.stderr.write('approval already settled or timed out\n');
        } else {
          process.stderr.write(`approval failed: ${messageOf(error)}\n`);
        }
      }
      pendingApproval = undefined;
      printPrompt();
      return;
    }

    if (line === '/quit' || line === '/close') {
      await shutdown(0);
      return;
    }
    if (line === '/cancel') {
      if (activeExecutionId === undefined) {
        process.stdout.write('No execution is running.\n');
      } else {
        try {
          await workspace.cancel(activeExecutionId);
        } catch (error) {
          process.stderr.write(`cancel failed: ${messageOf(error)}\n`);
        }
      }
      printPrompt();
      return;
    }

    try {
      const execution = await workspace.submit(conversationId ?? '', line);
      if (execution.state === 'running') {
        activeExecutionId = execution.id;
      }
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        process.stdout.write(`An execution is already running: ${error.executionId}\n`);
      } else {
        process.stderr.write(`submit failed: ${messageOf(error)}\n`);
      }
    }
    printPrompt();
  }
}

function parseApprovalDecision(value: string): ApprovalDecisionKind | undefined {
  const normalized = value.toLowerCase();
  if (normalized === '1' || normalized === 'allow' || normalized === 'a') {
    return 'allow_once';
  }
  if (normalized === '2' || normalized === 'reject' || normalized === 'r') {
    return 'reject_once';
  }
  if (normalized === '3' || normalized === 'cancel' || normalized === 'c') {
    return 'cancelled';
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${messageOf(error)}\n`);
  process.exitCode = 1;
});
