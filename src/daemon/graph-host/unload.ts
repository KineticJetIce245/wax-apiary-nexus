import type { GraphBindings } from '../../graph/binding.js';
import type { LiveHiveId } from '../../graph/registry.js';
import type { InstantiatedForagers } from '../../session/instantiate-foragers.js';
import type {
  LateActivationOutcome,
  NodeId,
} from '../../runtime/index.js';
import type { LiveHiveHostContext } from './context.js';
import { messageOf } from './context.js';
import { handleLateResult } from './late-result.js';
import type { SessionOwnership } from './session-ownership.js';
import type { LiveGraph, LoadGraphOptions } from './types.js';

/** Loads the field again from Honey; supplied by the lifecycle loader. */
export type ReloadField = (options: LoadGraphOptions) => Promise<void>;

/**
 * Configures the host-side late-result path for one loaded graph. The reload
 * names the same LiveHive id, project and explicit sessions, so loading the
 * field again never creates a replacement session. Without a durable snapshot
 * the retained executor is still released and the result is dropped.
 */
export function lateResultHook(
  context: LiveHiveHostContext,
  options: LoadGraphOptions,
  instantiated: InstantiatedForagers,
  honey: LiveGraph['honey'],
  reloadField: ReloadField,
): (nodeId: NodeId, outcome: LateActivationOutcome) => void {
  const graphId = options.definition.id;
  let released = false;
  const releaseOld = (): void => {
    if (released) {
      return;
    }
    released = true;
    try {
      instantiated.dispose();
    } catch {
      // The late result is already applied; a failed unsubscribe is cleanup.
    }
  };
  if (honey === undefined) {
    return () => releaseOld();
  }
  const reloadOptions: LoadGraphOptions = {
    definition: options.definition,
    bindings: explicitSessionBindings(instantiated),
    project: options.project,
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    restoreHoney: true,
  };
  return (nodeId, outcome) =>
    handleLateResult(
      context,
      graphId,
      () => reloadField(reloadOptions),
      releaseOld,
      nodeId,
      outcome,
    );
}

/** One explicit binding per bound Bee; reloads reuse those exact sessions. */
function explicitSessionBindings(instantiated: InstantiatedForagers): GraphBindings {
  const bindings: Record<NodeId, { readonly kind: 'session'; readonly sessionId: string }> = {};
  for (const [nodeId, record] of instantiated.sessions) {
    bindings[nodeId] = { kind: 'session', sessionId: record.sessionId };
  }
  return bindings;
}

/**
 * Registry unload hook: a failed flush propagates and keeps the graph loaded;
 * a successful one stops scheduling and releases routing only.
 */
export async function flushAndRelease(
  context: LiveHiveHostContext,
  ownership: SessionOwnership,
  graphId: LiveHiveId,
  live: LiveGraph,
): Promise<void> {
  if (live.honey !== undefined) {
    try {
      await live.honey.save(live.runtime.exportField());
    } catch (error) {
      context.reportCleanupFailure({
        type: 'graph.cleanup-failed',
        graphId,
        phase: 'routing',
        error: messageOf(error),
      });
      throw error;
    }
  }
  // The flush succeeded (or there was none); no further scheduled occurrence
  // may target a graph that is about to disappear, and its explicit-session
  // reservations become available to another graph. The snapshot is immediate:
  // a running activation is detached and its late result loads the field again
  // and completes the restored active. `maxWaitMs` does not apply here.
  const keepRouting = live.instantiated.hasPendingExecutions();
  live.runtime.detach();
  context.schedulers.stop(graphId);
  ownership.release(graphId);
  if (!keepRouting) {
    await releaseGraphResources(context, graphId, live.instantiated, live.bindings, 'retain');
  }
}

/**
 * Cleanup hook used by explicit unload, TTL sweep, dispose and load rollback.
 * It never rejects: GraphRegistry must be able to forget the graph even if a
 * close fails.
 *
 * `retain`: a normal unload/sweep/dispose. Only routing is disposed. No session
 * is closed and no `fresh_once` mapping is removed.
 * `rollback`: a load that never became visible. Every session this load created
 * is closed and the `fresh_once` mappings it created are removed. A reused
 * session is never closed or removed here.
 */
export async function releaseGraphResources(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  instantiated: InstantiatedForagers,
  bindings: GraphBindings,
  mode: 'retain' | 'rollback',
): Promise<void> {
  const sessionIds = mode === 'rollback' ? [...instantiated.createdSessionIds] : [];
  disposeRouting(context, graphId, instantiated);
  if (mode === 'rollback' && context.bindingStore !== undefined) {
    removeOnceMappings(context, graphId, instantiated, bindings);
  }
  await closeSessions(context, graphId, sessionIds);
}

function disposeRouting(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  instantiated: InstantiatedForagers,
): void {
  try {
    instantiated.dispose();
  } catch (error) {
    context.reportCleanupFailure({
      type: 'graph.cleanup-failed',
      graphId,
      phase: 'routing',
      error: messageOf(error),
    });
  }
}

function removeOnceMappings(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  instantiated: InstantiatedForagers,
  bindings: GraphBindings,
): void {
  const store = context.bindingStore;
  if (store === undefined) {
    return;
  }
  const created = new Set(instantiated.createdSessionIds);
  for (const [nodeId, record] of instantiated.sessions) {
    if (!created.has(record.sessionId)) {
      continue;
    }
    const binding = bindings[nodeId];
    if (
      binding === undefined ||
      binding.kind !== 'fresh' ||
      (binding.mode ?? 'always') !== 'once'
    ) {
      continue;
    }
    try {
      store.remove(graphId, nodeId);
    } catch (error) {
      context.reportCleanupFailure({
        type: 'graph.cleanup-failed',
        graphId,
        phase: 'session',
        sessionId: record.sessionId,
        error: messageOf(error),
      });
    }
  }
}

async function closeSessions(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  sessionIds: readonly string[],
): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      await context.registry.close(sessionId);
    } catch (error) {
      context.reportCleanupFailure({
        type: 'graph.cleanup-failed',
        graphId,
        phase: 'session',
        sessionId,
        error: messageOf(error),
      });
    }
  }
}
