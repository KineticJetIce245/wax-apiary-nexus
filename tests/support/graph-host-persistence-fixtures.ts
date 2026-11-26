import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../../src/adapters/harness.js';
import { LiveHiveHost } from '../../src/daemon/graph-host.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import type { Project } from '../../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type NodeDefinition,
  type NodeId,
  type PersistedField,
  type Value,
} from '../../src/runtime/index.js';
import type { AttachmentDraft } from '../../src/shared/content.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { HoneyStore } from '../../src/storage/honey.js';

export const FIXED_NOW = '2026-11-06T22:00:00.000Z';
export const SAVE_ERROR = 'honey save failed: disk full';

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
 * Event-driven fake adapter. `submit` emits its terminal events synchronously,
 * so a trigger settles without timers or sleeps. It records prompts per native
 * session as well as every close, which lets a test prove that a fresh session
 * was replaced and that a failed flush never replays a trigger.
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

  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private nativeSeq = 0;

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
    this.emit({
      type: 'execution/output',
      executionId,
      channel: 'assistant',
      text: `reply(${nativeId}):${text}`,
    });
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  }

  async cancel(_nativeId: string): Promise<void> {}

  async respondToApproval(): Promise<void> {}

  async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
  }

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** Honey wrapper whose save can be made to fail without touching the disk. */
export class FailingHoneyStore extends HoneyStore {
  failSave = false;

  override save(field: PersistedField): void {
    if (this.failSave) {
      throw new Error(SAVE_ERROR);
    }
    super.save(field);
  }
}

interface TestEnv {
  readonly adapter: RecordingAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
}

let projectSeq = 0;

export function makeEnv(adapter: RecordingAdapter = new RecordingAdapter()): TestEnv {
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `project-${String(projectSeq)}`,
    // A real, existing directory is required by Workspace; no test writes here.
    directory: process.cwd(),
  };
  const registry = new SessionRegistry({ workspaces: new Map([['fake-harness', workspace]]),
    now: () => FIXED_NOW,
  });
  return { adapter, workspace, registry, project };
}

export function text(value: string): Value {
  return { message: value };
}

export function forager(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'fake', prompt } };
}

/**
 * Validates the graph with parseComposition, then rewrites node pacing to 0 so
 * one trigger can reach Rest without sleeping.
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

export function runnableForagerGraph(id: string, prompt = 'run {{message}}'): CompositionDefinition {
  return fastDefinition(id, { only: forager(prompt) });
}

/**
 * start -> counter -> done, with the unused `continue` branch required by the
 * counter definition shape. One trigger increments the counter to 1.
 */
export function counterDefinition(id: string): CompositionDefinition {
  return fastDefinition(
    id,
    {
      start: forager('start {{message}}'),
      count: { kind: 'counter', config: { max: 1, step: 1 } },
      again: forager('again {{message}}'),
      done: forager('done {{message}}'),
    },
    [
      { id: 'e1', from: 'start', to: 'count' },
      { id: 'e2', from: 'count', to: 'again', when: 'continue' },
      { id: 'e3', from: 'count', to: 'done', when: 'done' },
      { id: 'e4', from: 'again', to: 'count' },
    ],
  );
}

export function promptsFor(adapter: RecordingAdapter, nativeId: string): readonly string[] {
  const prompts = adapter.promptsByNative.get(nativeId);
  assert.ok(prompts !== undefined, `no prompt reached native session '${nativeId}'`);
  return prompts;
}

/**
 * White-box read of the Workspace event subscriptions. Each forager executor
 * subscribes once; a disposed routing table unsubscribes every child. This is
 * the observable proof that unload actually disposed the executors.
 */
export function workspaceListenerCount(workspace: Workspace): number {
  return (workspace as unknown as { readonly listeners: ReadonlySet<unknown> }).listeners.size;
}

export function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

/** Test-only access to the live runtime for field comparison. */
interface RuntimeTestAccess {
  exportField(): PersistedField;
}

export function runtimeOf(host: LiveHiveHost, graphId: string): RuntimeTestAccess {
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

export function counterCount(field: PersistedField | undefined): unknown {
  assert.ok(field !== undefined, 'expected a persisted field');
  return field.nodes['count']?.state?.['count'];
}

export function userNode(prompt = 'say something'): Record<string, unknown> {
  return { kind: 'user', config: { modality: 'text', prompt } };
}

/** A user hover plus a forager whose fresh session survives unload. */
export function userAndForagerDefinition(id: string): CompositionDefinition {
  return fastDefinition(id, {
    idle: forager('idle {{message}}'),
    ask: userNode(),
  });
}
