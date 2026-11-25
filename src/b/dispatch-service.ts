import { randomUUID } from 'node:crypto';

import type { ExecutionState } from '../adapters/harness.js';
import type { LiveHiveHost, LiveHiveRunResult } from '../daemon/graph-host.js';
import type { ForagerBinding, GraphBindings } from '../graph/binding.js';
import type { Project } from '../project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type Value,
} from '../runtime/index.js';
import { ForagerExecutionError } from '../session/forager.js';
import { BindingValidationError } from '../session/instantiate-foragers.js';
import type { SessionRegistry } from '../session/session-registry.js';
import { SessionBusyError } from '../session/session-errors.js';
import { parseSessionParams } from './validation.js';
import type { SessionParams } from './types.js';

export type { SessionParams } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** A timed-out trigger gets this long to unwind before release is deferred. */
const CANCEL_SETTLE_GRACE_MS = 250;
/** The only bee in the ephemeral dispatch graph. */
const BEE_ID = 'bee';
const TIMEOUT = Symbol('dispatch-timeout');

export interface DispatchOptions {
  /** Create a temporary session with these parameters. */
  readonly sessionParams?: SessionParams;
  /** Reuse an existing session; parameters are then only checked for conflict. */
  readonly sessionId?: string;
  /** Defaults to the service's default timeout. */
  readonly timeoutMs?: number;
  /** Project for a fresh session; overrides the service default. */
  readonly project?: Project;
}

export interface DispatchResult {
  readonly output: string;
  readonly sessionId: string;
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
  /** Default timeout; five minutes when omitted. */
  readonly defaultTimeoutMs?: number;
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

export class DispatchExecutionError extends DispatchError {
  constructor(readonly state: ExecutionState) {
    super(`dispatch execution ended in state '${state}'`);
    this.name = 'DispatchExecutionError';
  }
}

export class DispatchTimeoutError extends DispatchError {
  constructor(readonly timeoutMs: number) {
    super(`dispatch timed out after ${String(timeoutMs)}ms`);
    this.name = 'DispatchTimeoutError';
  }
}

interface DispatchTarget {
  readonly bindings: GraphBindings;
  readonly project: Project;
}

/**
 * Execute one temporary bee as an ephemeral one-bee graph. The graph is loaded
 * through `LiveHiveHost`, woken once, read for its forager output and unloaded; it
 * never becomes a LiveHive, a `live.json` or a catalog entry. A fresh session
 * is created by the graph binding; an explicit session is bound as-is, with the
 * same conflict checks as before. Nothing is replayed after an unknown outcome.
 *
 * A host that has a `RunStore` may still keep a run record for the trigger;
 * that is run history, not LiveHive persistence.
 */
export class DispatchService {
  private readonly registry: SessionRegistry;
  private readonly liveHiveHost: LiveHiveHost;
  private readonly defaultProject: Project | undefined;
  private readonly defaultTimeoutMs: number;

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
    this.defaultTimeoutMs = validateTimeout(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    );
  }

  async dispatch(input: string, options: DispatchOptions): Promise<DispatchResult> {
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

    const timeoutMs = validateTimeout(
      options.timeoutMs ?? this.defaultTimeoutMs,
      'timeoutMs',
    );
    return this.runEphemeral(input, this.resolveTarget(params, options), timeoutMs);
  }

  private async runEphemeral(
    input: string,
    target: DispatchTarget,
    timeoutMs: number,
  ): Promise<DispatchResult> {
    const graphId = `dispatch-${randomUUID()}`;
    const definition = buildDispatchDefinition(graphId);
    let loaded = false;
    let settled: Promise<void> | undefined;
    try {
      await this.liveHiveHost.loadGraph({
        definition,
        bindings: target.bindings,
        project: target.project,
        idleTtlMs: 0,
        ephemeral: true,
      });
      loaded = true;
      const sessionId = this.liveHiveHost.bindingsOf(graphId).get(BEE_ID);
      if (sessionId === undefined) {
        throw new DispatchError('dispatch graph has no session binding');
      }
      const trigger = this.liveHiveHost.trigger(graphId, BEE_ID, textValue(input));
      settled = trigger.then(
        () => undefined,
        () => undefined,
      );
      const result = await this.waitForTrigger(trigger, settled, timeoutMs, sessionId);
      return { output: this.requireOutput(graphId), sessionId };
    } catch (error) {
      throw normalizeDispatchError(error);
    } finally {
      if (loaded) {
        await this.releaseGraph(graphId, settled);
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

  /**
   * Wait for the graph run, or for the dispatch timeout. On timeout it cancels
   * the execution this dispatch started (never a user turn), gives the runtime
   * a short grace to unwind, and rejects. A trigger that outlives the grace is
   * released by `releaseGraph` once it settles.
   */
  private async waitForTrigger(
    trigger: Promise<LiveHiveRunResult>,
    settled: Promise<void>,
    timeoutMs: number,
    sessionId: string,
  ): Promise<LiveHiveRunResult> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      timer.unref();
    });
    try {
      const first = await Promise.race([trigger, deadline]);
      if (first !== TIMEOUT) {
        return first;
      }
      this.cancelActive(sessionId);
      // The old direct path rejected without waiting for a stalled native
      // cancel. Keep the rejection prompt, but let a cooperative adapter settle
      // so the graph can usually still be unloaded in this call.
      await Promise.race([settled, delay(CANCEL_SETTLE_GRACE_MS)]);
      throw new DispatchTimeoutError(timeoutMs);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Fire-and-forget: a stalled native cancel must not delay the timeout. */
  private cancelActive(sessionId: string): void {
    try {
      const record = this.registry.get(sessionId);
      if (record === undefined) {
        return;
      }
      void this.registry
        .workspaceFor(record.harness)
        .cancel(sessionId, true)
        .catch(() => undefined);
    } catch {
      // The cancel is best effort; the timeout error is the useful outcome.
    }
  }

  private requireOutput(graphId: string): string {
    const value = this.liveHiveHost.outputsOf(graphId).get(BEE_ID);
    if (value === undefined || value.kind !== 'text') {
      throw new DispatchError('dispatch graph produced no output');
    }
    if (value.text.trim() === '') {
      throw new DispatchError('dispatch graph produced empty output');
    }
    return value.text;
  }

  /**
   * Unload the ephemeral graph. A busy (still-running) trigger makes the host
   * refuse; the unload is then retried once the runtime settles. It never
   * retains a loaded graph after a clean run or a settled failure.
   */
  private async releaseGraph(
    graphId: string,
    settled: Promise<void> | undefined,
  ): Promise<void> {
    let unloaded = false;
    try {
      unloaded = await this.liveHiveHost.unload(graphId);
    } catch {
      unloaded = false;
    }
    if (unloaded || settled === undefined) {
      return;
    }
    void settled
      .then(() => this.liveHiveHost.unload(graphId))
      .catch(() => undefined);
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
        config: { connection: 'dispatch', prompt: '{{input}}' },
      },
    },
    edges: [],
  });
}

function normalizeDispatchError(error: unknown): unknown {
  if (error instanceof ForagerExecutionError) {
    return new DispatchExecutionError(error.state);
  }
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

function validateTimeout(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function textValue(input: string): Value {
  return { kind: 'text', text: input };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
