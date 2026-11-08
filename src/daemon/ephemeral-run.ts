import type { HarnessAdapter } from '../adapters/harness.js';
import { HoneyStore } from '../storage/honey.js';
import type { GraphBindings } from '../graph/binding.js';
import type { Project } from '../project/kernel.js';
import {
  GraphHost,
  type GraphRunResult,
  type GraphStatus,
} from './graph-host.js';
import type { CompositionDefinition, NodeId, Value } from '../runtime/index.js';
import { SessionRegistry } from '../session/session-registry.js';
import { Workspace } from '../session/workspace.js';

/** Why the ephemeral b-core path cannot run this composition. */
export type EphemeralRunUnsupportedReason =
  | 'empty-graph-id'
  | 'user-node'
  | 'trigger'
  | 'missing-binding';

/**
 * A graph the headless b-core runner deliberately refuses. The message carries
 * ids only: it never contains a prompt, output or approval body.
 *
 * The CLI translates this into exit code 2 (usage) and does so before it
 * creates or starts an adapter.
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

export interface EphemeralRunOptions {
  readonly adapter: HarnessAdapter;
  readonly definition: CompositionDefinition;
  readonly project: Project;
  readonly bindings: GraphBindings;
  readonly trigger?: string;
  readonly input: string;
  readonly stateRoot: string;
  readonly apiary: string;
  /**
   * Harness name recorded on the ephemeral sessions. Adapters do not expose a
   * kind, so the CLI passes its selection; the default is a stable placeholder.
   */
  readonly harness?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxWaitMs?: number;
}

export interface EphemeralRunResult {
  readonly status: GraphStatus;
  readonly run: GraphRunResult;
  readonly outputs: ReadonlyMap<NodeId, Value>;
  readonly persisted: boolean;
}

/**
 * Refuse a graph the headless runner cannot faithfully execute: a user node
 * would need interactive input, and only foragers/workers are triggerable.
 * Runs before the adapter starts, so a usage rejection spawns nothing.
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
  for (const node of definition.nodes.values()) {
    if (node.kind === 'user') {
      throw new EphemeralRunUnsupportedError(
        'user-node',
        `b-core run does not support user node '${node.id}'`,
      );
    }
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
  if (node.kind !== 'forager' && node.kind !== 'worker') {
    throw new EphemeralRunUnsupportedError(
      'trigger',
      `b-core trigger target '${trigger}' must be a forager or worker node, got '${node.kind}'`,
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
 * for this run only and closed afterwards. Load always starts from a fresh
 * field (`restoreHoney: false`) and every mutation is flushed to Honey, so a
 * later normal run can restore what this run left behind. There is no session
 * store, no scheduling, no resume and no automatic Guard approval: a native
 * approval is rejected by the runtime's default decision.
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
      // A run starts a new field; the store is still used for flushes.
      restoreHoney: false,
      allowHoverUnload: false,
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
    if (options.trigger === undefined) {
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

    // Read the outputs before unload disposes the executors.
    const outputs = host.lastOutputs();
    unloaded = await host.unload(graphId);
    const persisted = options.trigger === undefined ? unloaded : run.persisted;
    const finalRun: GraphRunResult = { ...run, persisted };
    result = {
      status: finalRun.status,
      run: finalRun,
      outputs,
      persisted,
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
