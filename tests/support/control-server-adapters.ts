import type { ConversationOptions } from '../../src/adapters/harness.js';
import type { Project } from '../../src/project/kernel.js';
import {
  SessionRegistry,
  type SweepSessionsReport,
} from '../../src/session/session-registry.js';
import { FakeAdapter } from './fake-adapter.js';

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
