import type { HarnessEvent } from '../harness.js';

/** One admitted ACP prompt: the execution id and its native request params. */
export interface NativePrompt {
  readonly executionId: string;
  readonly params: Record<string, unknown>;
}

export interface ActivePrompt {
  readonly sessionId: string;
  readonly executionId: string;
}

export type QueueAbortKind = 'cancelled' | 'failed' | 'unknown';

export interface PromptQueueCallbacks {
  /** Send `session/prompt`; resolve with the ACP result. */
  send(nativeId: string, prompt: NativePrompt): Promise<unknown>;
  emit(event: HarnessEvent): void;
  /** Map one ACP result to exactly one terminal event for the execution. */
  terminal(executionId: string, result: unknown): HarnessEvent;
  /** Map one request failure to exactly one terminal event. */
  failure(executionId: string, error: unknown): HarnessEvent;
}

/**
 * Per-native-session prompt admission for the ACP adapter.
 *
 * At most one prompt is on the wire; every other admitted execution waits in a
 * FIFO and receives `execution/started` only when it is actually sent. Queued
 * prompts are settled with a definite terminal event when the session closes,
 * the adapter stops, or the process disappears, so a caller never waits forever.
 */
export class SessionPromptQueue {
  private readonly active = new Map<string, string>();
  private readonly waiting = new Map<string, NativePrompt[]>();

  constructor(private readonly callbacks: PromptQueueCallbacks) {}

  submit(nativeId: string, prompt: NativePrompt): void {
    if (this.active.has(nativeId)) {
      const waiting = this.waiting.get(nativeId);
      if (waiting === undefined) {
        this.waiting.set(nativeId, [prompt]);
      } else {
        waiting.push(prompt);
      }
      return;
    }
    this.start(nativeId, prompt);
  }

  /** Remove one not-yet-started prompt; the active prompt is untouched. */
  drop(nativeId: string, executionId: string): boolean {
    const waiting = this.waiting.get(nativeId);
    if (waiting === undefined) {
      return false;
    }
    const index = waiting.findIndex((prompt) => prompt.executionId === executionId);
    if (index === -1) {
      return false;
    }
    waiting.splice(index, 1);
    if (waiting.length === 0) {
      this.waiting.delete(nativeId);
    }
    this.callbacks.emit({ type: 'execution/cancelled', executionId });
    return true;
  }

  /** Settle every waiting prompt for one session; the active one is untouched. */
  abortWaiting(nativeId: string, kind: QueueAbortKind, reason: string): void {
    const waiting = this.waiting.get(nativeId);
    if (waiting === undefined) {
      return;
    }
    this.waiting.delete(nativeId);
    for (const prompt of waiting) {
      this.callbacks.emit(this.abortEvent(prompt.executionId, kind, reason));
    }
  }

  abortAll(kind: QueueAbortKind, reason: string): void {
    for (const nativeId of [...this.waiting.keys()]) {
      this.abortWaiting(nativeId, kind, reason);
    }
  }

  activeOf(nativeId: string): ActivePrompt | undefined {
    const executionId = this.active.get(nativeId);
    return executionId === undefined ? undefined : { sessionId: nativeId, executionId };
  }

  activeEntries(): readonly ActivePrompt[] {
    return [...this.active].map(([sessionId, executionId]) => ({ sessionId, executionId }));
  }

  clearActive(): void {
    this.active.clear();
  }

  /** Drop one active entry without emitting a terminal event. */
  forgetActive(nativeId: string): void {
    this.active.delete(nativeId);
  }

  private start(nativeId: string, prompt: NativePrompt): void {
    this.active.set(nativeId, prompt.executionId);
    this.callbacks.emit({ type: 'execution/started', executionId: prompt.executionId });
    let request: Promise<unknown>;
    try {
      request = this.callbacks.send(nativeId, prompt);
    } catch (error) {
      this.finish(nativeId, prompt.executionId, () =>
        this.callbacks.failure(prompt.executionId, error),
      );
      return;
    }
    void request.then(
      (result) => {
        this.finish(nativeId, prompt.executionId, () =>
          this.callbacks.terminal(prompt.executionId, result),
        );
      },
      (error: unknown) => {
        this.finish(nativeId, prompt.executionId, () =>
          this.callbacks.failure(prompt.executionId, error),
        );
      },
    );
  }

  private finish(nativeId: string, executionId: string, event: () => HarnessEvent): void {
    if (this.active.get(nativeId) !== executionId) {
      return;
    }
    this.active.delete(nativeId);
    this.callbacks.emit(event());
    const waiting = this.waiting.get(nativeId);
    if (waiting === undefined) {
      return;
    }
    const next = waiting.shift();
    if (waiting.length === 0) {
      this.waiting.delete(nativeId);
    }
    if (next !== undefined) {
      this.start(nativeId, next);
    }
  }

  private abortEvent(
    executionId: string,
    kind: QueueAbortKind,
    reason: string,
  ): HarnessEvent {
    if (kind === 'failed') {
      return { type: 'execution/failed', executionId, error: reason };
    }
    if (kind === 'unknown') {
      return { type: 'execution/unknown', executionId, reason };
    }
    return { type: 'execution/cancelled', executionId };
  }
}
