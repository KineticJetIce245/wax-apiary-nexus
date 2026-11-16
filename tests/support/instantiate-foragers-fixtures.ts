import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationOptions } from '../../src/adapters/harness.js';
import type { HarnessCapabilities } from '../../src/adapters/harness.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { GraphBindingStore, type ResolvedGraphBinding } from '../../src/graph/binding-store.js';
import type { Project } from '../../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type ForagerNode,
  type Value,
} from '../../src/runtime/index.js';
import {
  BindingValidationError,
  instantiateForagers,
  SessionBindingUnavailableError,
} from '../../src/session/instantiate-foragers.js';
import {
  RoutingExecutorDisposedError,
} from '../../src/session/routing-executor.js';
import {
  SessionNotFoundError,
  SessionRegistry,
  type SessionRecord,
} from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { ConversationStore } from '../../src/storage/conversation-store.js';
import { FakeAdapter } from './fake-adapter.js';

export const FIXED_NOW = '2026-11-06T22:00:00.000Z';

export function makeProject(): Project {
  return {
    id: `project-${String(Date.now())}-${String(Math.random())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m3b-')),
  };
}

export function makeStore(): ConversationStore {
  return new ConversationStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-instantiate-')), 'sessions.json'),
  );
}

export function makeBindingStore(now: () => string = () => FIXED_NOW): GraphBindingStore {
  return new GraphBindingStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m5b-instantiate-bindings-')), 'graph-bindings.json'),
    { now },
  );
}

export class FailingSetBindingStore extends GraphBindingStore {
  override set(_binding: ResolvedGraphBinding): void {
    throw new Error('graph binding store write failed');
  }
}

export function foragerNode(prompt = 'go'): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'codex', prompt } };
}

export function makeDefinition(nodes: Record<string, unknown>): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'instantiate-foragers-test',
    nodes,
    edges: [],
  });
}

export function foragerOf(definition: CompositionDefinition, nodeId: string): ForagerNode {
  const node = definition.nodes.get(nodeId);
  if (node === undefined || node.kind !== 'forager') {
    throw new Error(`expected a forager node '${nodeId}'`);
  }
  return node;
}

export function text(value: string): Value {
  return { kind: 'text', text: value };
}

export async function waitForExecutionSettled(workspace: Workspace, executionId: string): Promise<void> {
  const execution = workspace.getExecution(executionId);
  if (execution !== undefined && execution.state !== 'running') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = workspace.onEvent((event) => {
      if (event.type === 'execution/state' && event.executionId === executionId) {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function makeHarness(
  adapter: FakeAdapter = new FakeAdapter({ output: 'ok' }),
  harness = 'dsh-acp',
): {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
} {
  const workspace = new Workspace(adapter);
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([[harness, workspace]]), now: () => FIXED_NOW });
  return { adapter, workspace, registry, project };
}

export class TrackingCloseAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
  }
}

/** FakeAdapter plus the resume capability needed for hydrated sessions. */
export class ResumableAdapter extends FakeAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    rename: false,
    resume: true,
  };
  readonly resumes: Array<{ readonly nativeId: string; readonly cwd: string }> = [];
  resumeError: Error | undefined;

  async resume(nativeId: string, cwd: string): Promise<void> {
    this.resumes.push({ nativeId, cwd });
    if (this.resumeError !== undefined) {
      throw this.resumeError;
    }
  }
}

/** A registry whose record exists for validation but vanishes before attach. */
export class VanishingRegistry extends SessionRegistry {
  override async ensureAttached(sessionId: string): Promise<SessionRecord> {
    throw new SessionNotFoundError(sessionId);
  }
}

export class FlakyCreateAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];
  failCreateOn = 0;
  createCalls = 0;

  override async createConversation(
    project: Project,
    options?: ConversationOptions,
  ): Promise<string> {
    this.createCalls += 1;
    if (this.createCalls === this.failCreateOn) {
      throw new Error(`create failed on call ${String(this.createCalls)}`);
    }
    return super.createConversation(project, options);
  }

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
  }
}
