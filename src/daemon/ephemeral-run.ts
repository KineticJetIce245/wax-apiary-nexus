import type { HarnessAdapter } from '../adapters/harness.js';
import { HoneyStore } from '../storage/honey.js';
import type { GraphBindings } from '../graph/binding.js';
import type { Project } from '../project/kernel.js';
import {
  GraphHost,
  type GraphRunResult,
  type GraphStatus,
} from './graph-host.js';
import type {
  CompositionDefinition,
  GuardDecision,
  GuardRequest,
  HoverSpec,
  NodeId,
  RecoveryReport,
  UserNode,
  Value,
} from '../runtime/index.js';
import { SessionRegistry } from '../session/session-registry.js';
import { Workspace } from '../session/workspace.js';

/** Why the ephemeral b-core path cannot run this composition. */
export type EphemeralRunUnsupportedReason =
  | 'empty-graph-id'
  | 'user-node'
  | 'trigger'
  | 'missing-binding'
  | 'resume';

/**
 * A graph or run the headless b-core runner deliberately cannot execute. The
 * message carries ids only: it never contains a prompt, output, approval body,
 * input value or hover token.
 *
 * The CLI translates this into exit code 2 (usage) when it is raised before
 * the adapter starts (`empty-graph-id`, `trigger`, `missing-binding`, `resume`)
 * or after it starts for `user-node`, when a user hover arrives without an
 * `askUser` handler.
 */
export class EphemeralRunUnsupportedError extends Error {
  constructor(
    readonly reason: EphemeralRunUnsupportedReason,
    message: string,
  ) {
    super(message);
    this.name = 'EphemeralRunUnsupportedError';
  }
}

/**
 * Hard cap on consecutive user hovers answered by one ephemeral run. A graph
 * that keeps re-hovering without external progress would otherwise spin
 * forever; the run fails instead of guessing another answer.
 */
const MAX_USER_HOVERS = 16;

export interface EphemeralRunOptions {
  readonly adapter: HarnessAdapter;
  readonly definition: CompositionDefinition;
  readonly project: Project;
  readonly bindings: GraphBindings;
  readonly trigger?: string;
  /**
   * Restore the persisted Honey field before running. A missing field is a
   * typed `resume` failure before the adapter starts; with a field, the run
   * drains the restored work (or triggers again when `trigger` is given)
   * instead of starting from an empty field.
   */
  readonly resume?: boolean;
  readonly input: string;
  readonly stateRoot: string;
  readonly apiary: string;
  /**
   * Harness name recorded on the ephemeral sessions. Adapters do not expose a
   * kind, so the CLI passes its selection; the default is a stable placeholder.
   */
  readonly harness?: string;
  /**
   * Interactive answer for a hovering user node. Without it a user hover is a
   * typed unsupported failure: the run never supplies an empty default answer.
   */
  readonly askUser?: (node: UserNode, hover: HoverSpec) => Promise<Value>;
  /**
   * Native approval handler. Without it the runtime rejects a Guard request;
   * an approval is never allowed automatically.
   */
  readonly onGuard?: (request: GuardRequest) => Promise<GuardDecision>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxWaitMs?: number;
}

export interface EphemeralRunResult {
  readonly status: GraphStatus;
  readonly run: GraphRunResult;
  readonly outputs: ReadonlyMap<NodeId, Value>;
  readonly persisted: boolean;
  /**
   * What the restored Honey field could not keep running. Present only for a
   * resume; it carries node ids, never a prompt, output or Pheromone body.
   */
  readonly recovery?: RecoveryReport;
}

/**
 * Refuse a graph the headless runner cannot faithfully execute at all: a graph
 * without an id, or a trigger that is unknown or cannot start a run. A user
 * node is supported (it is answered through `askUser`), so it is not rejected
 * here. Runs before the adapter starts, so a usage rejection spawns nothing.
 */
export function assertEphemeralGraphSupported(
  definition: CompositionDefinition,
  trigger?: string,
): void {
  if (definition.id.trim() === '') {
    throw new EphemeralRunUnsupportedError(
      'empty-graph-id',
      'b-core run requires a composition with a non-empty graph id',
    );
  }
  if (trigger === undefined) {
    return;
  }
  const node = definition.nodes.get(trigger);
  if (node === undefined) {
    throw new EphemeralRunUnsupportedError(
      'trigger',
      `unknown trigger node '${trigger}'`,
    );
  }
  if (node.kind !== 'forager' && node.kind !== 'worker' && node.kind !== 'user') {
    throw new EphemeralRunUnsupportedError(
      'trigger',
      `b-core trigger target '${trigger}' must be a forager, worker or user node, got '${node.kind}'`,
    );
  }
}

function assertBindings(
  definition: CompositionDefinition,
  bindings: GraphBindings,
): void {
  for (const node of definition.nodes.values()) {
    if (node.kind !== 'forager') {
      continue;
    }
    if (bindings[node.id] === undefined) {
      throw new EphemeralRunUnsupportedError(
        'missing-binding',
        `forager '${node.id}' has no session binding`,
      );
    }
  }
}

/**
 * One-shot headless b-core run.
 *
 * The adapter is started and stopped by this function; sessions are created
 * for this run only and closed afterwards. A normal run starts from a fresh
 * field (`restoreHoney: false`) and every mutation is flushed to Honey, so a
 * later run can restore what this run left behind. With `resume: true` the
 * persisted field is restored instead: the run either drains the existing
 * pending/queued work or triggers again when a trigger is supplied. There is
 * no session store and no scheduling.
 *
 * A user hover is answered through `askUser` (one at a time, up to
 * `MAX_USER_HOVERS` per run) and a native Guard request is decided through
 * `onGuard`. Without `askUser` a user hover fails instead of getting an empty
 * default answer; without `onGuard` the runtime rejects a Guard. No approval is
 * ever granted automatically.
 *
 * Cleanup is best effort and never hides the original failure. A successful
 * run returns exit-worthy values; the caller decides the process code.
 */
export async function runEphemeralGraph(
  options: EphemeralRunOptions,
): Promise<EphemeralRunResult> {
  const { adapter, definition, project } = options;
  assertEphemeralGraphSupported(definition, options.trigger);
  assertBindings(definition, options.bindings);

  const graphId = definition.id;
  const now = options.now ?? (() => Date.now());
  const honey = HoneyStore.forComposition(options.stateRoot, options.apiary, graphId);
  const resume = options.resume === true;

  // A resume with no persisted field is a usage error, not an empty-field run.
  // It is checked before `adapter.start` so nothing native is spawned; the host
  // loads the same field again for the actual restore.
  if (resume && honey.load() === undefined) {
    throw new EphemeralRunUnsupportedError(
      'resume',
      `nothing to resume for graph '${graphId}'`,
    );
  }

  let workspace: Workspace | undefined;
  let registry: SessionRegistry | undefined;
  let host: GraphHost | undefined;
  let sessionIds: string[] = [];
  let loaded = false;
  let unloaded = false;
  let result: EphemeralRunResult | undefined;
  let failure: unknown;

  try {
    await adapter.start();
    workspace = new Workspace(adapter);
    registry = new SessionRegistry({
      workspace,
      harness: options.harness ?? 'b-core',
    });
    host = new GraphHost({
      workspace,
      registry,
      now,
      honeyForGraph: () => honey,
      // A normal run starts a new field; resume restores the persisted one.
      // The store is still used for flushes in both cases.
      restoreHoney: resume,
      allowHoverUnload: false,
      ...(options.onGuard === undefined ? {} : { onGuard: options.onGuard }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    });

    await host.loadGraph({
      definition,
      bindings: options.bindings,
      project,
    });
    loaded = true;
    // Capture the sessions while the graph is still routed: unload releases
    // routing but never closes a session, so the ids must be read first.
    sessionIds = [...host.loadedSessionIds()];

    let run: GraphRunResult;
    if (resume) {
      // The field was restored by loadGraph. Drain the work that was already
      // accepted before the process stopped; an explicit trigger starts new
      // work on top of the restored field instead.
      run =
        options.trigger === undefined
          ? await host.drain(graphId)
          : await host.trigger(graphId, options.trigger, {
              kind: 'text',
              text: options.input,
            });
    } else if (options.trigger === undefined) {
      const status = host.statusOf(graphId);
      if (status === undefined) {
        throw new Error(`graph '${graphId}' is not loaded`);
      }
      run = {
        graphId,
        rest: status.rest,
        hovered: status.hovered,
        pumps: 0,
        status,
        persisted: false,
      };
    } else {
      run = await host.trigger(graphId, options.trigger, {
        kind: 'text',
        text: options.input,
      });
    }

    // Service consecutive user hovers for both a trigger and a resumed drain.
    // After every answer the host pumps to Rest or to the next hover, so the
    // loop sees the freshest field. A Guard request never reaches this loop:
    // `onGuard` settles it during the pump.
    let answeredHovers = 0;
    while (run.hovered) {
      if (answeredHovers >= MAX_USER_HOVERS) {
        throw new Error(
          `graph '${graphId}' did not settle after ${String(MAX_USER_HOVERS)} user hovers`,
        );
      }
      const first = host.firstHover();
      if (first === undefined) {
        throw new Error(`graph '${graphId}' is hovering but no loaded hover was found`);
      }
      const node = definition.nodes.get(first.nodeId);
      if (node === undefined || node.kind !== 'user') {
        throw new Error(
          `graph '${graphId}' is hovered on non-user node '${first.nodeId}'`,
        );
      }
      const askUser = options.askUser;
      if (askUser === undefined) {
        // Typed and explicit: an unanswered user hover must never fall back
        // to an automatic empty answer.
        throw new EphemeralRunUnsupportedError(
          'user-node',
          `user node '${node.id}' needs an interactive answer, but no askUser handler was provided`,
        );
      }
      const value = await askUser(node, first.hover);
      run = await host.answer(graphId, node.id, value, first.token);
      answeredHovers += 1;
    }

    // Read the outputs before unload disposes the executors.
    const outputs = host.lastOutputs();
    unloaded = await host.unload(graphId);
    // A non-resumed no-trigger run never pumped, so its flush happens on
    // unload. Every other run already flushed as part of the run itself.
    const persisted =
      options.trigger === undefined && !resume ? unloaded : run.persisted;
    const finalRun: GraphRunResult = { ...run, persisted };
    result = {
      status: finalRun.status,
      run: finalRun,
      outputs,
      persisted,
      ...(finalRun.status.recovery === undefined
        ? {}
        : { recovery: finalRun.status.recovery }),
    };
  } catch (error) {
    failure = error;
  } finally {
    if (host !== undefined) {
      if (loaded && !unloaded) {
        try {
          await host.unload(graphId);
        } catch (error) {
          if (failure === undefined) {
            failure = error;
          }
        }
      }
      try {
        await host.dispose();
      } catch (error) {
        if (failure === undefined) {
          failure = error;
        }
      }
    }
    // Sessions are closed before the Workspace (and therefore the adapter)
    // stops. One failed close must not hide the original failure or leak the
    // remaining sessions.
    for (const sessionId of sessionIds) {
      try {
        await registry?.close(sessionId);
      } catch {
        // Best effort: the native close failure is not actionable here.
      }
    }
    if (workspace !== undefined) {
      try {
        await workspace.stop();
      } catch (error) {
        if (failure === undefined) {
          failure = error;
        }
      }
    } else {
      try {
        await adapter.stop();
      } catch (error) {
        if (failure === undefined) {
          failure = error;
        }
      }
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
  if (result === undefined) {
    throw new Error('ephemeral run produced no result');
  }
  return result;
}
