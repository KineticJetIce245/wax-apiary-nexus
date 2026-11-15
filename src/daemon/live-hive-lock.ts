/**
 * Per-LiveHive serialization for mutating host operations.
 *
 * Runs for the same `liveId` execute one at a time in call order; different
 * ids run in parallel. An operation failure rejects its own caller but never
 * poisons the next queued operation. Read-only status/list paths intentionally
 * do not go through this lock.
 */
export class LiveHiveLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(liveId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(liveId) ?? Promise.resolve();
    const result = previous.then(() => op());
    // The queue always advances, even when this operation rejects.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(liveId, tail);
    return result.finally(() => {
      if (this.tails.get(liveId) === tail) {
        this.tails.delete(liveId);
      }
    });
  }

  /**
   * Acquire the per-live slot only if it is currently idle. This preserves
   * callers with documented "refused while busy" behavior (for example an
   * explicit unload) without waiting behind an in-flight trigger.
   */
  tryRun<T>(
    liveId: string,
    op: () => Promise<T>,
  ): Promise<{ readonly acquired: true; readonly value: T } | { readonly acquired: false }> {
    if (this.tails.has(liveId)) {
      return Promise.resolve({ acquired: false });
    }
    return this.run(liveId, async () => ({
      acquired: true as const,
      value: await op(),
    }));
  }
}
