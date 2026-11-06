import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { runAnswerCli } from './answer-cli.js';
import { runDaemon } from './daemon.js';
import type { HarnessAdapter } from './adapters/harness.js';
import { runCompositionCli } from './composition-cli.js';
import {
  CliUsageError,
  apiaryForProject,
  createDefaultAdapter,
  loadCompositionFile,
  messageOf,
  selectHarness,
  sessionDisplayName,
  type AdapterRequest,
} from './cli-shared.js';
import type { HarnessKind } from './connection.js';
import { WorkspaceForagerExecutor } from './forager.js';
import { HoneyStore } from './honey.js';
import { createKernel } from './kernel.js';
import { runMcpCommand } from './mcp-server.js';
import {
  createMemoryLog,
  PheromoneRuntime,
  QUEUE_RETRY_MS,
  QueueFullError,
  type CompositionDefinition,
  type GuardDecision,
  type GuardRequest,
  type HoverSpec,
  type NodeId,
  type PersistedField,
  type PheromoneFieldSnapshot,
  type RecoveryReport,
  type RuntimeLogEntry,
  type UserNode,
  type Value,
} from './runtime/index.js';
import { Workspace } from './workspace.js';
import { parseUserAnswer } from './user-answer.js';

export { CliUsageError, apiaryForProject, parseUserAnswer };

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
  /** Opt-in `wax_composition` MCP server for the selected harness. */
  readonly compositionTools: boolean;
}

/** Interactive answer for a hovering user node. */
export type UserAnswerHandler = (node: UserNode, hover: HoverSpec) => Promise<Value>;

export interface CliDependencies {
  /** Test seam: replace the native adapter factory. */
  readonly createAdapter?: (request: AdapterRequest) => Promise<HarnessAdapter>;
  /** Test seam: environment used to resolve DSH_ROOT. */
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly askApproval?: (request: GuardRequest) => Promise<GuardDecision>;
  readonly askUser?: UserAnswerHandler;
  /** Test seam: clock for runtime deadlines and the nextWakeAt wait. */
  readonly now?: () => number;
  /** Test seam: replaces the setTimeout wait for the next Merge deadline. */
  readonly sleep?: (ms: number) => Promise<void>;
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
const BOOLEAN_FLAGS = new Set(['--resume', '--composition-tools']);

const DEFAULT_STATE_DIR = '~/.wax';

/**
 * Waits for one Merge deadline. A pending timer intentionally keeps the
 * process alive: `wax run` must not exit while a join is still waiting.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parseRunArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunCommand {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    throw new CliUsageError(
      'usage: wax run <composition.json> --project <dir> --harness <codex|dsh> ' +
        '[--trigger <node>] [--input <text>] [--resume] [--composition-tools] ' +
        '[--state-dir <dir>] [--apiary <id>] ' +
        '[--codex-exe <path>] [--dsh-root <path>]',
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

  const resume = booleans.has('--resume');
  const trigger = flags.get('--trigger');
  if (trigger === undefined && !resume) {
    throw new CliUsageError('missing required option --trigger <node> (or pass --resume)');
  }

  const dshRootFlag = flags.get('--dsh-root');
  const codexExe = flags.get('--codex-exe');
  const selection = selectHarness(
    flags.get('--harness'),
    {
      ...(dshRootFlag === undefined ? {} : { dshRoot: dshRootFlag }),
      ...(codexExe === undefined ? {} : { codexExe }),
    },
    env,
  );
  const apiary = flags.get('--apiary');

  return {
    compositionPath,
    projectDirectory,
    harness: selection.harness,
    ...(trigger === undefined ? {} : { trigger }),
    input: flags.get('--input') ?? '',
    ...(selection.dshRoot === undefined ? {} : { dshRoot: selection.dshRoot }),
    ...(selection.codexExe === undefined ? {} : { codexExe: selection.codexExe }),
    stateDir: flags.get('--state-dir') ?? DEFAULT_STATE_DIR,
    ...(apiary === undefined ? {} : { apiary }),
    resume,
    compositionTools: booleans.has('--composition-tools'),
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
  excludeNodeIds?: ReadonlySet<NodeId>,
): Hovered | undefined {
  for (const [id, state] of definition.nodes) {
    if (state.kind !== 'user' || excludeNodeIds?.has(id) === true) {
      continue;
    }
    const hover = snapshot.nodes[id]?.hover;
    if (hover !== undefined) {
      return { node: state, hover };
    }
  }
  return undefined;
}

/**
 * The earliest instant a rate-limited `pending` Pheromone becomes runnable.
 *
 * A Merge deadline is not the only timed wake: a branch already queued at a
 * node is held by `minIntervalMs`. Sleeping only to `nextWakeAt()` would miss
 * that activation and could time out a branch that arrived before the deadline.
 */
function nextPendingAt(
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  let next: number | undefined;
  for (const [id, node] of definition.nodes) {
    const state = snapshot.nodes[id];
    if (state?.pending === undefined) {
      continue;
    }
    const last = state.lastActivatedAt;
    const due = last === undefined ? 0 : Date.parse(last) + node.minIntervalMs;
    if (!Number.isFinite(due)) {
      continue;
    }
    if (next === undefined || due < next) {
      next = due;
    }
  }
  return next;
}

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  if (argv[0] === 'mcp') {
    return runMcpCommand(argv);
  }
  if (argv[0] === 'answer') {
    return runAnswerCli(argv, deps);
  }
  if (argv[0] === 'composition') {
    return runCompositionCli(argv, deps);
  }
  if (argv[0] === 'daemon') {
    return runDaemon(argv, deps);
  }

  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  let command: RunCommand;
  let definition: CompositionDefinition;
  let store: HoneyStore;
  let apiary = '';
  let persisted: PersistedField | undefined;

  try {
    command = parseRunArgs(argv, deps.env);
    definition = loadCompositionFile(command.compositionPath);
    if (command.trigger !== undefined) {
      validateTrigger(definition, command.trigger);
    }

    apiary = command.apiary ?? apiaryForProject(command.projectDirectory);
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
  const request: AdapterRequest = {
    harness: command.harness,
    ...(command.codexExe === undefined ? {} : { executable: command.codexExe }),
    ...(command.dshRoot === undefined ? {} : { dshRoot: command.dshRoot }),
    ...(command.compositionTools ? { compositionTools: true } : {}),
  };
  let adapter: HarnessAdapter;
  try {
    adapter = await createAdapter(request);
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
    const conversation = await workspace.createConversation(project, {
      displayName: sessionDisplayName(apiary, definition.id),
    });
    conversationId = conversation.id;
    forager = new WorkspaceForagerExecutor({ workspace, conversation });

    const options = {
      executeForager: forager,
      projectDirectory: project.directory,
      onLog: log.sink,
      onGuard: deps.askApproval ?? askApprovalInteractively,
      now,
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

    const activeRuntime = runtime;
    interface PendingAnswer {
      readonly node: UserNode;
      readonly token: string;
      readonly value: Value;
    }
    /**
     * Answers already typed but not yet accepted because the downstream queue
     * was full. They are kept here (and their hovers stay open) and retried
     * before any new question is asked, so a typed answer is never dropped.
     */
    let pendingAnswers: PendingAnswer[] = [];
    let announcedBackpressure = false;

    const blockedNodeIds = (): Set<NodeId> =>
      new Set(pendingAnswers.map((answer) => answer.node.id));

    const announceBackpressure = (error: QueueFullError): void => {
      if (announcedBackpressure) {
        return;
      }
      announcedBackpressure = true;
      err(
        `backpressure: target queue '${error.nodeId}' is full; ` +
          'the answer is kept and will be retried when it has room',
      );
    };

    /** Retries every preserved answer; returns true when at least one applied. */
    const deliverPendingAnswers = (): boolean => {
      if (pendingAnswers.length === 0) {
        return false;
      }
      const remaining: PendingAnswer[] = [];
      let delivered = false;
      for (const answer of pendingAnswers) {
        try {
          activeRuntime.answerHover(answer.node.id, answer.value, answer.token);
          delivered = true;
        } catch (error) {
          if (!(error instanceof QueueFullError)) {
            throw error;
          }
          remaining.push(answer);
          announceBackpressure(error);
        }
      }
      pendingAnswers = remaining;
      if (delivered) {
        announcedBackpressure = false;
        flush();
      }
      return delivered;
    };

    for (;;) {
      await activeRuntime.pump();
      flush();
      if (deliverPendingAnswers()) {
        continue;
      }

      // Do not ask the same node twice; its previous answer is still pending.
      const hovered = firstHover(definition, activeRuntime.snapshot(), blockedNodeIds());
      if (hovered !== undefined) {
        const value = await askUser(hovered.node, hovered.hover);
        const answer: PendingAnswer = {
          node: hovered.node,
          token: hovered.hover.token,
          value,
        };
        try {
          activeRuntime.answerHover(answer.node.id, answer.value, answer.token);
          announcedBackpressure = false;
          flush();
        } catch (error) {
          if (!(error instanceof QueueFullError)) {
            throw error;
          }
          pendingAnswers.push(answer);
          announceBackpressure(error);
        }
        continue;
      }

      const snapshot = activeRuntime.snapshot();
      if (snapshot.rest && pendingAnswers.length === 0) {
        break;
      }
      // No hover to service. A Merge that is waiting out its deadline is not
      // Rest, but pump has nothing to activate: sleep until the earliest
      // deadline (or a pending rate-limited branch), then check the field
      // again. A blocked answer or activation adds a short retry instant so
      // the loop never spins at 0ms.
      const times = [
        activeRuntime.nextWakeAt(),
        nextPendingAt(definition, snapshot),
        ...(pendingAnswers.length === 0 ? [] : [now() + QUEUE_RETRY_MS]),
      ].filter((value): value is number => value !== undefined);
      if (times.length === 0) {
        break;
      }
      // A blocked activation can leave its own pending due instant in the
      // past while `nextWakeAt()` asks for QUEUE_RETRY_MS. Taking the raw
      // minimum would then sleep 0ms and spin; a non-positive wait means
      // backpressure is the only reason we are still here.
      const due = Math.min(...times);
      const current = now();
      await sleep(due > current ? due - current : QUEUE_RETRY_MS);
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
