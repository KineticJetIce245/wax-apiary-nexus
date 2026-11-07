import {
  validateBindings,
  type BindingIssue,
  type ForagerBinding,
  type GraphBindings,
} from '../graph/binding.js';
import type { GraphBindingStore } from '../graph/binding-store.js';
import type { Project } from '../project/kernel.js';
import type { CompositionDefinition, NodeId } from '../runtime/index.js';
import { RoutingForagerExecutor } from './routing-executor.js';
import {
  SessionNotFoundError,
  SessionRegistry,
  type SessionRecord,
} from './session-registry.js';
import type { Conversation, Workspace } from './workspace.js';
import { WorkspaceForagerExecutor } from './forager.js';

export interface InstantiateForagersOptions {
  readonly definition: CompositionDefinition;
  /**
   * Graph id used as the resolved-binding key. Defaults to
   * `definition.id`; GraphHost passes it explicitly.
   */
  readonly graphId?: string;
  readonly bindings: GraphBindings;
  readonly registry: SessionRegistry;
  readonly workspace: Workspace;
  readonly project: Project;
  /**
   * Required when any `fresh_once` binding is present. Its absence is rejected
   * before a session is created instead of silently degrading to `always`.
   */
  readonly bindingStore?: GraphBindingStore;
}

export interface InstantiatedForagers {
  readonly executors: ReadonlyMap<NodeId, WorkspaceForagerExecutor>;
  readonly sessions: ReadonlyMap<NodeId, SessionRecord>;
  readonly routing: RoutingForagerExecutor;
  /**
   * Sessions created by this call, in creation order. A reused `fresh_once`
   * session is not included, so a caller can distinguish "created" from
   * "attached" without guessing from bindings.
   */
  readonly createdSessionIds: readonly string[];
  dispose(): void;
}

/** The binding layer rejected the graph; no session was created. */
export class BindingValidationError extends Error {
  constructor(readonly issues: readonly BindingIssue[]) {
    const summary = issues
      .map((issue) => `${issue.code}${issue.nodeId === undefined ? '' : `:${issue.nodeId}`}`)
      .join(', ');
    super(`Bindings are invalid (${String(issues.length)} issue(s)): ${summary}`);
    this.name = 'BindingValidationError';
  }
}

/**
 * A validated session binding was gone or unusable by the time it was used. A
 * reused `fresh_once` session may also be busy; `busy` is reported here rather
 * than silently replacing or sharing the session.
 */
export class SessionBindingUnavailableError extends Error {
  constructor(
    readonly nodeId: NodeId,
    readonly sessionId: string,
    readonly reason: 'unknown-session' | 'attach-failed' | 'missing-conversation' | 'busy',
  ) {
    const detail =
      reason === 'unknown-session'
        ? 'the session no longer exists'
        : reason === 'attach-failed'
          ? 'the session could not be reattached to its native conversation'
          : reason === 'missing-conversation'
            ? 'the session has no conversation in the workspace'
            : 'the session is busy';
    super(`Forager '${nodeId}' cannot bind session '${sessionId}': ${detail}`);
    this.name = 'SessionBindingUnavailableError';
  }
}

/**
 * Resolves a graph's bindings into one `WorkspaceForagerExecutor` per forager.
 *
 * Validation runs first and creates or attaches nothing. Fresh sessions are
 * then created in definition node order. A session binding is lazily attached
 * (`ensureAttached`) before it is used, which is how a hydrated session from a
 * previous daemon process is resumed.
 *
 * A `fresh_once` binding reuses the `(graphId, nodeId) -> sessionId` mapping in
 * the binding store; without a store it fails before creating anything. A
 * `fresh_always` binding (and an absent mode) always creates a new session and
 * never writes the store. If anything fails after creation starts, only
 * sessions this call created are closed and only mappings this call created
 * are removed (best effort, in reverse order); a reused session is never
 * closed and its mapping is never deleted here.
 */
export async function instantiateForagers(
  options: InstantiateForagersOptions,
): Promise<InstantiatedForagers> {
  const { definition, bindings, registry, workspace, project, bindingStore } = options;
  const graphId = options.graphId ?? definition.id;

  const validation = validateBindings(definition, bindings, registry, {
    harness: registry.harness,
    projectDirectory: project.directory,
  });
  if (!validation.ok) {
    throw new BindingValidationError(validation.issues);
  }

  // A `fresh_once` binding cannot be resolved without a store. Reject it here,
  // before the creation loop, instead of falling back to `fresh_always`.
  if (bindingStore === undefined) {
    const issues: BindingIssue[] = [];
    for (const node of definition.nodes.values()) {
      if (node.kind !== 'forager') {
        continue;
      }
      const binding = bindings[node.id];
      if (binding?.kind === 'fresh' && (binding.mode ?? 'always') === 'once') {
        issues.push({
          code: 'invalid-binding',
          message: `forager '${node.id}' fresh_once binding requires a graph binding store`,
          nodeId: node.id,
        });
      }
    }
    if (issues.length > 0) {
      throw new BindingValidationError(issues);
    }
  }

  const createdSessionIds: string[] = [];
  /** Node ids whose `fresh_once` mapping this call created. */
  const createdOnceNodes: NodeId[] = [];
  const conversations = new Map<NodeId, Conversation>();
  const sessions = new Map<NodeId, SessionRecord>();
  const executors = new Map<NodeId, WorkspaceForagerExecutor>();

  try {
    for (const node of definition.nodes.values()) {
      if (node.kind !== 'forager') {
        continue;
      }
      const binding = bindings[node.id];
      if (binding === undefined) {
        // Validation above guarantees a binding for every forager; keep this
        // defensive so a future caller cannot silently skip a node.
        throw new Error(`Forager '${node.id}' has no binding after validation`);
      }

      if (binding.kind === 'session') {
        let record: SessionRecord;
        try {
          // Lazily reattach a hydrated record. An already attached session is
          // returned without a second native resume.
          record = await registry.ensureAttached(binding.sessionId);
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            throw new SessionBindingUnavailableError(
              node.id,
              binding.sessionId,
              'unknown-session',
            );
          }
          // A typed attach failure is expected; a raw resume failure from a
          // custom registry is still an attach failure for the binding layer.
          throw new SessionBindingUnavailableError(node.id, binding.sessionId, 'attach-failed');
        }
        const conversation = workspace.getConversation(record.sessionId);
        if (conversation === undefined) {
          throw new SessionBindingUnavailableError(
            node.id,
            binding.sessionId,
            'missing-conversation',
          );
        }
        conversations.set(node.id, conversation);
        sessions.set(node.id, record);
        continue;
      }

      const mode = binding.mode ?? 'always';
      if (mode === 'once') {
        // The precheck above guarantees a store for every fresh_once binding.
        if (bindingStore === undefined) {
          throw new Error(`Forager '${node.id}' fresh_once binding lost its store`);
        }

        let resolved = bindingStore.get(graphId, node.id);
        if (
          resolved !== undefined &&
          (resolved.harness !== registry.harness || resolved.projectId !== project.id)
        ) {
          // The mapping names a session from another harness/project. It is not
          // usable here, so replace it rather than attaching the wrong session.
          bindingStore.remove(graphId, node.id);
          resolved = undefined;
        }

        let reused: { record: SessionRecord; conversation: Conversation } | undefined;
        if (resolved !== undefined) {
          const resolvedSessionId = resolved.sessionId;
          if (registry.isBusy(resolvedSessionId)) {
            throw new SessionBindingUnavailableError(node.id, resolvedSessionId, 'busy');
          }
          try {
            const record = await registry.ensureAttached(resolvedSessionId);
            const conversation = workspace.getConversation(record.sessionId);
            if (conversation === undefined) {
              throw new SessionBindingUnavailableError(
                node.id,
                record.sessionId,
                'missing-conversation',
              );
            }
            reused = { record, conversation };
          } catch (error) {
            if (error instanceof SessionNotFoundError) {
              // The session vanished since the mapping was written. Delete the
              // stale mapping and create a new session below.
              bindingStore.remove(graphId, node.id);
            } else if (error instanceof SessionBindingUnavailableError) {
              // Attach succeeded but the workspace conversation is missing;
              // keep the mapping retryable.
              throw error;
            } else {
              // A failed attach must not auto-retry or auto-replace: keep the
              // mapping so the caller can retry the same session.
              throw new SessionBindingUnavailableError(
                node.id,
                resolvedSessionId,
                'attach-failed',
              );
            }
          }
        }

        if (reused !== undefined) {
          conversations.set(node.id, reused.conversation);
          sessions.set(node.id, reused.record);
          continue;
        }

        const created = await registry.create(project, freshMetadata(binding));
        createdSessionIds.push(created.sessionId);
        createdOnceNodes.push(node.id);
        const conversation = workspace.getConversation(created.sessionId);
        if (conversation === undefined) {
          throw new SessionBindingUnavailableError(
            node.id,
            created.sessionId,
            'missing-conversation',
          );
        }
        // Persist only after the conversation exists. If this throws, the catch
        // block closes the created session and no record survives.
        bindingStore.set({
          graphId,
          nodeId: node.id,
          sessionId: created.sessionId,
          harness: registry.harness,
          projectId: project.id,
          updatedAt: new Date().toISOString(),
        });
        conversations.set(node.id, conversation);
        sessions.set(node.id, created);
        continue;
      }

      // `fresh_always` (and an absent mode): a new session every load, with no
      // resolved mapping written.
      const created = await registry.create(project, freshMetadata(binding));
      createdSessionIds.push(created.sessionId);
      const conversation = workspace.getConversation(created.sessionId);
      if (conversation === undefined) {
        throw new SessionBindingUnavailableError(
          node.id,
          created.sessionId,
          'missing-conversation',
        );
      }
      conversations.set(node.id, conversation);
      sessions.set(node.id, created);
    }

    for (const [nodeId, conversation] of conversations) {
      executors.set(nodeId, new WorkspaceForagerExecutor({ workspace, conversation }));
    }

    const routing = new RoutingForagerExecutor({ executors });
    let disposed = false;
    return {
      executors,
      sessions,
      routing,
      createdSessionIds: [...createdSessionIds],
      dispose(): void {
        if (disposed) {
          return;
        }
        disposed = true;
        // Routing disposes each child executor that exposes dispose().
        routing.dispose();
      },
    };
  } catch (error) {
    for (const executor of executors.values()) {
      executor.dispose();
    }

    // Remove only mappings created by this call. A reused once mapping must be
    // left untouched so a later retry can still attach the existing session.
    if (bindingStore !== undefined) {
      for (let index = createdOnceNodes.length - 1; index >= 0; index -= 1) {
        const nodeId = createdOnceNodes[index];
        if (nodeId === undefined) {
          continue;
        }
        try {
          bindingStore.remove(graphId, nodeId);
        } catch {
          // The original failure is the one callers can act on.
        }
      }
    }

    // Best effort, in reverse creation order: one failed close must not hide
    // the original failure or prevent the remaining cleanups.
    for (let index = createdSessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = createdSessionIds[index];
      if (sessionId === undefined) {
        continue;
      }
      try {
        await registry.close(sessionId);
      } catch {
        // The original error is the one callers can act on.
      }
    }
    throw error;
  }
}

function freshMetadata(binding: Extract<ForagerBinding, { kind: 'fresh' }>): {
  readonly model?: string;
  readonly reasoning?: string;
} {
  return {
    ...(binding.model === undefined ? {} : { model: binding.model }),
    ...(binding.reasoning === undefined ? {} : { reasoning: binding.reasoning }),
  };
}
