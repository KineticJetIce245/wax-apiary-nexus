import { createInterface } from 'node:readline';
import { CodexAppServerAdapter } from './adapters/codex/adapter.js';
import { DshAcpAdapter } from './adapters/dsh-acp/adapter.js';
import type { ApprovalDecisionKind, ApprovalRequest } from './adapters/harness.js';
import { createCodexConnection } from './connection.js';
import { createKernel } from './kernel.js';
import { Workbench, type ConnectionSpec, type TaggedWorkspaceEvent } from './workbench.js';

interface CliOptions {
  readonly projectDir: string;
  readonly dshRoot?: string;
  readonly codexExe?: string;
  readonly approvalTimeoutMs: number;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

function usage(): string {
  return [
    'Usage: node dist/src/workbench-cli.js <project-dir> [options]',
    '',
    'Options:',
    '  --dsh-root <path>            DSH checkout containing apps/cli/lib/bin.js (or DSH_ROOT)',
    '  --codex-exe <path>           Codex executable (or PATH)',
    '  --approval-timeout-ms <n>    Cancel an unanswered approval after n ms (default 120000)',
    '  -h, --help                   Show this help',
    '',
    'Commands:',
    '  /use <dsh|codex>                     Select the target for plain text input',
    '  /status                              Show connections and conversations',
    '  /approvals                           List pending approvals',
    '  /approve <n> <1|2|3>                 Answer approval n (1 allow, 2 reject, 3 cancel)',
    '  /cancel <connection> <execution-id>  Cancel that connection execution',
    '  /transfer <source> <execution-id> <target> [instruction...]',
    '  /records                             Show in-memory transfer records',
    '  /close <connection>                  Close one connection',
    '  /quit                                Close and stop all connections',
    '',
    'Anything else is submitted to the current target.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliOptions | undefined {
  let projectDir: string | undefined;
  let dshRoot: string | undefined;
  let codexExe: string | undefined;
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
    if (arg === '--codex-exe') {
      codexExe = argv[index + 1];
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
    ...(codexExe === undefined ? {} : { codexExe }),
  };
}

interface PendingApproval {
  readonly connection: string;
  readonly request: ApprovalRequest;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) {
    return;
  }

  const kernel = createKernel();
  const project = kernel.registerProject(options.projectDir);
  const connections: ConnectionSpec[] = [];
  const unavailable: string[] = [];

  const dshRoot = options.dshRoot ?? process.env.DSH_ROOT;
  if (dshRoot !== undefined && dshRoot.trim() !== '') {
    connections.push({ name: 'dsh', adapter: new DshAcpAdapter({ dshRoot }) });
  } else {
    unavailable.push('dsh: set DSH_ROOT or --dsh-root');
  }

  try {
    const codex = await createCodexConnection(
      options.codexExe === undefined ? {} : { executable: options.codexExe },
    );
    connections.push({ name: 'codex', adapter: new CodexAppServerAdapter({ launch: codex.launch }) });
    process.stdout.write(`codex: ${codex.version.version} (${codex.launch.file})\n`);
  } catch (error) {
    unavailable.push(`codex: ${messageOf(error)}`);
  }

  if (connections.length === 0) {
    throw new Error(`No harness connection is configured:\n  ${unavailable.join('\n  ')}`);
  }

  const workbench = new Workbench({
    project,
    connections,
    approvalTimeoutMs: options.approvalTimeoutMs,
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.pause();
  const pending: PendingApproval[] = [];
  const streams = new Set<string>();
  let shuttingDown = false;

  const printPrompt = (): void => {
    readline.setPrompt(`${workbench.activeConnection ?? 'none'}> `);
    readline.prompt();
  };

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    readline.close();
    try {
      await workbench.stop();
    } catch (error) {
      process.stderr.write(`workbench cleanup failed: ${messageOf(error)}\n`);
    }
    process.exit(code);
  };

  process.once('SIGINT', () => {
    void shutdown(130);
  });

  workbench.onEvent((tagged) => {
    renderEvent(tagged);
  });

  function renderEvent({ connection, event }: TaggedWorkspaceEvent): void {
    switch (event.type) {
      case 'execution/output': {
        const key = `${connection}:${event.executionId}`;
        if (event.channel === 'assistant') {
          if (!streams.has(key)) {
            streams.add(key);
            process.stdout.write(`\n[${connection}:${event.executionId.slice(0, 8)}] `);
          }
          process.stdout.write(event.text);
        }
        return;
      }
      case 'execution/tool': {
        process.stdout.write(`\n[${connection}] tool ${event.title} ${event.status}\n`);
        return;
      }
      case 'execution/approval-requested': {
        pending.push({ connection, request: event.request });
        const index = pending.length;
        process.stdout.write(
          `\n[${connection}] approval #${String(index)} ${event.request.summary}\n` +
            `  execution ${event.request.executionId}, request ${event.request.requestId}\n` +
            '  /approve ' + String(index) + ' 1|2|3\n',
        );
        return;
      }
      case 'execution/approval-decided': {
        const index = pending.findIndex(
          (entry) => entry.connection === connection && entry.request.requestId === event.requestId,
        );
        if (index >= 0) {
          pending.splice(index, 1);
        }
        process.stdout.write(`\n[${connection}] approval ${event.kind}\n`);
        return;
      }
      case 'execution/state': {
        process.stdout.write(
          `\n[${connection}] execution ${event.executionId.slice(0, 8)} ${event.state}` +
            `${event.stopReason === undefined ? '' : ` (${event.stopReason})`}\n`,
        );
        if (event.error !== undefined) {
          process.stderr.write(`[${connection}] ${event.error}\n`);
        }
        return;
      }
      case 'adapter/error': {
        process.stderr.write(`[${connection}] adapter error: ${event.message}\n`);
        return;
      }
    }
  }

  try {
    await workbench.start();
  } catch (error) {
    readline.close();
    await workbench.stop().catch(() => undefined);
    throw error;
  }

  process.stdout.write(
    `project: ${project.directory}\n` +
      `connections: ${workbench.connectionNames.join(', ')}\n` +
      (unavailable.length === 0 ? '' : `unavailable:\n  ${unavailable.join('\n  ')}\n`) +
      (workbench.connectionFailures.length === 0
        ? ''
        : `start failures:\n  ${workbench.connectionFailures
            .map((failure) => `${failure.name}: ${failure.message}`)
            .join('\n  ')}\n`),
  );

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
    try {
      if (line === '/quit') {
        await shutdown(0);
        return;
      }
      if (line === '/status') {
        printStatus();
      } else if (line === '/help') {
        process.stdout.write(`${usage()}\n`);
      } else if (line === '/approvals') {
        printApprovals();
      } else if (line === '/records') {
        printRecords();
      } else if (line.startsWith('/use ')) {
        workbench.use(line.slice(5).trim());
        process.stdout.write(`target: ${workbench.activeConnection}\n`);
      } else if (line.startsWith('/approve ')) {
        await approve(line);
      } else if (line.startsWith('/cancel ')) {
        await cancel(line);
      } else if (line.startsWith('/transfer ')) {
        await transfer(line);
      } else if (line.startsWith('/close ')) {
        const name = line.slice(7).trim();
        await workbench.closeConnection(name);
        process.stdout.write(`closed: ${name}\n`);
      } else if (line.startsWith('/')) {
        process.stdout.write('Unknown command. Use /help.\n');
      } else {
        const execution = await workbench.submit(line);
        process.stdout.write(
          `submitted ${execution.execution.id} to ${execution.connection}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`error: ${messageOf(error)}\n`);
    }
    printPrompt();
  }

  function printStatus(): void {
    for (const name of workbench.connectionNames) {
      const connection = workbench.getConnection(name);
      if (connection === undefined) {
        continue;
      }
      process.stdout.write(
        `${name === workbench.activeConnection ? '*' : ' '} ${name} ` +
          `conversation=${connection.conversation.id} native=${connection.conversation.nativeId} ` +
          `status=${connection.status}\n`,
      );
    }
    for (const failure of workbench.connectionFailures) {
      process.stdout.write(`  ! ${failure.name}: ${failure.message}\n`);
    }
  }

  function printApprovals(): void {
    if (pending.length === 0) {
      process.stdout.write('no pending approvals\n');
      return;
    }
    for (const [index, entry] of pending.entries()) {
      process.stdout.write(
        `#${String(index + 1)} [${entry.connection}] ${entry.request.summary} ` +
          `execution=${entry.request.executionId} request=${entry.request.requestId}\n`,
      );
    }
  }

  function printRecords(): void {
    const records = workbench.transferRecords;
    if (records.length === 0) {
      process.stdout.write('no transfer records\n');
      return;
    }
    for (const record of records) {
      process.stdout.write(
        `${record.id.slice(0, 8)} ${record.outcome} ${record.source.connection}:${record.source.executionId.slice(0, 8)} ` +
          `-> ${record.target.connection}:${record.target.executionId?.slice(0, 8) ?? 'unknown'} ` +
          `(${String(record.input.length)} chars)\n`,
      );
    }
  }

  async function approve(line: string): Promise<void> {
    const [indexRaw, decisionRaw] = line.slice('/approve '.length).trim().split(/\s+/);
    const index = Number(indexRaw);
    const entry = pending[index - 1];
    if (!Number.isInteger(index) || entry === undefined) {
      throw new Error(`Unknown approval index: ${String(indexRaw)}`);
    }
    const kind = parseDecision(decisionRaw);
    await workbench.decideApproval(
      entry.connection,
      entry.request.executionId,
      entry.request.requestId,
      kind,
    );
  }

  async function cancel(line: string): Promise<void> {
    const [connection, executionId] = line.slice('/cancel '.length).trim().split(/\s+/);
    if (connection === undefined || executionId === undefined) {
      throw new Error('Usage: /cancel <connection> <execution-id>');
    }
    await workbench.cancel(connection, executionId);
    process.stdout.write(`cancel requested on ${connection} for ${executionId}\n`);
  }

  async function transfer(line: string): Promise<void> {
    const parts = line.slice('/transfer '.length).trim().split(/\s+/);
    const [source, executionId, target] = parts;
    if (source === undefined || executionId === undefined || target === undefined) {
      throw new Error('Usage: /transfer <source> <execution-id> <target> [instruction...]');
    }
    const instruction = parts.slice(3).join(' ');
    const record = await workbench.transfer(
      source,
      executionId,
      target,
      instruction === '' ? undefined : instruction,
    );
    process.stdout.write(
      `transferred ${source}:${executionId.slice(0, 8)} -> ${target}:${record.target.executionId?.slice(0, 8)}\n`,
    );
  }
}

function parseDecision(value: string | undefined): ApprovalDecisionKind {
  if (value === '1' || value === 'allow') {
    return 'allow_once';
  }
  if (value === '2' || value === 'reject') {
    return 'reject_once';
  }
  if (value === '3' || value === 'cancel') {
    return 'cancelled';
  }
  throw new Error(`Invalid approval decision: ${String(value)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${messageOf(error)}\n`);
  process.exitCode = 1;
});
