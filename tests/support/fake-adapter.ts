import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../../src/adapters/harness.js';
import type { AttachmentDraft } from '../../src/content.js';
import type { Project } from '../../src/kernel.js';

export type FakeTerminal = 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface FakeAdapterOptions {
  readonly terminal?: FakeTerminal;
  readonly output?: string;
  readonly error?: string;
  /** Emit one approval request before the terminal event. */
  readonly askApproval?: boolean;
}

const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: 'accept', kind: 'allow_once', label: 'Allow once' },
  { id: 'decline', kind: 'reject_once', label: 'Reject' },
];

/**
 * Scripted HarnessAdapter for bridge/CLI tests. It never touches a native
 * process: submit emits output and exactly one terminal event on the next tick.
 */
export class FakeAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    resume: false,
  };

  readonly prompts: string[] = [];
  readonly submittedAttachments: (readonly AttachmentDraft[])[] = [];
  readonly approvals: ApprovalDecision[] = [];
  startCalls = 0;
  stopCalls = 0;

  private readonly options: FakeAdapterOptions;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private conversationSeq = 0;
  private pendingApproval: { readonly executionId: string; readonly requestId: string } | undefined;

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async createConversation(_project: Project): Promise<string> {
    this.conversationSeq += 1;
    return `native-${String(this.conversationSeq)}`;
  }

  async submit(
    _nativeId: string,
    executionId: string,
    text: string,
    attachments: readonly AttachmentDraft[] = [],
  ): Promise<void> {
    this.prompts.push(text);
    this.submittedAttachments.push([...attachments]);
    setTimeout(() => {
      this.emit({ type: 'execution/started', executionId });
      if (this.options.askApproval === true) {
        const request: ApprovalRequest = {
          requestId: `req-${executionId}`,
          executionId,
          summary: 'run a command',
          options: APPROVAL_OPTIONS,
        };
        this.pendingApproval = { executionId, requestId: request.requestId };
        this.emit({ type: 'execution/approval-requested', executionId, request });
        return;
      }
      this.finish(executionId);
    }, 0);
  }

  async cancel(_nativeId: string): Promise<void> {}

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
    const pending = this.pendingApproval;
    if (pending === undefined || pending.requestId !== decision.requestId) {
      throw new Error(`Unknown approval request: ${decision.requestId}`);
    }
    this.pendingApproval = undefined;
    setTimeout(() => {
      this.finish(pending.executionId);
    }, 0);
  }

  async closeConversation(_nativeId: string): Promise<void> {}

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private finish(executionId: string): void {
    const output = this.options.output ?? '';
    if (output !== '') {
      this.emit({ type: 'execution/output', executionId, channel: 'assistant', text: output });
    }

    const terminal = this.options.terminal ?? 'completed';
    switch (terminal) {
      case 'completed':
        this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
        return;
      case 'failed':
        this.emit({ type: 'execution/failed', executionId, error: this.options.error ?? 'failed' });
        return;
      case 'cancelled':
        this.emit({ type: 'execution/cancelled', executionId });
        return;
      case 'unknown':
        this.emit({ type: 'execution/unknown', executionId, reason: this.options.error ?? 'unknown' });
    }
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
