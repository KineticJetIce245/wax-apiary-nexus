import { randomUUID } from 'node:crypto';

import type { LiveHiveHost } from '../daemon/graph-host.js';
import type { ForagerBinding, GraphBindings } from '../graph/binding.js';
import type { Project } from '../project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type Value,
} from '../runtime/index.js';
import { BindingValidationError } from '../session/instantiate-foragers.js';
import type { SessionRegistry } from '../session/session-registry.js';
import { SessionBusyError } from '../session/session-errors.js';
import { parseSessionParams } from './validation.js';
import type { SessionParams } from './types.js';

export type { SessionParams } from './types.js';

/** The only bee in the ephemeral dispatch graph. */
const BEE_ID = 'bee';

export interface DispatchOptions {
  /** Create a temporary session with these parameters. */
  readonly sessionParams?: SessionParams;
  /** Reuse an existing session; parameters are then only checked for conflict. */
  readonly sessionId?: string;
  /** Project for a fresh session; overrides the service default. */
  readonly project?: Project;
}

export interface DispatchServiceOptions {
  readonly registry: SessionRegistry;
  /**
   * Host that loads, triggers and unloads the ephemeral one-bee graph. It is
   * the same host as the loaded LiveHives so dispatch shares their execution
   * and approval path; the graph itself is marked ephemeral and is not
   * persisted. A busy session waits in the harness adapter's own FIFO.
   */
  readonly liveHiveHost: LiveHiveHost;
  /** Project used by fresh dispatches when the call does not supply one. */
  readonly defaultProject?: Project;
}

export class DispatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DispatchError';
  }
}

export class DispatchSessionNotFoundError extends DispatchError {
  constructor(readonly sessionId: string) {
    super(`dispatch session is not registered: ${sessionId}`);
    this.name = 'DispatchSessionNotFoundError';
  }
}

export class DispatchConflictError extends DispatchError {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchConflictError';
  }
}

interface DispatchTarget {
  readonly bindings: GraphBindings;
  readonly project: Project;
}

/**
 * Deliver one temporary bee as an ephemeral one-bee graph. The graph is loaded
 * through `LiveHiveHost`, triggered once and then released by the host once its
 * field reaches Rest; it never becomes a LiveHive, a `live.json` or a catalog
 * entry. A fresh session is created by the graph binding; an explicit session
 * is bound as-is, with the same conflict checks as before.
 *
 * Dispatch accepts a delivery (202) and never returns the model output: a
 * caller that needs the result must compose a graph whose next Bee consumes it.
 */
export class DispatchService {
  private readonly registry: SessionRegistry;
  private readonly liveHiveHost: LiveHiveHost;
  private readonly defaultProject: Project | undefined;

  constructor(options: DispatchServiceOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('DispatchService options are required');
    }
    if (typeof options.registry !== 'object' || options.registry === null) {
      throw new TypeError('DispatchService requires a SessionRegistry');
    }
    if (typeof options.liveHiveHost !== 'object' || options.liveHiveHost === null) {
      throw new TypeError('DispatchService requires a LiveHiveHost');
    }
    this.registry = options.registry;
    this.liveHiveHost = options.liveHiveHost;
    this.defaultProject = options.defaultProject;
  }

  async dispatch(input: string, options: DispatchOptions): Promise<void> {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new TypeError('dispatch input must be a non-empty string');
    }
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('DispatchOptions are required');
    }
    const params =
      options.sessionParams === undefined
        ? undefined
        : parseSessionParams(options.sessionParams, 'sessionParams');
    if (params === undefined && options.sessionId === undefined) {
      throw new TypeError('dispatch requires sessionParams or sessionId');
    }
    await this.runEphemeral(input, this.resolveTarget(params, options));
  }

  private async runEphemeral(input: string, target: DispatchTarget): Promise<void> {
    const graphId = `dispatch-${randomUUID()}`;
    const definition = buildDispatchDefinition(graphId);
    let pendingRelease = false;
    try {
      await this.liveHiveHost.loadGraph({
        definition,
        bindings: target.bindings,
        project: target.project,
        idleTtlMs: 0,
        ephemeral: true,
      });
      pendingRelease = true;
      if (!this.liveHiveHost.bindingsOf(graphId).has(BEE_ID)) {
        throw new DispatchError('dispatch graph has no session binding');
      }
      await this.liveHiveHost.trigger(graphId, BEE_ID, messageValue(input));
      // Accepted: the host driver owns the ephemeral graph and releases it
      // after its field reaches Rest.
      pendingRelease = false;
    } catch (error) {
      throw normalizeDispatchError(error);
    } finally {
      if (pendingRelease) {
        await this.releaseGraph(graphId);
      }
    }
  }

  private resolveTarget(
    params: SessionParams | undefined,
    options: DispatchOptions,
  ): DispatchTarget {
    return options.sessionId === undefined
      ? this.resolveFreshTarget(params, options)
      : this.resolveExistingTarget(params, options.sessionId);
  }

  private resolveFreshTarget(
    params: SessionParams | undefined,
    options: DispatchOptions,
  ): DispatchTarget {
    if (params === undefined) {
      throw new TypeError('dispatch requires sessionParams or sessionId');
    }
    const project = options.project ?? this.defaultProject;
    if (project === undefined) {
      throw new DispatchError('dispatch needs a project for a fresh session');
    }
    const fresh: ForagerBinding = {
      kind: 'fresh',
      ...(params.harness === undefined ? {} : { harness: params.harness }),
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
    };
    return { project, bindings: { [BEE_ID]: fresh } };
  }

  private resolveExistingTarget(
    params: SessionParams | undefined,
    sessionId: string,
  ): DispatchTarget {
    const record = this.registry.get(sessionId);
    if (record === undefined) {
      throw new DispatchSessionNotFoundError(sessionId);
    }
    if (params !== undefined) {
      if (params.harness !== undefined && params.harness !== record.harness) {
        throw new DispatchConflictError('sessionParams.harness conflicts with the session');
      }
      if (params.model !== undefined && params.model !== record.model) {
        throw new DispatchConflictError('sessionParams.model conflicts with the session');
      }
      if (params.reasoning !== undefined && params.reasoning !== record.reasoning) {
        throw new DispatchConflictError('sessionParams.reasoning conflicts with the session');
      }
    }
    return {
      project: { id: record.projectId, directory: record.projectDirectory },
      bindings: { [BEE_ID]: { kind: 'session', sessionId: record.sessionId } },
    };
  }

  /** A load/trigger that never became accepted leaves no ephemeral graph. */
  private async releaseGraph(graphId: string): Promise<void> {
    try {
      await this.liveHiveHost.unload(graphId);
    } catch {
      // Best effort: the graph is not catalogued and a failed trigger already
      // carries the useful error.
    }
  }
}

/** The runtime representation of the ephemeral one-bee LiveHive graph. */
function buildDispatchDefinition(graphId: string): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: graphId,
    nodes: {
      [BEE_ID]: {
        kind: 'forager',
        // `connection` is metadata only: the binding chooses the session and
        // therefore the harness that actually runs this bee.
        config: { connection: 'dispatch', prompt: '{{message}}' },
      },
    },
    edges: [],
  });
}

function normalizeDispatchError(error: unknown): unknown {
  if (error instanceof BindingValidationError) {
    // The session became busy between the conflict check and the load. Keep the
    // established 409 session-busy outcome instead of a 400 binding error.
    const busy = error.issues.filter((issue) => issue.code === 'busy-session');
    if (busy.length > 0 && busy.length === error.issues.length) {
      const sessionId = busy[0]?.sessionId;
      if (sessionId !== undefined) {
        return new SessionBusyError(sessionId);
      }
    }
  }
  return error;
}

function messageValue(input: string): Value {
  return { message: input };
}
