import type { Project } from '../project/kernel.js';
import type { ExecutionState } from '../adapters/harness.js';
import type { SessionRecord, SessionRegistry } from '../session/session-registry.js';
import type { Workspace } from '../session/workspace.js';
import { parseSessionParams } from './validation.js';
import type { SessionParams } from './types.js';

export type { SessionParams } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 25;

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

/**
 * Execute one temporary bee. It creates or reuses a session through the global
 * registry, submits the input and waits for that execution. It never creates a
 * LiveHive/HiveTemplate, writes a field, or retries after an unknown outcome.
 */
export class DispatchService {
  private readonly registry: SessionRegistry;
  private readonly defaultProject: Project | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(options: DispatchServiceOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('DispatchService options are required');
    }
    if (typeof options.registry !== 'object' || options.registry === null) {
      throw new TypeError('DispatchService requires a SessionRegistry');
    }
    this.registry = options.registry;
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
    const target =
      options.sessionId === undefined
        ? await this.createFresh(params as SessionParams, options)
        : await this.useExisting(options.sessionId, params);

    return {
      output: await this.execute(target.workspace, target.record.sessionId, input, timeoutMs),
      sessionId: target.record.sessionId,
    };
  }

  private async createFresh(
    params: SessionParams,
    options: DispatchOptions,
  ): Promise<{ record: SessionRecord; workspace: Workspace }> {
    const project = options.project ?? this.defaultProject;
    if (project === undefined) {
      throw new DispatchError('dispatch needs a project for a fresh session');
    }
    const record = await this.registry.create(project, {
      ...(params.harness === undefined ? {} : { harness: params.harness }),
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
    });
    return { record, workspace: this.registry.workspaceFor(record.harness) };
  }

  private async useExisting(
    sessionId: string,
    params: SessionParams | undefined,
  ): Promise<{ record: SessionRecord; workspace: Workspace }> {
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
      if (
        params.reasoning !== undefined &&
        params.reasoning !== record.reasoning
      ) {
        throw new DispatchConflictError('sessionParams.reasoning conflicts with the session');
      }
    }
    const attached = await this.registry.ensureAttached(sessionId);
    return { record: attached, workspace: this.registry.workspaceFor(attached.harness) };
  }

  private async execute(
    workspace: Workspace,
    sessionId: string,
    input: string,
    timeoutMs: number,
  ): Promise<string> {
    const execution = await workspace.submit(sessionId, input);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = workspace.getExecution(execution.id);
      if (current !== undefined && current.state !== 'running') {
        if (current.state !== 'completed') {
          throw new DispatchExecutionError(current.state);
        }
        return current.output;
      }
      if (Date.now() >= deadline) {
        // Timeout must reject promptly even if a native cancel stalls. The
        // cancellation is attempted once and is never followed by a replay.
        void workspace.cancel(execution.id).catch(() => undefined);
        throw new DispatchTimeoutError(timeoutMs);
      }
      const remaining = Math.max(1, deadline - Date.now());
      await delay(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }
}

function validateTimeout(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
