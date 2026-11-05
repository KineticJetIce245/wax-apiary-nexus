import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { HarnessAdapter } from './adapters/harness.js';
import {
  CliUsageError,
  apiaryForProject,
  createDefaultAdapter,
  loadCompositionFile,
  messageOf,
  type AdapterRequest,
} from './cli-shared.js';
import { DaemonLock, DaemonLockError } from './daemon-lock.js';
import { WorkspaceForagerExecutor } from './forager.js';
import { HoneyStore } from './honey.js';
import { createKernel } from './kernel.js';
import {
  createMemoryLog,
  PheromoneRuntime,
  type CompositionDefinition,
  type GuardDecision,
  type GuardRequest,
  type RecoveryReport,
  type TriggerDefinition,
} from './runtime/index.js';
import { Scheduler, type SchedulerTimers } from './scheduler.js';
import { Workspace } from './workspace.js';

export interface DaemonCommand {
  readonly compositionPath: string;
  readonly projectDirectory: string;
  readonly harness: 'codex';
  readonly stateDir: string;
  readonly apiary?: string;
  readonly codexExe?: string;
}

export interface DaemonDependencies {
  /** Test seam: replace the native adapter factory. */
  readonly createAdapter?: (request: AdapterRequest) => Promise<HarnessAdapter>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly now?: () => number;
  readonly timers?: SchedulerTimers;
  /** The foreground CLI aborts this on SIGINT/SIGTERM. */
  readonly signal?: AbortSignal;
}

const VALUE_FLAGS = new Set([
  '--project',
  '--harness',
  '--codex-exe',
  '--state-dir',
  '--apiary',
]);

const DEFAULT_STATE_DIR = '~/.wax';
const DAEMON_USAGE =
  'usage: wax daemon <composition.json> --project <dir> --harness codex ' +
  '[--state-dir <dir>] [--apiary <id>] [--codex-exe <path>]';

export function parseDaemonArgs(argv: readonly string[]): DaemonCommand {
  const [command, ...rest] = argv;
  if (command !== 'daemon') {
    throw new CliUsageError(DAEMON_USAGE);
  }

  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
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
    throw new CliUsageError('expected exactly one composition file after "wax daemon"');
  }

  const compositionPath = positionals[0] as string;
  const projectDirectory = flags.get('--project');
  if (projectDirectory === undefined) {
    throw new CliUsageError('missing required option --project <dir>');
  }

  const harness = flags.get('--harness');
  if (harness === undefined) {
    throw new CliUsageError('missing required option --harness codex');
  }
  if (harness !== 'codex') {
    throw new CliUsageError(
      `--harness must be 'codex', got '${harness}' (the dsh bridge is not wired)`,
    );
  }

  const apiary = flags.get('--apiary');
  const codexExe = flags.get('--codex-exe');
  return {
    compositionPath,
    projectDirectory,
    harness,
    stateDir: flags.get('--state-dir') ?? DEFAULT_STATE_DIR,
    ...(apiary === undefined ? {} : { apiary }),
    ...(codexExe === undefined ? {} : { codexExe }),
  };
}

/**
 * Runs one composition's scheduled triggers in the foreground.
 *
 * One process, one composition, one lock. The scheduler records an occurrence
 * before the runtime is asked to enqueue it, so a crash can lose at most that
 * occurrence and can never duplicate it. Approvals are rejected without a TTY;
 * there is no Guard inbox in 3C-1.
 */
export async function runDaemon(
  argv: readonly string[],
  deps: DaemonDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let command: DaemonCommand;
  let definition: CompositionDefinition;
  let store: HoneyStore;
  let apiary: string;
  try {
    command = parseDaemonArgs(argv);
    definition = loadCompositionFile(command.compositionPath);
    if (definition.triggers.length === 0) {
      throw new CliUsageError(
        `composition '${definition.id}' has no scheduled triggers; add a triggers array`,
      );
    }

    apiary = command.apiary ?? apiaryForProject(command.projectDirectory);
    try {
      store = HoneyStore.forComposition(command.stateDir, apiary, definition.id);
    } catch (error) {
      throw new CliUsageError(messageOf(error));
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    throw error;
  }

  const lockPath = join(store.paths.directory, 'daemon.lock');
  let lock: DaemonLock;
  try {
    mkdirSync(store.paths.directory, { recursive: true });
    lock = DaemonLock.acquire(lockPath, definition.id);
  } catch (error) {
    if (error instanceof DaemonLockError) {
      err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const log = createMemoryLog();
  const transcript: Record<string, unknown>[] = [];
  let flushedCount = 0;
  let conversationId: string | undefined;

  let adapter: HarnessAdapter | undefined;
  let workspace: Workspace | undefined;
  let forager: WorkspaceForagerExecutor | undefined;
  let runtime: PheromoneRuntime | undefined;
  let scheduler: Scheduler | undefined;
  let unsubscribeTranscript: (() => void) | undefined;
  let report: RecoveryReport | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  let stopping = false;
  let pumping = false;
  let triggerPending = false;
  let pumpTask: Promise<void> | undefined;
  let resolveStop: (() => void) | undefined;
  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  if (deps.signal?.aborted === true) {
    resolveStop?.();
  } else {
    deps.signal?.addEventListener('abort', () => resolveStop?.(), { once: true });
  }

  const safeFlush = (): void => {
    try {
      flush();
    } catch (error) {
      err(`error: could not persist Honey state: ${messageOf(error)}`);
    }
  };

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

  const rejectGuard = async (request: GuardRequest): Promise<GuardDecision> => {
    // A daemon has no interactive TTY. The runtime records guard.opened and the
    // resolved rejection in the metadata log; nothing is ever auto-allowed.
    return request.options.includes('reject_once') ? 'reject_once' : 'cancelled';
  };

  async function shutdown(reason: string): Promise<void> {
    resolveStop?.();
    if (stopping) {
      return;
    }
    stopping = true;
    scheduler?.stop();
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }

    try {
      await workspace?.stop();
    } catch (error) {
      err(`error: could not stop the workspace: ${messageOf(error)}`);
    }

    if (pumpTask !== undefined) {
      try {
        await pumpTask;
      } catch (error) {
        err(`error: while stopping: ${messageOf(error)}`);
      }
    }

    safeFlush();
    try {
      forager?.dispose();
    } catch {
      // Disposal only detaches listeners; ignore a late failure on shutdown.
    }
    unsubscribeTranscript?.();
    out(`daemon stopped (${reason})`);
  }

  let code = 0;
  try {
    const persisted = store.load();
    const schedulerState = store.loadScheduler();

    const project = createKernel().registerProject(command.projectDirectory);
    const createAdapter = deps.createAdapter ?? createDefaultAdapter;
    adapter = await createAdapter(
      command.codexExe === undefined
        ? { harness: command.harness }
        : { harness: command.harness, executable: command.codexExe },
    );
    await adapter.start();

    workspace = new Workspace(adapter);
    const conversation = await workspace.createConversation(project);
    conversationId = conversation.id;
    forager = new WorkspaceForagerExecutor({ workspace, conversation });
    unsubscribeTranscript = workspace.onEvent((event) => {
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

    const options = {
      executeForager: forager,
      projectDirectory: project.directory,
      onLog: log.sink,
      onGuard: rejectGuard,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    };

    if (persisted !== undefined) {
      const restored = PheromoneRuntime.restore(definition, persisted, options);
      runtime = restored.runtime;
      report = restored.report;
    } else {
      runtime = new PheromoneRuntime(definition, options);
    }
    const activeRuntime = runtime;

    const requestPump = (): void => {
      if (stopping) {
        return;
      }
      triggerPending = true;
      if (pumping) {
        return;
      }
      pumping = true;
      pumpTask = (async () => {
        try {
          do {
            triggerPending = false;
            const entriesBefore = log.entries.length;
            try {
              await activeRuntime.pump();
            } catch (error) {
              err(`error: trigger activation failed: ${messageOf(error)}`);
            }
            // An idle pump changes nothing; avoid rewriting Honey on every
            // heartbeat.
            if (log.entries.length !== entriesBefore) {
              safeFlush();
            }
          } while (triggerPending && !stopping);
        } finally {
          pumping = false;
        }
      })();
    };

    const onTrigger = (trigger: TriggerDefinition): void => {
      if (stopping) {
        return;
      }
      try {
        // Scheduled triggers carry no input in 3C-1; richer input is 3C-2.
        activeRuntime.trigger(trigger.target, { kind: 'text', text: '' });
      } catch (error) {
        err(`error: scheduled trigger '${trigger.id}' could not enqueue: ${messageOf(error)}`);
        return;
      }
      requestPump();
    };

    scheduler = new Scheduler({
      triggers: definition.triggers,
      ...(schedulerState === undefined ? {} : { state: schedulerState }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.timers === undefined ? {} : { timers: deps.timers }),
      persist: (state) => store.saveScheduler(state),
      onTrigger,
      onError: (error, trigger) => {
        if (trigger === undefined) {
          // A durable scheduler write failed; stop rather than risk duplicate
          // occurrences after a restart.
          err(`error: scheduler: ${messageOf(error)}`);
          code = 1;
          void shutdown('scheduler-error');
          return;
        }
        err(`error: scheduled trigger '${trigger.id}': ${messageOf(error)}`);
      },
    });

    scheduler.start();
    // A restored field can already hold queued Pheromones even when no trigger
    // is due. Pump them once; restored active side effects are never replayed.
    requestPump();
    safeFlush();

    out(
      `daemon started composition=${definition.id} apiary=${apiary} ` +
        `triggers=${String(definition.triggers.length)}`,
    );
    out(`lock         ${lockPath}`);
    if (report !== undefined) {
      out(
        `recovered    hovers=${report.resumedHovers.join(',') || '-'} ` +
          `unknown=${report.unknownActive.join(',') || '-'} stuck=${report.stuckActive.join(',') || '-'}`,
      );
    }

    // The runtime leaves a rate-limited Pheromone in `pending` until another
    // pump happens. A small heartbeat wakes it, and also keeps the foreground
    // daemon alive when no scheduled trigger has a future timer.
    heartbeat = setInterval(() => requestPump(), 500);
    await stopPromise;
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      code = 2;
    } else {
      err(`error: ${messageOf(error)}`);
      code = 1;
    }
  } finally {
    try {
      await shutdown('exit');
    } catch (error) {
      err(`error: daemon shutdown failed: ${messageOf(error)}`);
      if (code === 0) {
        code = 1;
      }
    }
    try {
      lock.release();
    } catch (error) {
      err(`error: could not release daemon lock: ${messageOf(error)}`);
      if (code === 0) {
        code = 1;
      }
    }
  }

  return code;
}
