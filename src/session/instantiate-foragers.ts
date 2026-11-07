import {
  validateBindings,
  type BindingIssue,
  type ForagerBinding,
  type GraphBindings,
} from '../graph/binding.js';
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
  readonly bindings: GraphBindings;
  readonly registry: SessionRegistry;
  readonly workspace: Workspace;
  readonly project: Project;
}

export interface InstantiatedForagers {
  readonly executors: ReadonlyMap<NodeId, WorkspaceForagerExecutor>;
  readonly sessions: ReadonlyMap<NodeId, SessionRecord>;
  readonly routing: RoutingForagerExecutor;
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

/** A validated session binding was gone or unusable by the time it was used. */
export class SessionBindingUnavailableError extends Error {
  constructor(
    readonly nodeId: NodeId,
    readonly sessionId: string,
    readonly reason: 'unknown-session' | 'attach-failed' | 'missing-conversation',
  ) {
    const detail =
      reason === 'unknown-session'
        ? 'the session no longer exists'
        : reason === 'attach-failed'
          ? 'the session could not be reattached to its native conversation'
          : 'the session has no conversation in the workspace';
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
 * previous daemon process is resumed. If anything fails after creation starts,
 * only sessions this call created are closed (best effort); an existing
 * session bound to the graph is never closed here.
 */
export async function instantiateForagers(
  options: InstantiateForagersOptions,
): Promise<InstantiatedForagers> {
  const { definition, bindings, registry, workspace, project } = options;

  const validation = validateBindings(definition, bindings, registry, {
    harness: registry.harness,
    projectDirectory: project.directory,
  });
  if (!validation.ok) {
    throw new BindingValidationError(validation.issues);
  }

  const createdSessionIds: string[] = [];
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

      const created = await registry.create(project, freshMetadata(binding));
      createdSessionIds.push(created.sessionId);
      const conversation = workspace.getConversation(created.sessionId);
      if (conversation === undefined) {
        throw new SessionBindingUnavailableError(node.id, created.sessionId, 'missing-conversation');
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
