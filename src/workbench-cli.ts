import { createInterface } from 'node:readline';
import { statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConversationStore,
  defaultConversationStorePath,
  sameProjectPath,
  type ConversationRecord,
} from './conversation-store.js';
import { CodexAppServerAdapter } from './adapters/codex/adapter.js';
import { DshAcpAdapter } from './adapters/dsh-acp/adapter.js';
import type { ApprovalDecisionKind } from './adapters/harness.js';
import { ApprovalInbox } from './approval-inbox.js';
import { createCodexConnection } from './connection.js';
import type { AttachmentDraft } from './content.js';
import { loadFlowDefinition } from './flow-definition.js';
import { FlowRuntime, type FlowEvent } from './flow-runtime.js';
import { createKernel } from './kernel.js';
import { WebServer } from './web-server.js';
import { createRenderState, renderTaggedEvent } from './workbench-renderer.js';
import { Workbench, type ConnectionSpec, type TaggedWorkspaceEvent } from './workbench.js';

export interface CliOptions {
  readonly projectDir: string;
  readonly dshRoot?: string;
  readonly codexExe?: string;
  readonly approvalTimeoutMs: number;
  readonly resume?: string;
  readonly conversationStore?: string;
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
    '  --resume <conversation-id>   Reattach to a saved conversation (see the id printed at start)',
    '  --conversation-store <path>  Conversation mapping file (default ~/.unified-workspace/conversations.json)',
    '  -h, --help                   Show this help',
    '',
    'Commands:',
    '  /use <dsh|codex>                     Select the target for plain text input',
    '  /status                              Show connections and conversations',
    '  /approvals                           List pending approvals',
    '  /approve <id> <1|2|3>                Answer the stable approval id (1 allow, 2 reject, 3 cancel)',
    '  /cancel <connection> <execution-id>  Cancel that connection execution',
    '  /replace <connection> <execution-id> <instruction...>',
    '                                       Cancel that execution, then submit the instruction',
    '  /transfer <source> <execution-id> <target> [instruction...] [--attach <path>]...',
    '  /records                             Show in-memory transfer records',
    '  /flow run <file>                     Start a declarative graph flow',
    '  /flow status                         Show the current or last flow',
    '  /flow cancel                         Cancel the running flow',
    '  /web start [port]                    Start the read-only local web view',
    '  /web stop                            Stop the web view',
    '  /web status                          Show the web view URL',
    '  /close <connection>                  Close one connection',
    '  /quit                                Close and stop all connections',
    '',
    'Anything else is submitted to the current target.',
  ].join('\n');
}

export interface ReplaceCommand {
  readonly connection: string;
  readonly executionId: string;
  readonly text: string;
}

/** Parse `/replace <connection> <execution-id> <instruction...>`. */
export function parseReplaceCommand(line: string): ReplaceCommand | undefined {
  if (!line.startsWith('/replace ')) {
    return undefined;
  }
  const rest = line.slice('/replace '.length).trim();
  const match = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
  if (match === null) {
    return undefined;
  }
  const [, connection, executionId, text] = match;
  if (
    connection === undefined ||
    executionId === undefined ||
    text === undefined ||
    text.trim() === ''
  ) {
    return undefined;
  }
  return { connection, executionId, text: text.trim() };
}

/**
 * After Workbench.start(), a failed resume only shows up as a connection
 * failure. Refuse to continue when the requested conversation did not attach.
 */
export function assertResumeTargetReady(
  workbench: Pick<Workbench, 'getConnection' | 'connectionFailures'>,
  harness: string,
): void {
  const connection = workbench.getConnection(harness);
  if (connection !== undefined && connection.status === 'ready') {
    return;
  }
  const failure = workbench.connectionFailures.find((entry) => entry.name === harness);
  throw new Error(
    `Failed to resume ${harness}: ${failure?.message ?? 'connection is not ready'}`,
  );
}

export function parseArgs(argv: readonly string[]): CliOptions | undefined {
  let projectDir: string | undefined;
  let dshRoot: string | undefined;
  let codexExe: string | undefined;
  let approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
  let resume: string | undefined;
  let conversationStore: string | undefined;
  const seen = new Set<string>();

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
    if (arg === '--resume' || arg.startsWith('--resume=')) {
      if (seen.has('--resume')) {
        throw new Error('Duplicate option: --resume');
      }
      seen.add('--resume');
      const raw =
        arg === '--resume' ? argv[(index += 1)] : arg.slice('--resume='.length);
      if (raw === undefined || raw.trim() === '') {
        throw new Error('Missing value for --resume');
      }
      resume = raw.trim();
      continue;
    }
    if (arg === '--conversation-store' || arg.startsWith('--conversation-store=')) {
      if (seen.has('--conversation-store')) {
        throw new Error('Duplicate option: --conversation-store');
      }
      seen.add('--conversation-store');
      const raw =
        arg === '--conversation-store'
          ? argv[(index += 1)]
          : arg.slice('--conversation-store='.length);
      if (raw === undefined || raw.trim() === '') {
        throw new Error('Missing value for --conversation-store');
      }
      conversationStore = raw.trim();
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
    ...(resume === undefined ? {} : { resume }),
    ...(conversationStore === undefined ? {} : { conversationStore }),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) {
    return;
  }

  const store = new ConversationStore(
    options.conversationStore ?? defaultConversationStorePath(),
  );
  let resumeRecord: ConversationRecord | undefined;
  if (options.resume !== undefined) {
    resumeRecord = store.find(options.resume);
    if (resumeRecord === undefined) {
      throw new Error(`Unknown conversation to resume: ${options.resume}`);
    }
    if (!sameProjectPath(resumeRecord.projectDirectory, options.projectDir)) {
      throw new Error(
        `Conversation ${options.resume} belongs to a different project: ${resumeRecord.projectDirectory}`,
      );
    }
  }
  const kernel = createKernel();
  const project = kernel.registerProject(options.projectDir, resumeRecord?.projectId);
  const connections: ConnectionSpec[] = [];
  const unavailable: string[] = [];

  const dshRoot = options.dshRoot ?? process.env.DSH_ROOT;
  if (dshRoot !== undefined && dshRoot.trim() !== '') {
    connections.push({
      name: 'dsh',
      adapter: new DshAcpAdapter({ dshRoot }),
      ...(resumeRecord?.harness === 'dsh'
        ? {
            resume: {
              conversationId: resumeRecord.conversationId,
              nativeId: resumeRecord.nativeId,
            },
          }
        : {}),
    });
  } else {
    unavailable.push('dsh: set DSH_ROOT or --dsh-root');
  }

  try {
    const codex = await createCodexConnection(
      options.codexExe === undefined ? {} : { executable: options.codexExe },
    );
    connections.push({
      name: 'codex',
      adapter: new CodexAppServerAdapter({ launch: codex.launch }),
      ...(resumeRecord?.harness === 'codex'
        ? {
            resume: {
              conversationId: resumeRecord.conversationId,
              nativeId: resumeRecord.nativeId,
            },
          }
        : {}),
    });
    process.stdout.write(`codex: ${codex.version.version} (${codex.launch.file})\n`);
  } catch (error) {
    unavailable.push(`codex: ${messageOf(error)}`);
  }

  if (connections.length === 0) {
    throw new Error(`No harness connection is configured:\n  ${unavailable.join('\n  ')}`);
  }
  if (
    resumeRecord !== undefined &&
    !connections.some((connection) => connection.name === resumeRecord?.harness)
  ) {
    throw new Error(
      `Cannot resume ${resumeRecord.harness}: that harness is not available in this run`,
    );
  }

  const workbench = new Workbench({
    project,
    connections,
    approvalTimeoutMs: options.approvalTimeoutMs,
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.pause();
  const inbox = new ApprovalInbox();
  const renderState = createRenderState();
  let shuttingDown = false;
  let flowRuntime: FlowRuntime | undefined;
  let flowRunning: Promise<void> | undefined;
  let webServer: WebServer | undefined;

  const printPrompt = (): void => {
    if (shuttingDown) {
      return;
    }
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
      await flowRuntime?.cancel();
      if (flowRunning !== undefined) {
        await flowRunning.catch(() => undefined);
      }
    } catch {
      // Flow cancellation must not prevent connection cleanup.
    }
    try {
      await webServer?.stop();
      webServer = undefined;
    } catch {
      // Web cleanup must not prevent connection cleanup.
    }
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

  function renderEvent(tagged: TaggedWorkspaceEvent): void {
    const { connection, event } = tagged;
    switch (event.type) {
      case 'execution/output':
      case 'execution/tool':
      case 'execution/state': {
        renderTaggedEvent(tagged, renderState, (text) => {
          process.stdout.write(text);
        });
        if (event.type === 'execution/state') {
          if (event.error !== undefined) {
            process.stderr.write(`[${connection}] ${event.error}\n`);
          }
          if (event.state !== 'running') {
            // Workspace drops pending approvals when an execution terminates
            // without emitting approval-decided; remove their display ids too.
            inbox.removeByExecution(connection, event.executionId);
          }
        }
        return;
      }
      case 'execution/attachment': {
        renderState.lastOutputKey = undefined;
        process.stdout.write(
          `\n[${connection}] attachment ${event.attachment.kind} ` +
            `${event.attachment.name ?? event.attachment.path} ` +
            `(${event.attachment.mimeType})\n`,
        );
        return;
      }
      case 'execution/approval-requested': {
        renderState.lastOutputKey = undefined;
        const entry = inbox.add(connection, event.request);
        process.stdout.write(
          `\n[${connection}] approval #${String(entry.id)} ${event.request.summary}\n` +
            `  execution ${event.request.executionId}, request ${event.request.requestId}\n` +
            '  /approve ' + String(entry.id) + ' 1|2|3\n',
        );
        return;
      }
      case 'execution/approval-decided': {
        renderState.lastOutputKey = undefined;
        inbox.remove(connection, event.requestId);
        process.stdout.write(`\n[${connection}] approval ${event.kind}\n`);
        return;
      }
      case 'adapter/error': {
        renderState.lastOutputKey = undefined;
        process.stderr.write(`[${connection}] adapter error: ${event.message}\n`);
        return;
      }
    }
  }

  try {
    await workbench.start();
    if (resumeRecord !== undefined) {
      assertResumeTargetReady(workbench, resumeRecord.harness);
    }
    for (const name of workbench.connectionNames) {
      const connection = workbench.getConnection(name);
      if (connection === undefined) {
        continue;
      }
      store.upsert({
        conversationId: connection.conversation.id,
        harness: name,
        nativeId: connection.conversation.nativeId,
        projectId: project.id,
        projectDirectory: project.directory,
        updatedAt: new Date().toISOString(),
      });
      process.stdout.write(
        `conversation ${name} ${connection.conversation.id} native=${connection.conversation.nativeId}` +
          `${resumeRecord?.conversationId === connection.conversation.id ? ' (resumed)' : ''}\n`,
      );
    }
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
      } else if (line === '/flow') {
        process.stdout.write('Usage: /flow run <file> | /flow status | /flow cancel\n');
      } else if (line.startsWith('/flow run ')) {
        await runFlow(line.slice('/flow run '.length).trim());
      } else if (line === '/flow status') {
        printFlowStatus();
      } else if (line === '/flow cancel') {
        await cancelFlow();
      } else if (line === '/web') {
        process.stdout.write('Usage: /web start [port] | /web stop | /web status\n');
      } else if (line.startsWith('/web start')) {
        await startWeb(line);
      } else if (line === '/web stop') {
        await stopWeb();
      } else if (line === '/web status') {
        printWeb();
      } else if (line.startsWith('/use ')) {
        workbench.use(line.slice(5).trim());
        process.stdout.write(`target: ${workbench.activeConnection}\n`);
      } else if (line.startsWith('/approve ')) {
        await approve(line);
      } else if (line.startsWith('/cancel ')) {
        await cancel(line);
      } else if (line === '/replace') {
        throw new Error('Usage: /replace <connection> <execution-id> <instruction...>');
      } else if (line.startsWith('/replace ')) {
        await replace(line);
      } else if (line.startsWith('/transfer ')) {
        await transfer(line);
      } else if (line.startsWith('/close ')) {
        const name = line.slice(7).trim();
        try {
          await workbench.closeConnection(name);
          process.stdout.write(`closed: ${name}\n`);
        } finally {
          inbox.removeByConnection(name);
        }
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
    const entries = inbox.list();
    if (entries.length === 0) {
      process.stdout.write('no pending approvals\n');
      return;
    }
    for (const entry of entries) {
      process.stdout.write(
        `#${String(entry.id)} [${entry.connection}] ${entry.request.summary} ` +
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
      const target =
        record.target.executionId === undefined
          ? undefined
          : workbench.getExecution(record.target.connection, record.target.executionId)?.execution;
      process.stdout.write(
        `${record.id.slice(0, 8)} ${record.outcome} ${record.source.connection}:${record.source.executionId.slice(0, 8)} ` +
          `-> ${record.target.connection}:${record.target.executionId?.slice(0, 8) ?? 'unknown'} ` +
          `(${target?.state ?? 'unknown'}, ${String(record.input.length)} chars)` +
          `${record.error === undefined ? '' : ` error: ${record.error}`}\n`,
      );
    }
  }

  async function approve(line: string): Promise<void> {
    const [idRaw, decisionRaw] = line.slice('/approve '.length).trim().split(/\s+/);
    const id = Number(idRaw);
    const entry = Number.isInteger(id) ? inbox.get(id) : undefined;
    if (entry === undefined) {
      throw new Error(`Unknown or expired approval id: ${String(idRaw)}`);
    }
    const kind = parseDecision(decisionRaw);
    await workbench.decideApproval(
      entry.connection,
      entry.request.executionId,
      entry.request.requestId,
      kind,
    );
    inbox.remove(entry.connection, entry.request.requestId);
  }

  async function cancel(line: string): Promise<void> {
    const [connection, executionId] = line.slice('/cancel '.length).trim().split(/\s+/);
    if (connection === undefined || executionId === undefined) {
      throw new Error('Usage: /cancel <connection> <execution-id>');
    }
    await workbench.cancel(connection, executionId);
    process.stdout.write(`cancel requested on ${connection} for ${executionId}\n`);
  }

  async function replace(line: string): Promise<void> {
    const parsed = parseReplaceCommand(line);
    if (parsed === undefined) {
      throw new Error('Usage: /replace <connection> <execution-id> <instruction...>');
    }
    const execution = await workbench.replace(parsed.connection, parsed.executionId, parsed.text);
    process.stdout.write(
      `replace requested on ${parsed.connection}: ${parsed.executionId} -> ${execution.execution.id}\n`,
    );
  }

  async function runFlow(path: string): Promise<void> {
    if (path === '') {
      throw new Error('Usage: /flow run <file>');
    }
    if (flowRunning !== undefined) {
      throw new Error('A flow is already running; use /flow status or /flow cancel');
    }
    const definition = loadFlowDefinition(path);
    const runtime = new FlowRuntime(workbench, definition, { pollIntervalMs: 50 });
    flowRuntime = runtime;
    runtime.onEvent(renderFlowEvent);
    process.stdout.write(
      `\n[flow] started ${runtime.flowId} (${String(Object.keys(definition.nodes).length)} nodes)\n`,
    );
    flowRunning = runtime
      .run()
      .then((result) => {
        process.stdout.write(
          `\n[flow] ${result.status}` +
            `${result.error === undefined ? '' : `: ${result.error}`}\n`,
        );
        for (const state of Object.values(result.nodes)) {
          if (state.status !== 'pending') {
            process.stdout.write(
              `[flow] node ${state.nodeId} ${state.status}` +
                `${state.executionId === undefined ? '' : ` (${state.executionId.slice(0, 8)})`}\n`,
            );
          }
        }
      })
      .catch((error: unknown) => {
        process.stderr.write(`[flow] failed: ${messageOf(error)}\n`);
      })
      .finally(() => {
        flowRunning = undefined;
      });
  }

  function renderFlowEvent(event: FlowEvent): void {
    switch (event.type) {
      case 'flow/started':
        return;
      case 'node/started':
        process.stdout.write(
          `\n[flow] node ${event.nodeId} -> ${event.connection} (${event.executionId.slice(0, 8)})\n`,
        );
        return;
      case 'node/completed':
        process.stdout.write(`\n[flow] node ${event.nodeId} completed\n`);
        return;
      case 'node/failed':
        process.stdout.write(
          `\n[flow] node ${event.nodeId} ${event.status}` +
            `${event.error === undefined ? '' : `: ${event.error}`}\n`,
        );
        return;
      case 'flow/completed':
        process.stdout.write('\n[flow] completed\n');
        return;
      case 'flow/failed':
        process.stdout.write(`\n[flow] ${event.status}: ${event.error}\n`);
        return;
      case 'flow/cancelled':
        process.stdout.write('\n[flow] cancelled\n');
        return;
    }
  }

  function printFlowStatus(): void {
    if (flowRuntime === undefined) {
      process.stdout.write('no flow has run\n');
      return;
    }
    process.stdout.write(`flow ${flowRuntime.flowId}: ${flowRuntime.status}\n`);
    const result = flowRuntime.result;
    if (result === undefined) {
      return;
    }
    for (const state of Object.values(result.nodes)) {
      if (state.status !== 'pending') {
        process.stdout.write(
          `  ${state.nodeId} ${state.status}` +
            `${state.executionId === undefined ? '' : ` (${state.executionId.slice(0, 8)})`}\n`,
        );
      }
    }
  }

  async function cancelFlow(): Promise<void> {
    if (flowRuntime === undefined || flowRuntime.status !== 'running') {
      process.stdout.write('no running flow\n');
      return;
    }
    await flowRuntime.cancel();
    process.stdout.write('flow cancel requested\n');
  }

  async function startWeb(line: string): Promise<void> {
    if (webServer?.running === true) {
      throw new Error('Web view is already running; use /web stop first');
    }
    const raw = line.slice('/web start'.length).trim();
    const port = raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`Invalid web port: ${raw}`);
    }
    const server = new WebServer(workbench, { port });
    const info = await server.start();
    webServer = server;
    process.stdout.write(`web: ${info.url}\n`);
  }

  async function stopWeb(): Promise<void> {
    if (webServer === undefined) {
      process.stdout.write('web: not running\n');
      return;
    }
    await webServer.stop();
    webServer = undefined;
    process.stdout.write('web: stopped\n');
  }

  function printWeb(): void {
    if (webServer?.url === undefined) {
      process.stdout.write('web: not running\n');
      return;
    }
    process.stdout.write(`web: ${webServer.url}\n`);
  }

  async function transfer(line: string): Promise<void> {
    const parts = line.slice('/transfer '.length).trim().split(/\s+/);
    const [source, executionId, target] = parts;
    if (source === undefined || executionId === undefined || target === undefined) {
      throw new Error(
        'Usage: /transfer <source> <execution-id> <target> [instruction...] [--attach <path>]...',
      );
    }
    const instructionParts: string[] = [];
    const attachPaths: string[] = [];
    for (let index = 3; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === '--attach') {
        const path = parts[index + 1];
        if (path === undefined || path === '') {
          throw new Error('--attach requires a file path');
        }
        attachPaths.push(path);
        index += 1;
      } else if (part !== undefined) {
        instructionParts.push(part);
      }
    }
    const instruction = instructionParts.join(' ');
    const attachments = attachPaths.map(attachmentFromPath);
    const record = await workbench.transfer(
      source,
      executionId,
      target,
      instruction === '' ? undefined : instruction,
      attachments,
    );
    process.stdout.write(
      `transferred ${source}:${executionId.slice(0, 8)} -> ${target}:${record.target.executionId?.slice(0, 8)}` +
        `${attachments.length === 0 ? '' : ` (${String(attachments.length)} attachment(s))`}\n`,
    );
  }
}

function attachmentFromPath(path: string): AttachmentDraft {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`Attachment not found: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Attachment must be a regular file: ${path}`);
  }
  const extension = extname(path).toLowerCase();
  const mimeType =
    extension === '.png'
      ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.webp'
          ? 'image/webp'
          : extension === '.gif'
            ? 'image/gif'
            : 'application/octet-stream';
  return {
    kind: mimeType.startsWith('image/') ? 'image' : 'file',
    path,
    mimeType,
    name: basename(path),
    byteLength: stat.size,
  };
}

function parseDecision(value: string | undefined): ApprovalDecisionKind {  if (value === '1' || value === 'allow') {
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

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`fatal: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}

