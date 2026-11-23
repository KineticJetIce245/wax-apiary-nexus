import assert from 'node:assert/strict';

import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../../src/adapters/harness.js';
import {
  GraphAnswerError,
  GraphHost,
  type GraphNodeStatus,
  type GraphRunResult,
  type GraphStatus,
} from '../../src/daemon/graph-host.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import type { Project } from '../../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type NodeDefinition,
  type NodeId,
  type PheromoneFieldSnapshot,
  type Value,
} from '../../src/runtime/index.js';
import type { AttachmentDraft } from '../../src/shared/content.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';

export const FIXED_NOW = '2026-11-06T22:00:00.000Z';

const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: 'accept', kind: 'allow_once', label: 'Allow once' },
  { id: 'decline', kind: 'reject_once', label: 'Reject' },
];

export class FakeClock {
  time: number;

  constructor(time = 1_000) {
    this.time = time;
  }

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

/**
 * Event-driven fake adapter. A submit emits its terminal events synchronously,
 * or parks the execution until `releaseHeld()` when `holdSubmissions` is set.
 * It never uses timers, and records prompts per native session as well as every
 * close, so tests can prove which session actually ran or was closed.
 *
 * With `askApproval`, a submit parks an approval request instead of finishing;
 * `respondToApproval` records the decision and then completes the execution.
 */
export class RecordingAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    rename: false,
    resume: false,
  };

  readonly allPrompts: string[] = [];
  readonly promptsByNative = new Map<string, string[]>();
  readonly createdNativeIds: string[] = [];
  readonly closedNativeIds: string[] = [];
  readonly approvals: ApprovalDecision[] = [];
  holdSubmissions = false;

  private readonly askApproval: boolean;
  private readonly pendingApprovals = new Map<
    string,
    { readonly nativeId: string; readonly executionId: string; readonly prompt: string }
  >();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly held = new Map<
    string,
    { readonly nativeId: string; readonly prompt: string; readonly executionId: string }
  >();
  private readonly submitWaiters: Array<() => void> = [];
  private nativeSeq = 0;

  constructor(options: { readonly askApproval?: boolean } = {}) {
    this.askApproval = options.askApproval ?? false;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createConversation(_project: Project): Promise<string> {
    this.nativeSeq += 1;
    const nativeId = `native-${String(this.nativeSeq)}`;
    this.createdNativeIds.push(nativeId);
    return nativeId;
  }

  async submit(
    nativeId: string,
    executionId: string,
    text: string,
    _attachments?: readonly AttachmentDraft[],
  ): Promise<void> {
    this.allPrompts.push(text);
    const prompts = this.promptsByNative.get(nativeId) ?? [];
    prompts.push(text);
    this.promptsByNative.set(nativeId, prompts);

    for (const resolve of this.submitWaiters.splice(0)) {
      resolve();
    }

    if (this.holdSubmissions) {
      this.held.set(executionId, { nativeId, prompt: text, executionId });
      return;
    }
    if (this.askApproval) {
      const request: ApprovalRequest = {
        requestId: `req-${executionId}`,
        executionId,
        summary: 'run a command',
        options: APPROVAL_OPTIONS,
      };
      this.pendingApprovals.set(request.requestId, { nativeId, executionId, prompt: text });
      this.emit({ type: 'execution/approval-requested', executionId, request });
      return;
    }
    this.finish(nativeId, executionId, text);
  }

  async cancel(_nativeId: string): Promise<void> {}

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
    const pending = this.pendingApprovals.get(decision.requestId);
    if (pending === undefined) {
      throw new Error(`Unknown approval request: ${decision.requestId}`);
    }
    this.pendingApprovals.delete(decision.requestId);
    this.finish(pending.nativeId, pending.executionId, pending.prompt);
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
  }

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** Resolve once at least `count` submits have been recorded. */
  async waitForSubmit(count: number): Promise<void> {
    while (this.allPrompts.length < count) {
      await new Promise<void>((resolve) => {
        this.submitWaiters.push(resolve);
      });
    }
  }

  releaseHeld(): void {
    const pending = [...this.held.values()];
    this.held.clear();
    for (const execution of pending) {
      this.finish(execution.nativeId, execution.executionId, execution.prompt);
    }
  }

  private finish(nativeId: string, executionId: string, prompt: string): void {
    this.emit({
      type: 'execution/output',
      executionId,
      channel: 'assistant',
      text: `reply(${nativeId}):${prompt}`,
    });
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

interface TestEnv {
  readonly adapter: RecordingAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
}

let projectSeq = 0;

export function makeEnv(
  adapter: RecordingAdapter = new RecordingAdapter(),
  registryNow: () => string = () => FIXED_NOW,
): TestEnv {
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `project-${String(projectSeq)}`,
    // A real, existing directory is required by Workspace; no test writes here.
    directory: process.cwd(),
  };
  const registry = new SessionRegistry({ workspaces: new Map([['fake-harness', workspace]]),
    now: registryNow,
  });
  return { adapter, workspace, registry, project };
}

export function text(value: string): Value {
  return { kind: 'text', text: value };
}

/**
 * Await a trigger in a fixture whose sessions are unique per live, so it must
 * run immediately. Prompt admission is in the adapter; a busy session would
 * reject here, so a resolved run is the synchronous result a test expects.
 */
export async function triggerRun(
  host: GraphHost,
  graphId: string,
  nodeId: NodeId,
  value: Value,
): Promise<GraphRunResult> {
  return host.trigger(graphId, nodeId, value);
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => {
      settle?.();
    },
  };
}

export function forager(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'fake', prompt } };
}

/**
 * Validates the graph with parseComposition, then rewrites node pacing to 0 so
 * one trigger can reach Rest without sleeping. GraphHost must not sleep between
 * pumps; a production graph that is deliberately paced just stops at maxPumps.
 */
export function fastDefinition(
  id: string,
  nodes: Record<string, unknown>,
  edges: readonly Record<string, unknown>[] = [],
): CompositionDefinition {
  const parsed = parseComposition({ schemaVersion: 1, id, nodes, edges });
  const fastNodes = new Map<NodeId, NodeDefinition>();
  for (const [nodeId, node] of parsed.nodes) {
    fastNodes.set(nodeId, { ...node, minIntervalMs: 0 });
  }
  return { ...parsed, nodes: fastNodes };
}

export function allFresh(definition: CompositionDefinition): GraphBindings {
  const bindings: Record<string, { readonly kind: 'fresh' }> = {};
  for (const node of definition.nodes.values()) {
    if (node.kind === 'forager') {
      bindings[node.id] = { kind: 'fresh' };
    }
  }
  return bindings;
}

export function promptsFor(adapter: RecordingAdapter, nativeId: string): readonly string[] {
  const prompts = adapter.promptsByNative.get(nativeId);
  assert.ok(prompts !== undefined, `no prompt reached native session '${nativeId}'`);
  return prompts;
}

export function nodeStatus(status: GraphStatus, nodeId: NodeId): GraphNodeStatus {
  const node = status.nodes.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(node !== undefined, `status has no node '${nodeId}'`);
  return node;
}

/**
 * White-box read of the Workspace event subscriptions. Each forager executor
 * subscribes once; a disposed routing table unsubscribes every child. This is
 * the observable proof that unload actually disposed the executors.
 */
export function workspaceListenerCount(workspace: Workspace): number {
  return (workspace as unknown as { readonly listeners: ReadonlySet<unknown> }).listeners.size;
}

/**
 * Test-only access to the live runtime. It is used only to inspect a hover
 * token or to park/queue work that no public host method can reach without
 * pumping; production behavior is exercised through the host itself.
 */
interface RuntimeTestAccess {
  answerHover(nodeId: string, value: Value, token?: string): void;
  trigger(nodeId: string, value: Value): string;
  pump(): Promise<void>;
  snapshot(): PheromoneFieldSnapshot;
}

export function runtimeOf(host: GraphHost, graphId: string): RuntimeTestAccess {
  const graphs = (host as unknown as {
    context: {
      graphs: {
        peek(id: string): { readonly value: { readonly runtime: RuntimeTestAccess } } | undefined;
      };
    };
  }).context.graphs;
  const entry = graphs.peek(graphId);
  assert.ok(entry !== undefined, `graph '${graphId}' is not loaded`);
  return entry.value.runtime;
}

export function hoverTokenOf(host: GraphHost, graphId: string, nodeId: string): string {
  const hover = runtimeOf(host, graphId).snapshot().nodes[nodeId]?.hover;
  assert.ok(hover !== undefined, `node '${nodeId}' has no open hover`);
  return hover.token;
}

export function isAnswerError(reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof GraphAnswerError);
    assert.equal(error.reason, reason);
    return true;
  };
}

export function userNode(prompt = 'say something'): Record<string, unknown> {
  return { kind: 'user', config: { modality: 'text', prompt } };
}

/** A user node plus a forager so unload has a fresh session to close. */
export function userAndForagerGraph(id: string): CompositionDefinition {
  return fastDefinition(id, {
    idle: forager('idle {{input}}'),
    ask: userNode(),
  });
}

export function runnableForagerGraph(id: string, prompt = 'run {{input}}'): CompositionDefinition {
  return fastDefinition(id, { only: forager(prompt) });
}

/**
 * A fork/merge graph that keeps the production 1000ms node pacing. One pump
 * cannot reach Rest because the merge waits for its second activation.
 */
export function pacedForkMergeDefinition(id: string): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      start: forager('start {{input}}'),
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'branch-a' },
            { id: 'b', to: 'branch-b' },
          ],
        },
      },
      'branch-a': forager('branch-a {{input}}'),
      'branch-b': forager('branch-b {{input}}'),
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'branch-a', to: 'merge' },
      { id: 'e3', from: 'branch-b', to: 'merge' },
    ],
  });
}
