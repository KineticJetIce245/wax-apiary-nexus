import type { HarnessAdapter } from '../adapters/harness.js';
import { Workspace } from './workspace.js';

export type HarnessUnavailableReason = 'not-started' | 'start-failed' | 'stopped';

/**
 * A configured harness cannot be addressed: it was never started, its adapter
 * failed to start, or the pool has been stopped. The native failure is not
 * forwarded (adapter errors may contain process or environment details).
 */
export class HarnessUnavailableError extends Error {
  constructor(
    readonly harness: string,
    readonly reason: HarnessUnavailableReason,
  ) {
    const detail =
      reason === 'start-failed'
        ? 'the adapter failed to start'
        : reason === 'stopped'
          ? 'the adapter pool has been stopped'
          : 'the harness was not started';
    super(`Harness '${harness}' is unavailable: ${detail}`);
    this.name = 'HarnessUnavailableError';
  }
}

export interface AdapterPoolOptions {
  /** Build one adapter per harness; the pool starts it and owns the workspace. */
  readonly createAdapter: (harness: string) => Promise<HarnessAdapter> | HarnessAdapter;
  /** Workspace factory override for tests; defaults to a plain `Workspace`. */
  readonly createWorkspace?: (adapter: HarnessAdapter, harness: string) => Workspace;
}

interface PoolEntry {
  readonly adapter: HarnessAdapter;
  readonly workspace: Workspace;
}

/**
 * One adapter and one Workspace per configured harness.
 *
 * A harness whose adapter cannot start is marked unavailable instead of
 * failing the whole pool: the daemon keeps serving the harnesses that did
 * start. Starting and stopping are idempotent, and stop releases harnesses in
 * reverse start order. Calls are serialized so two concurrent `start` calls
 * cannot create two adapters for one harness.
 */
export class AdapterPool {
  private readonly createAdapter: AdapterPoolOptions['createAdapter'];
  private readonly createWorkspace: AdapterPoolOptions['createWorkspace'];
  private readonly entries = new Map<string, PoolEntry>();
  private readonly failedHarnesses = new Set<string>();
  private startQueue: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(options: AdapterPoolOptions) {
    if (typeof options.createAdapter !== 'function') {
      throw new TypeError('createAdapter must be a function');
    }
    this.createAdapter = options.createAdapter;
    this.createWorkspace = options.createWorkspace;
  }

  /**
   * Start every requested harness that is not already started. A harness that
   * fails is recorded as unavailable and is not retried by a later call.
   */
  start(harnesses: readonly string[]): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error('AdapterPool has been stopped'));
    }
    const names = [...new Set(harnesses)];
    const run = this.startQueue.then(async () => {
      for (const harness of names) {
        if (this.stopped) {
          return;
        }
        if (this.entries.has(harness) || this.failedHarnesses.has(harness)) {
          continue;
        }
        await this.startOne(harness);
      }
    });
    // Keep the serialization chain alive after a rejected start call.
    this.startQueue = run.catch(() => undefined);
    return run;
  }

  adapterFor(harness: string): HarnessAdapter {
    return this.entryFor(harness).adapter;
  }

  workspaceFor(harness: string): Workspace {
    return this.entryFor(harness).workspace;
  }

  /** Harnesses that started successfully, in start order. */
  harnesses(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** Stop every started workspace in reverse start order. Idempotent. */
  stop(): Promise<void> {
    if (this.stopPromise === undefined) {
      this.stopped = true;
      this.stopPromise = this.startQueue.then(() => this.stopAll());
    }
    return this.stopPromise;
  }

  private async startOne(harness: string): Promise<void> {
    let adapter: HarnessAdapter | undefined;
    try {
      adapter = await this.createAdapter(harness);
      await adapter.start();
      const workspace = this.createWorkspace?.(adapter, harness) ?? new Workspace(adapter);
      if (this.stopped) {
        // stop() raced this start; release the adapter instead of publishing
        // an entry that no caller can stop.
        await workspace.stop().catch(() => undefined);
        return;
      }
      this.entries.set(harness, { adapter, workspace });
    } catch {
      this.failedHarnesses.add(harness);
      if (adapter !== undefined) {
        await adapter.stop().catch(() => undefined);
      }
    }
  }

  private async stopAll(): Promise<void> {
    const entries = [...this.entries.values()].reverse();
    this.entries.clear();
    let firstError: unknown;
    for (const entry of entries) {
      try {
        // Workspace.stop() is also the adapter's stop owner.
        await entry.workspace.stop();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  private entryFor(harness: string): PoolEntry {
    const entry = this.entries.get(harness);
    if (entry !== undefined) {
      return entry;
    }
    if (this.stopped) {
      throw new HarnessUnavailableError(harness, 'stopped');
    }
    if (this.failedHarnesses.has(harness)) {
      throw new HarnessUnavailableError(harness, 'start-failed');
    }
    throw new HarnessUnavailableError(harness, 'not-started');
  }
}
