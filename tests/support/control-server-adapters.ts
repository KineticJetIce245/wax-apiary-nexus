import type { ConversationOptions } from '../../src/adapters/harness.js';
import type { Project } from '../../src/project/kernel.js';
import {
  SessionRegistry,
  type SweepSessionsReport,
} from '../../src/session/session-registry.js';
import { FakeAdapter, type FakeAdapterOptions } from './fake-adapter.js';

/**
 * FakeAdapter whose first conversation creation blocks on a gate, so a second
 * HTTP request provably arrives while the graph is still loading.
 */
export class GatedFakeAdapter extends FakeAdapter {
  private releaseGate: (() => void) | undefined;
  private signalStarted: (() => void) | undefined;
  readonly gate: Promise<void> = new Promise<void>((resolveGate) => {
    this.releaseGate = resolveGate;
  });
  readonly createStarted: Promise<void> = new Promise<void>((resolveStarted) => {
    this.signalStarted = resolveStarted;
  });

  override async createConversation(
    project: Project,
    options?: ConversationOptions,
  ): Promise<string> {
    this.signalStarted?.();
    await this.gate;
    return await super.createConversation(project, options);
  }

  release(): void {
    this.releaseGate?.();
  }
}

/** Counts native closes so a retained session is provable, not assumed. */
export class TrackingFakeAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
    await super.closeConversation(nativeId);
  }
}

/**
 * A submit that never emits a terminal event. The session stays busy without
 * relying on approval timing, so the busy-state assertions are deterministic.
 */
export class HoldingFakeAdapter extends TrackingFakeAdapter {
  override async submit(
    _nativeId: string,
    _executionId: string,
    _text: string,
  ): Promise<void> {}
}

interface HeldSubmission {
  readonly nativeId: string;
  readonly executionId: string;
  readonly text: string;
}

/**
 * Submissions stay parked until the test finishes them one at a time, so a
 * second wake provably arrives while the shared session is still executing.
 * The output is derived from the rendered prompt, which lets a test prove that
 * two LiveHives' outputs did not cross.
 */
export class SteppedFakeAdapter extends TrackingFakeAdapter {
  readonly held: HeldSubmission[] = [];
  private readonly outputPrefix: string;

  constructor(options: FakeAdapterOptions & { readonly outputPrefix?: string } = {}) {
    const { outputPrefix, ...adapterOptions } = options;
    super(adapterOptions);
    this.outputPrefix = outputPrefix ?? 'echo:';
  }

  get heldCount(): number {
    return this.held.length;
  }

  override async submit(nativeId: string, executionId: string, text: string): Promise<void> {
    this.prompts.push(text);
    this.held.push({ nativeId, executionId, text });
  }

  /** Complete the oldest parked execution; returns the emitted output text. */
  finishNext(): string | undefined {
    const next = this.held.shift();
    if (next === undefined) {
      return undefined;
    }
    const output = `${this.outputPrefix}${next.text}`;
    this.emit({
      type: 'execution/output',
      executionId: next.executionId,
      channel: 'assistant',
      text: output,
    });
    this.emit({
      type: 'execution/completed',
      executionId: next.executionId,
      stopReason: 'end_turn',
    });
    return output;
  }

  /** Test cleanup: complete everything still parked. */
  finishAll(): void {
    while (this.heldCount > 0) {
      this.finishNext();
    }
  }
}

/** A native close that fails with a marker that must never reach a response. */
export class FailingCloseFakeAdapter extends FakeAdapter {
  override async closeConversation(_nativeId: string): Promise<void> {
    throw new Error('native close failed: NATIVE_CLOSE_SECRET');
  }
}

/** A registry whose automatic sweep always fails, for daemon-resilience tests. */
export class ThrowingSweepRegistry extends SessionRegistry {
  sweepCalls = 0;

  override async sweepIdle(): Promise<SweepSessionsReport> {
    this.sweepCalls += 1;
    throw new Error('SWEEP_SECRET');
  }
}
