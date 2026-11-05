import { createInterface } from 'node:readline/promises';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runDaemon } from './daemon.js';
import type { HarnessAdapter } from './adapters/harness.js';
import {
  CliUsageError,
  apiaryForProject,
  createDefaultAdapter,
  loadCompositionFile,
  messageOf,
  type AdapterRequest,
} from './cli-shared.js';
import type { HarnessKind } from './connection.js';
import { expandHomePath } from './conversation-store.js';
import { WorkspaceForagerExecutor } from './forager.js';
import { HoneyStore } from './honey.js';
import { createKernel } from './kernel.js';
import {
  createMemoryLog,
  PheromoneRuntime,
  type CompositionDefinition,
  type GuardDecision,
  type GuardRequest,
  type HoverSpec,
  type PersistedField,
  type PheromoneFieldSnapshot,
  type RecoveryReport,
  type RuntimeLogEntry,
  type UserNode,
  type Value,
} from './runtime/index.js';
import { Workspace } from './workspace.js';

export { CliUsageError, apiaryForProject };

export interface RunCommand {
  readonly compositionPath: string;
  readonly projectDirectory: string;
  readonly harness: HarnessKind;
  readonly trigger?: string;
  readonly input: string;
  readonly dshRoot?: string;
  readonly codexExe?: string;
  readonly stateDir: string;
  readonly apiary?: string;
  readonly resume: boolean;
}

/** Interactive answer for a hovering user node. */
export type UserAnswerHandler = (node: UserNode, hover: HoverSpec) => Promise<Value>;

export interface CliDependencies {
  /** Test seam: replace the native adapter factory. */
  readonly createAdapter?: (request: AdapterRequest) => Promise<HarnessAdapter>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly askApproval?: (request: GuardRequest) => Promise<GuardDecision>;
  readonly askUser?: UserAnswerHandler;
  /** Set by the foreground process to stop a daemon on SIGINT/SIGTERM. */
  readonly signal?: AbortSignal;
}

const VALUE_FLAGS = new Set([
  '--project',
  '--harness',
  '--trigger',
  '--input',
  '--dsh-root',
  '--codex-exe',
  '--state-dir',
  '--apiary',
]);
const BOOLEAN_FLAGS = new Set(['--resume']);

const DEFAULT_STATE_DIR = '~/.wax';

export function parseRunArgs(argv: readonly string[]): RunCommand {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    throw new CliUsageError(
      'usage: wax run <composition.json> --project <dir> --harness <codex|dsh> ' +
        '[--trigger <node>] [--input <text>] [--resume] [--state-dir <dir>] [--apiary <id>] ' +
        '[--codex-exe <path>]',
    );
  }

  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      if (booleans.has(token)) {
        throw new CliUsageError(`option '${token}' was given more than once`);
      }
      booleans.add(token);
      continue;
    }
    if (token.startsWith('--')) {
      if (!VALUE_FLAGS.has(token)) {
        throw new CliUsageError(`unknown option '${token}'`);
      }
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliUsageError(`option '${token}' needs a value`);
      }
      if (flags.has(token)) {
        throw new CliUsageError(`option '${token}' was given more than once`);
      }
      flags.set(token, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  if (positionals.length !== 1) {
    throw new CliUsageError('expected exactly one composition file after "wax run"');
  }

  const compositionPath = positionals[0] as string;
  const projectDirectory = flags.get('--project');
  if (projectDirectory === undefined) {
    throw new CliUsageError('missing required option --project <dir>');
  }

  const harness = flags.get('--harness');
  if (harness !== 'codex' && harness !== 'dsh') {
    throw new CliUsageError(`--harness must be 'codex' or 'dsh', got '${harness ?? ''}'`);
  }

  const resume = booleans.has('--resume');
  const trigger = flags.get('--trigger');
  if (trigger === undefined && !resume) {
    throw new CliUsageError('missing required option --trigger <node> (or pass --resume)');
  }

  const dshRoot = flags.get('--dsh-root');
  const codexExe = flags.get('--codex-exe');
  const apiary = flags.get('--apiary');

  return {
    compositionPath,
    projectDirectory,
    harness,
    ...(trigger === undefined ? {} : { trigger }),
    input: flags.get('--input') ?? '',
    ...(dshRoot === undefined ? {} : { dshRoot }),
    ...(codexExe === undefined ? {} : { codexExe }),
    stateDir: flags.get('--state-dir') ?? DEFAULT_STATE_DIR,
    ...(apiary === undefined ? {} : { apiary }),
    resume,
  };
}

function validateTrigger(definition: CompositionDefinition, trigger: string): void {
  const node = definition.nodes.get(trigger);
  if (node === undefined) {
    throw new CliUsageError(`unknown trigger node '${trigger}'`);
  }
  if (node.kind !== 'forager' && node.kind !== 'worker' && node.kind !== 'user') {
    throw new CliUsageError(
      `trigger target '${trigger}' must be a forager, worker or user node, got '${node.kind}'`,
    );
  }
}

function fallbackDecision(request: GuardRequest): GuardDecision {
  return request.options.includes('reject_once') ? 'reject_once' : 'cancelled';
}

/**
 * Interactive approval for the one-shot CLI. A non-interactive stdin never
 * allows: it falls back to rejecting (or cancelling) so a piped run cannot
 * grant permissions by accident.
 */
async function askApprovalInteractively(request: GuardRequest): Promise<GuardDecision> {
  if (process.stdin.isTTY !== true) {
    return fallbackDecision(request);
  }

  const offered = request.options.filter(
    (option) => option === 'allow_once' || option === 'reject_once',
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`approval required: ${request.summary}\n`);
    offered.forEach((option, index) => {
      process.stderr.write(`  ${String(index + 1)}. ${option}\n`);
    });
    process.stderr.write(`  ${String(offered.length + 1)}. cancel\n`);
    const answer = (await rl.question(`choose [1-${String(offered.length + 1)}]: `)).trim();
    const index = Number(answer) - 1;
    const chosen = Number.isInteger(index) ? offered[index] : undefined;
    if (chosen === 'allow_once' || chosen === 'reject_once') {
      return chosen;
    }
    return 'cancelled';
  } catch {
    return fallbackDecision(request);
  } finally {
    rl.close();
  }
}

/**
 * Converts one interactive answer to the Value required by the node's modality.
 * Exported for tests: path checks are CLI behavior, and the runtime stays
 * filesystem-free.
 */
export function parseUserAnswer(node: UserNode, answer: string): Value {
  if (node.config.modality === 'yes-no') {
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'y' || normalized === 'yes' || normalized === 'true') {
      return { kind: 'boolean', value: true };
    }
    if (normalized === 'n' || normalized === 'no' || normalized === 'false') {
      return { kind: 'boolean', value: false };
    }
    throw new CliUsageError(`expected y or n, got '${answer}'`);
  }

  if (node.config.modality === 'choice') {
    const choices = node.config.choices ?? [];
    const index = Number(answer.trim());
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      const choice = choices[index - 1];
      if (choice !== undefined) {
        return { kind: 'choice', choice };
      }
    }
    if (choices.includes(answer.trim())) {
      return { kind: 'choice', choice: answer.trim() };
    }
    throw new CliUsageError(`expected one of: ${choices.join(', ')}`);
  }

  if (node.config.modality === 'message') {
    if (answer.trim() === '') {
      throw new CliUsageError(`user node '${node.id}' needs a non-empty message`);
    }
    return { kind: 'message', text: answer, attachments: [] };
  }

  if (node.config.modality === 'image' || node.config.modality === 'file') {
    const path = resolveAttachmentPath(node, node.config.modality, answer);
    return { kind: 'attachments', attachments: [{ kind: node.config.modality, path }] };
  }

  return { kind: 'text', text: answer };
}

/**
 * Resolves one local attachment path: expands a leading `~`, requires an
 * existing regular file, and returns the absolute path. The path is a
 * reference only; nothing is copied, previewed or scanned.
 */
function resolveAttachmentPath(
  node: UserNode,
  modality: 'image' | 'file',
  answer: string,
): string {
  const trimmed = answer.trim();
  if (trimmed === '') {
    throw new CliUsageError(`user node '${node.id}' expects a local ${modality} path`);
  }
  const absolute = resolve(expandHomePath(trimmed));
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliUsageError(`attachment path does not exist: '${absolute}'`);
    }
    throw new CliUsageError(
      `attachment path cannot be read: '${absolute}' (${messageOf(error)})`,
    );
  }
  if (!stats.isFile()) {
    throw new CliUsageError(`attachment path is not a regular file: '${absolute}'`);
  }
  return absolute;
}

async function askUserInteractively(node: UserNode, hover: HoverSpec): Promise<Value> {
  if (process.stdin.isTTY !== true) {
    throw new Error(
      `user node '${node.id}' is waiting for input, but stdin is not interactive (hover ${hover.token})`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const choices = node.config.choices ?? [];
    const options =
      node.config.modality === 'choice'
        ? ` [${choices.map((choice, index) => `${String(index + 1)}=${choice}`).join(' ')}]`
        : node.config.modality === 'yes-no'
          ? ' [y/n]'
          : node.config.modality === 'image' || node.config.modality === 'file'
            ? ' [path]'
            : '';
    const answer = await rl.question(`${node.config.prompt}${options} `);
    return parseUserAnswer(node, answer);
  } finally {
    rl.close();
  }
}

interface Hovered {
  readonly node: UserNode;
  readonly hover: HoverSpec;
}

function firstHover(
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
): Hovered | undefined {
  for (const [id, state] of definition.nodes) {
    if (state.kind !== 'user') {
      continue;
    }
    const hover = snapshot.nodes[id]?.hover;
    if (hover !== undefined) {
      return { node: state, hover };
    }
  }
  return undefined;
}

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  if (argv[0] === 'daemon') {
    return runDaemon(argv, deps);
  }

  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let command: RunCommand;
  let definition: CompositionDefinition;
  let store: HoneyStore;
  let persisted: PersistedField | undefined;

  try {
    command = parseRunArgs(argv);
    if (command.harness === 'dsh' && command.dshRoot === undefined) {
      throw new CliUsageError('--harness dsh requires --dsh-root <path>');
    }
    if (command.harness === 'dsh' && command.codexExe !== undefined) {
      throw new CliUsageError('--codex-exe only applies to --harness codex');
    }
    definition = loadCompositionFile(command.compositionPath);
    if (command.trigger !== undefined) {
      validateTrigger(definition, command.trigger);
    }
    if (command.harness === 'dsh') {
      throw new CliUsageError('the dsh bridge is not wired in Stage 2A; run with --harness codex');
    }

    const apiary = command.apiary ?? apiaryForProject(command.projectDirectory);
    try {
      store = HoneyStore.forComposition(command.stateDir, apiary, definition.id);
    } catch (error) {
      throw new CliUsageError(messageOf(error));
    }
    if (command.resume) {
      persisted = store.load();
      if (persisted === undefined) {
        throw new CliUsageError(`nothing to resume at ${store.paths.field}`);
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    throw error;
  }

  const createAdapter = deps.createAdapter ?? createDefaultAdapter;
  let adapter: HarnessAdapter;
  try {
    adapter = await createAdapter(
      command.codexExe === undefined
        ? { harness: command.harness }
        : { harness: command.harness, executable: command.codexExe },
    );
    await adapter.start();
  } catch (error) {
    err(`error: ${messageOf(error)}`);
    return 1;
  }

  const workspace = new Workspace(adapter);
  const log = createMemoryLog();
  const transcript: Record<string, unknown>[] = [];
  const askUser = deps.askUser ?? askUserInteractively;
  let conversationId: string | undefined;
  let forager: WorkspaceForagerExecutor | undefined;
  let runtime: PheromoneRuntime | undefined;
  let report: RecoveryReport | undefined;
  let code = 0;
  let flushedCount = 0;

  const unsubscribeTranscript = workspace.onEvent((event) => {
    const at = new Date().toISOString();
    if (event.type === 'execution/output') {
      if (event.channel === 'assistant') {
        transcript.push({ at, type: 'output', executionId: event.executionId, text: event.text });
      }
      return;
    }
    if (event.type === 'execution/tool') {
      transcript.push({
        at,
        type: 'tool',
        executionId: event.executionId,
        toolCallId: event.toolCallId,
        title: event.title,
        status: event.status,
      });
      return;
    }
    if (event.type === 'execution/approval-requested') {
      transcript.push({
        at,
        type: 'approval-requested',
        executionId: event.executionId,
        requestId: event.request.requestId,
        summary: event.request.summary,
      });
      return;
    }
    if (event.type === 'execution/state') {
      transcript.push({ at, type: 'state', executionId: event.executionId, state: event.state });
    }
  });

  const flush = (): void => {
    if (runtime === undefined) {
      return;
    }
    store.save(runtime.exportField());
    const transcriptRef =
      conversationId === undefined ? undefined : store.transcriptPath(conversationId);
    store.appendLog(
      log.entries
        .slice(flushedCount)
        .map((entry) => (transcriptRef === undefined ? entry : { ...entry, transcriptRef })),
    );
    flushedCount = log.entries.length;
    if (conversationId !== undefined) {
      store.appendTranscript(conversationId, transcript.splice(0));
    }
  };

  try {
    const project = createKernel().registerProject(command.projectDirectory);
    const conversation = await workspace.createConversation(project);
    conversationId = conversation.id;
    forager = new WorkspaceForagerExecutor({ workspace, conversation });

    const options = {
      executeForager: forager,
      projectDirectory: project.directory,
      onLog: log.sink,
      onGuard: deps.askApproval ?? askApprovalInteractively,
    };

    if (persisted !== undefined) {
      const restored = PheromoneRuntime.restore(definition, persisted, options);
      runtime = restored.runtime;
      report = restored.report;
    } else {
      runtime = new PheromoneRuntime(definition, options);
    }

    if (command.trigger !== undefined) {
      runtime.trigger(command.trigger, { kind: 'text', text: command.input });
    }

    for (;;) {
      await runtime.pump();
      flush();
      const hovered = firstHover(definition, runtime.snapshot());
      if (hovered === undefined) {
        break;
      }
      const value = await askUser(hovered.node, hovered.hover);
      runtime.answerHover(hovered.node.id, value, hovered.hover.token);
      flush();
    }
  } catch (error) {
    code = 1;
    err(`error: ${messageOf(error)}`);
  } finally {
    try {
      flush();
    } catch (error) {
      err(`error: could not persist the field: ${messageOf(error)}`);
      code = 1;
    }
    printSummary(out, definition, runtime?.snapshot(), log.entries, forager?.lastOutput, report);
    unsubscribeTranscript();
    forager?.dispose();
    await workspace.stop().catch(() => undefined);
  }

  return code;
}

function printSummary(
  out: (line: string) => void,
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot | undefined,
  entries: readonly RuntimeLogEntry[],
  output: { readonly kind: string; readonly text?: string } | undefined,
  report: RecoveryReport | undefined,
): void {
  out(`composition  ${definition.id}`);
  out(`revision     ${definition.graphRevision}`);
  out(`rest         ${String(snapshot?.rest ?? true)}`);

  for (const [id, node] of definition.nodes) {
    const state = snapshot?.nodes[id];
    const count = state?.state['count'];
    out(
      `node         ${id} kind=${node.kind} queue=${String(state?.queue.length ?? 0)} ` +
        `pending=${state?.pending === undefined ? 'no' : 'yes'} ` +
        `active=${state?.active === undefined ? 'no' : 'yes'}` +
        ` hover=${state?.hover === undefined ? 'no' : 'yes'}` +
        (typeof count === 'number' ? ` count=${String(count)}` : ''),
    );
  }

  if (report !== undefined) {
    out(
      `recovered    hovers=${report.resumedHovers.join(',') || '-'} ` +
        `unknown=${report.unknownActive.join(',') || '-'} stuck=${report.stuckActive.join(',') || '-'}`,
    );
  }

  const events = [...new Set(entries.map((entry) => entry.event))];
  out(`log          ${String(entries.length)} events (${events.join(', ')})`);
  out(`output       ${output?.kind === 'text' ? (output.text ?? '') : ''}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const argv = process.argv.slice(2);
  const isDaemon = argv[0] === 'daemon';
  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  if (isDaemon) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  void runCli(argv, isDaemon ? { signal: controller.signal } : {})
    .then((code) => {
      process.exitCode = code;
    })
    .finally(() => {
      if (isDaemon) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    });
}
