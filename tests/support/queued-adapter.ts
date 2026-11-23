import type {
  ApprovalDecision,
  ConversationOptions,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../../src/adapters/harness.js';
import type { AttachmentDraft } from '../../src/shared/content.js';
import type { Project } from '../../src/project/kernel.js';

interface QueuedPrompt {
  readonly executionId: string;
  readonly text: string;
}

interface SessionState {
  active: QueuedPrompt | undefined;
  readonly waiting: QueuedPrompt[];
}

/**
 * Minimal queue-capable adapter. It sends one prompt at a time, keeps the rest
 * FIFO, and exposes the native-side state so tests can prove the Workspace
 * promotes, releases and cancels the right execution. It never uses timers: a
 * test calls `completeActive` to settle the run.
 */
export class QueuedAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    rename: false,
    resume: false,
    queue: true,
  };

  readonly prompts: Array<{ nativeId: string; executionId: string; text: string }> = [];
  readonly startedIds: string[] = [];
  readonly droppedIds: string[] = [];
  readonly cancels: string[] = [];
  readonly closedNativeIds: string[] = [];
  readonly terminalIds: string[] = [];
  readonly approvals: ApprovalDecision[] = [];
  readonly closeWaiters: Array<() => void> = [];
  closeShouldFail = false;

  private readonly states = new Map<string, SessionState>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private nativeSeq = 0;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createConversation(
    _project: Project,
    _options?: ConversationOptions,
  ): Promise<string> {
    this.nativeSeq += 1;
    return `queued-native-${String(this.nativeSeq)}`;
  }

  async submit(
    nativeId: string,
    executionId: string,
    text: string,
    _attachments?: readonly AttachmentDraft[],
  ): Promise<void> {
    this.prompts.push({ nativeId, executionId, text });
    const state = this.stateOf(nativeId);
    const prompt: QueuedPrompt = { executionId, text };
    if (state.active !== undefined) {
      state.waiting.push(prompt);
      return;
    }
    this.send(nativeId, state, prompt);
  }

  async cancel(nativeId: string): Promise<void> {
    this.cancels.push(nativeId);
  }

  async dropQueued(nativeId: string, executionId: string): Promise<boolean> {
    const state = this.states.get(nativeId);
    if (state === undefined) {
      return false;
    }
    const index = state.waiting.findIndex((prompt) => prompt.executionId === executionId);
    if (index === -1) {
      return false;
    }
    state.waiting.splice(index, 1);
    this.droppedIds.push(executionId);
    this.emit({ type: 'execution/cancelled', executionId });
    return true;
  }

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
    for (const resolve of this.closeWaiters.splice(0)) {
      resolve();
    }
    if (this.closeShouldFail) {
      throw new Error('close refused');
    }
    const state = this.states.get(nativeId);
    if (state !== undefined) {
      for (const prompt of state.waiting.splice(0)) {
        this.emit({ type: 'execution/cancelled', executionId: prompt.executionId });
      }
    }
  }

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** Settle the prompt the adapter is actually running, then start the next. */
  completeActive(nativeId: string, output = 'done'): string | undefined {
    const state = this.states.get(nativeId);
    const active = state?.active;
    if (state === undefined || active === undefined) {
      return undefined;
    }
    state.active = undefined;
    this.terminalIds.push(active.executionId);
    if (output !== '') {
      this.emit({ type: 'execution/output', executionId: active.executionId, channel: 'assistant', text: output });
    }
    this.emit({ type: 'execution/completed', executionId: active.executionId, stopReason: 'end_turn' });
    const next = state.waiting.shift();
    if (next !== undefined) {
      this.send(nativeId, state, next);
    }
    return active.executionId;
  }

  activeExecutionId(nativeId: string): string | undefined {
    return this.states.get(nativeId)?.active?.executionId;
  }

  waitingExecutionIds(nativeId: string): readonly string[] {
    return (this.states.get(nativeId)?.waiting ?? []).map((prompt) => prompt.executionId);
  }

  private stateOf(nativeId: string): SessionState {    let state = this.states.get(nativeId);
    if (state === undefined) {
      state = { active: undefined, waiting: [] };
      this.states.set(nativeId, state);
    }
    return state;
  }

  private send(nativeId: string, state: SessionState, prompt: QueuedPrompt): void {
    state.active = prompt;
    this.startedIds.push(prompt.executionId);
    this.emit({ type: 'execution/started', executionId: prompt.executionId });
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
