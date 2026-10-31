import { randomUUID } from 'node:crypto';
import { SubmitOutcomeUnknownError } from './adapters/harness.js';
import {
  FlowTemplateError,
  renderTemplate,
  type FlowCondition,
  type FlowDefinition,
  type FlowNode,
  type FlowParallelNode,
  type FlowSubmitNode,
} from './flow-definition.js';
import {
  cloneAttachment,
  toAttachmentDraft,
  type Attachment,
  type AttachmentDraft,
} from './content.js';
import type { Execution } from './workspace.js';
import type { Workbench } from './workbench.js';

export type FlowStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type FlowNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface FlowNodeState {
  readonly nodeId: string;
  readonly status: FlowNodeStatus;
  readonly executionId?: string;
  readonly connection?: string;
  readonly output?: string;
  readonly attachments?: readonly Attachment[];
  readonly error?: string;
}

export interface FlowResult {
  readonly flowId: string;
  readonly status: Exclude<FlowStatus, 'idle' | 'running'>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly nodes: Readonly<Record<string, FlowNodeState>>;
  readonly error?: string;
}

export type FlowEvent =
  | { readonly type: 'flow/started'; readonly flowId: string; readonly version: 1 }
  | {
      readonly type: 'node/started';
      readonly flowId: string;
      readonly nodeId: string;
      readonly connection: string;
      readonly executionId: string;
    }
  | {
      readonly type: 'node/completed';
      readonly flowId: string;
      readonly nodeId: string;
      readonly executionId: string;
      readonly output: string;
    }
  | {
      readonly type: 'node/failed';
      readonly flowId: string;
      readonly nodeId: string;
      readonly status: 'failed' | 'cancelled' | 'unknown';
      readonly connection?: string;
      readonly executionId?: string;
      readonly error?: string;
    }
  | {
      readonly type: 'flow/completed';
      readonly flowId: string;
      readonly outputs: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'flow/failed';
      readonly flowId: string;
      readonly status: 'failed' | 'unknown';
      readonly error: string;
      readonly outputs: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'flow/cancelled';
      readonly flowId: string;
      readonly outputs: Readonly<Record<string, string>>;
    };

export interface FlowRuntimeOptions {
  readonly pollIntervalMs?: number;
}

interface MutableNodeState {
  readonly nodeId: string;
  status: FlowNodeStatus;
  executionId: string | undefined;
  connection: string | undefined;
  output: string | undefined;
  attachments: Attachment[] | undefined;
  error: string | undefined;
}

interface SubmitOutcome {
  readonly nodeId: string;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly output?: string;
  readonly attachments?: readonly Attachment[];
  readonly error?: string;
}

interface ActiveExecution {
  readonly connection: string;
  readonly executionId: string;
}

/**
 * Executes one validated graph flow over a Workbench. Nodes are ordinary turns
 * on existing conversations; the runtime only decides which turn comes next.
 * One connection can run at most one node because Workbench/Workspace own a
 * single native conversation per connection.
 */
export class FlowRuntime {
  readonly flowId: string;
  private readonly workbench: Workbench;
  private readonly definition: FlowDefinition;
  private readonly pollIntervalMs: number;
  private readonly outputs = new Map<string, string>();
  private readonly nodeAttachments = new Map<string, readonly Attachment[]>();
  private readonly states = new Map<string, MutableNodeState>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly listeners = new Set<(event: FlowEvent) => void>();
  private statusValue: FlowStatus = 'idle';
  private cancelRequested = false;
  private aborted = false;
  private abortCause: SubmitOutcome | undefined;
  private started = false;
  private resultValue: FlowResult | undefined;

  constructor(workbench: Workbench, definition: FlowDefinition, options: FlowRuntimeOptions = {}) {
    this.workbench = workbench;
    this.definition = definition;
    this.flowId = definition.id ?? `flow-${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    for (const nodeId of Object.keys(definition.nodes)) {
      this.states.set(nodeId, {
        nodeId,
        status: 'pending',
        executionId: undefined,
        connection: undefined,
        output: undefined,
        attachments: undefined,
        error: undefined,
      });
    }
  }

  get status(): FlowStatus {
    return this.statusValue;
  }

  get result(): FlowResult | undefined {
    return this.resultValue === undefined ? undefined : cloneFlowResult(this.resultValue);
  }

  onEvent(handler: (event: FlowEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async run(): Promise<FlowResult> {
    if (this.started) {
      throw new Error(`Flow ${this.flowId} has already been started`);
    }
    this.started = true;
    this.statusValue = 'running';
    this.emit({ type: 'flow/started', flowId: this.flowId, version: 1 });

    const missing = this.usedConnections().filter(
      (connection) => this.workbench.getConnection(connection)?.status !== 'ready',
    );
    if (missing.length > 0) {
      return this.finish('failed', `Connection not available: ${[...new Set(missing)].join(', ')}`);
    }

    try {
      let current: string | undefined = this.definition.start;
      while (current !== undefined) {
        if (this.cancelRequested) {
          return this.finish('cancelled');
        }
        const node: FlowNode | undefined = this.definition.nodes[current];
        if (node === undefined) {
          return this.finish('failed', `Unknown node reached: ${current}`);
        }
        if (node.type === 'end') {
          this.state(current).status = 'completed';
          return this.finish('completed');
        }
        if (node.type === 'parallel') {
          const outcome = await this.runParallel(current, node);
          if (outcome !== undefined) {
            return this.finish(mapFlowStatus(outcome.status), outcome.error);
          }
          current = node.next;
          continue;
        }
        const outcome = await this.runSubmit(current, node);
        if (outcome.status !== 'completed') {
          return this.finish(mapFlowStatus(outcome.status), outcome.error);
        }
        this.outputs.set(current, outcome.output ?? '');
        this.nodeAttachments.set(current, outcome.attachments ?? []);
        current = selectNext(node, outcome.output ?? '');
      }
      return this.finish('failed', 'Flow ended without an end node');
    } catch (error) {
      await this.cancelActiveExecutions().catch(() => undefined);
      return this.finish('failed', messageOf(error));
    }
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.statusValue !== 'running') {
      return;
    }
    await this.cancelActiveExecutions();
  }

  private async runParallel(
    nodeId: string,
    node: FlowParallelNode,
  ): Promise<SubmitOutcome | undefined> {
    this.state(nodeId).status = 'running';
    const outcomes = await Promise.all(
      node.branches.map((branchId) => {
        const branch = this.definition.nodes[branchId];
        if (branch === undefined || branch.type !== 'submit') {
          throw new Error(`Parallel branch ${branchId} is not a submit node`);
        }
        return this.runSubmit(branchId, branch);
      }),
    );

    for (const outcome of outcomes) {
      if (outcome.status === 'completed') {
        this.outputs.set(outcome.nodeId, outcome.output ?? '');
        this.nodeAttachments.set(outcome.nodeId, outcome.attachments ?? []);
      }
    }

    if (this.abortCause !== undefined) {
      this.state(nodeId).status = this.abortCause.status;
      return this.abortCause;
    }
    if (this.cancelRequested) {
      this.state(nodeId).status = 'cancelled';
      return { nodeId, status: 'cancelled' };
    }
    const failed = outcomes.find((outcome) => outcome.status !== 'completed');
    if (failed !== undefined) {
      this.state(nodeId).status = failed.status;
      await this.cancelActiveExecutions();
      return failed;
    }
    this.state(nodeId).status = 'completed';
    return undefined;
  }

  private async runSubmit(nodeId: string, node: FlowSubmitNode): Promise<SubmitOutcome> {
    if (this.cancelRequested) {
      const state = this.state(nodeId);
      state.status = 'cancelled';
      state.error = 'Flow cancelled before this node started';
      return { nodeId, status: 'cancelled', error: state.error };
    }
    if (this.aborted) {
      const message = `Node ${nodeId} was not started because another node aborted the flow`;
      const state = this.state(nodeId);
      state.status = 'cancelled';
      state.error = message;
      this.emit({
        type: 'node/failed',
        flowId: this.flowId,
        nodeId,
        status: 'cancelled',
        error: message,
      });
      return { nodeId, status: 'cancelled', error: message };
    }
    const state = this.state(nodeId);
    let prompt: string;
    let inputAttachments: AttachmentDraft[];
    try {
      prompt = renderTemplate(node.prompt, (name) => {
        if (name === 'input') {
          return this.definition.input;
        }
        return this.outputs.get(name);
      });
      inputAttachments = this.collectAttachments(nodeId, node);
    } catch (error) {
      const message = messageOf(error);
      state.status = 'failed';
      state.error = message;
      this.recordAbort({ nodeId, status: 'failed', error: message });
      this.emit({ type: 'node/failed', flowId: this.flowId, nodeId, status: 'failed', error: message });
      return { nodeId, status: 'failed', error: message };
    }

    const connection = this.definition.participants[node.participant]?.connection;
    if (connection === undefined) {
      const message = `Unknown participant ${node.participant}`;
      state.status = 'failed';
      state.error = message;
      this.recordAbort({ nodeId, status: 'failed', error: message });
      this.emit({ type: 'node/failed', flowId: this.flowId, nodeId, status: 'failed', error: message });
      return { nodeId, status: 'failed', error: message };
    }

    let executionId: string;
    try {
      const submitted = await this.workbench.submit(prompt, connection, inputAttachments);
      executionId = submitted.execution.id;
    } catch (error) {
      const status = error instanceof SubmitOutcomeUnknownError ? 'unknown' : 'failed';
      const message = messageOf(error);
      state.status = status;
      state.error = message;
      state.connection = connection;
      this.recordAbort({ nodeId, status, error: message });
      this.emit({
        type: 'node/failed',
        flowId: this.flowId,
        nodeId,
        status,
        connection,
        error: message,
      });
      return { nodeId, status, error: message };
    }

    state.status = 'running';
    state.executionId = executionId;
    state.connection = connection;
    this.active.set(nodeId, { connection, executionId });
    this.emit({ type: 'node/started', flowId: this.flowId, nodeId, connection, executionId });

    // A cancel or a sibling failure may arrive between submit() starting and
    // the active entry existing. Cancel after registration so the wait below
    // cannot block on a turn nobody is stopping.
    if (this.cancelRequested || this.aborted) {
      try {
        await this.workbench.cancel(connection, executionId);
      } catch {
        // The execution may already have settled; its terminal event wins.
      }
    }

    const execution = await this.waitForTerminal(connection, executionId).catch(async (error: unknown) => {
      this.active.delete(nodeId);
      const message = messageOf(error);
      state.status = 'failed';
      state.error = message;
      this.emit({
        type: 'node/failed',
        flowId: this.flowId,
        nodeId,
        status: 'failed',
        connection,
        executionId,
        error: message,
      });
      this.recordAbort({ nodeId, status: 'failed', error: message });
      await this.cancelActiveExecutions();
      return undefined;
    });
    if (execution === undefined) {
      return {
        nodeId,
        status: 'failed',
        error: state.error ?? 'Execution is no longer available',
      };
    }
    this.active.delete(nodeId);
    state.output = execution.output;
    state.error = execution.error;

    if (execution.state === 'completed') {
      state.status = 'completed';
      state.attachments = execution.attachments.map(cloneAttachment);
      this.emit({
        type: 'node/completed',
        flowId: this.flowId,
        nodeId,
        executionId,
        output: execution.output,
      });
      return {
        nodeId,
        status: 'completed',
        output: execution.output,
        attachments: state.attachments,
      };
    }

    const status: 'failed' | 'cancelled' | 'unknown' =
      execution.state === 'failed' ? 'failed' : execution.state === 'cancelled' ? 'cancelled' : 'unknown';
    state.status = status;
    this.emit({
      type: 'node/failed',
      flowId: this.flowId,
      nodeId,
      status,
      connection,
      executionId,
      ...(execution.error === undefined ? {} : { error: execution.error }),
    });
    this.recordAbort({
      nodeId,
      status,
      ...(execution.error === undefined ? {} : { error: execution.error }),
    });
    if (!this.cancelRequested) {
      await this.cancelActiveExecutions();
    }
    return {
      nodeId,
      status,
      ...(execution.error === undefined ? {} : { error: execution.error }),
    };
  }

  private collectAttachments(nodeId: string, node: FlowSubmitNode): AttachmentDraft[] {
    const drafts: AttachmentDraft[] = [];
    const seen = new Set<string>();
    for (const sourceId of node.attachments ?? []) {
      const source = this.nodeAttachments.get(sourceId);
      if (source === undefined) {
        throw new FlowTemplateError(
          `Attachments from node ${sourceId} are not available on the path to ${nodeId}`,
        );
      }
      for (const attachment of source) {
        if (seen.has(attachment.id)) {
          continue;
        }
        seen.add(attachment.id);
        drafts.push(toAttachmentDraft(attachment));
      }
    }
    return drafts;
  }

  private recordAbort(outcome: SubmitOutcome): void {
    if (outcome.status === 'completed' || this.cancelRequested) {
      return;
    }
    if (this.abortCause === undefined) {
      this.abortCause = outcome;
      this.aborted = true;
    }
  }

  private async waitForTerminal(connection: string, executionId: string): Promise<Execution> {
    while (true) {
      const found = this.workbench.getExecution(connection, executionId);
      if (found === undefined) {
        throw new Error(
          `Execution ${executionId} on ${connection} is no longer available`,
        );
      }
      if (found.execution.state !== 'running') {
        return found.execution;
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async cancelActiveExecutions(): Promise<void> {
    const active = [...this.active.values()];
    await Promise.all(
      active.map(async (entry) => {
        try {
          await this.workbench.cancel(entry.connection, entry.executionId);
        } catch {
          // Cancellation is best-effort; the execution settles via its own events.
        }
      }),
    );
  }

  private finish(
    status: Exclude<FlowStatus, 'idle' | 'running'>,
    error?: string,
  ): FlowResult {
    this.statusValue = status;
    const outputs = Object.fromEntries(this.outputs);
    const nodes = Object.fromEntries(
      [...this.states.values()].map((state) => [state.nodeId, snapshotNode(state)]),
    );
    const result: FlowResult = {
      flowId: this.flowId,
      status,
      outputs,
      nodes,
      ...(error === undefined ? {} : { error }),
    };
    this.resultValue = result;
    if (status === 'completed') {
      this.emit({ type: 'flow/completed', flowId: this.flowId, outputs: { ...outputs } });
    } else if (status === 'cancelled') {
      this.emit({ type: 'flow/cancelled', flowId: this.flowId, outputs: { ...outputs } });
    } else {
      this.emit({
        type: 'flow/failed',
        flowId: this.flowId,
        status,
        error: error ?? 'Flow failed',
        outputs: { ...outputs },
      });
    }
    return cloneFlowResult(result);
  }

  private usedConnections(): string[] {
    const connections = new Set<string>();
    for (const node of Object.values(this.definition.nodes)) {
      if (node.type === 'submit') {
        const connection = this.definition.participants[node.participant]?.connection;
        if (connection !== undefined) {
          connections.add(connection);
        }
      } else if (node.type === 'parallel') {
        for (const branchId of node.branches) {
          const branch = this.definition.nodes[branchId];
          if (branch?.type === 'submit') {
            const connection = this.definition.participants[branch.participant]?.connection;
            if (connection !== undefined) {
              connections.add(connection);
            }
          }
        }
      }
    }
    return [...connections];
  }

  private state(nodeId: string): MutableNodeState {
    const state = this.states.get(nodeId);
    if (state === undefined) {
      throw new Error(`Unknown flow node: ${nodeId}`);
    }
    return state;
  }

  private emit(event: FlowEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Presentation failures must not break the flow.
      }
    }
  }
}

function selectNext(node: FlowSubmitNode, output: string): string {
  const next = node.next;
  if (next === undefined) {
    throw new Error(`Node ${node.type} has no next`);
  }
  return typeof next === 'string' ? next : selectBranch(next, output);
}

function selectBranch(condition: FlowCondition, output: string): string {
  const matched =
    condition.contains !== undefined
      ? output.includes(condition.contains)
      : output === condition.equals;
  return matched ? condition.then : condition.else;
}

function mapFlowStatus(
  status: SubmitOutcome['status'],
): Exclude<FlowStatus, 'idle' | 'running'> {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'unknown':
      return 'unknown';
  }
}

function cloneFlowResult(result: FlowResult): FlowResult {
  return {
    ...result,
    outputs: { ...result.outputs },
    nodes: Object.fromEntries(
      Object.entries(result.nodes).map(([nodeId, state]) => [
        nodeId,
        {
          ...state,
          ...(state.attachments === undefined
            ? {}
            : { attachments: state.attachments.map(cloneAttachment) }),
        },
      ]),
    ),
  };
}

function snapshotNode(state: MutableNodeState): FlowNodeState {  return {
    nodeId: state.nodeId,
    status: state.status,
    ...(state.executionId === undefined ? {} : { executionId: state.executionId }),
    ...(state.connection === undefined ? {} : { connection: state.connection }),
    ...(state.output === undefined ? {} : { output: state.output }),
    ...(state.attachments === undefined
      ? {}
      : { attachments: state.attachments.map(cloneAttachment) }),
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
