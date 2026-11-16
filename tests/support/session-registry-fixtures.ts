import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationOptions, HarnessCapabilities } from '../../src/adapters/harness.js';
import type { Project } from '../../src/project/kernel.js';
import { parseComposition, type Value } from '../../src/runtime/index.js';
import {
  BindingValidationError,
  SessionBindingUnavailableError,
} from '../../src/session/instantiate-foragers.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import {
  ConversationStore,
  type ConversationRecord,
} from '../../src/storage/conversation-store.js';
import { FakeAdapter } from './fake-adapter.js';

export const FIXED_NOW = '2026-11-06T22:00:00.000Z';

/**
 * The shared FakeAdapter does not implement resume. This local subclass only
 * adds the parts this slice needs; the public fake is intentionally untouched.
 */
export class ResumableFakeAdapter extends FakeAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    rename: false,
    resume: true,
  };
  readonly resumes: Array<{ readonly nativeId: string; readonly cwd: string }> = [];
  readonly createOptions: Array<ConversationOptions | undefined> = [];
  readonly closed: string[] = [];
  resumeGate: Promise<void> | undefined;
  resumeError: Error | undefined;
  closeError: Error | undefined;

  async resume(nativeId: string, cwd: string): Promise<void> {
    this.resumes.push({ nativeId, cwd });
    if (this.resumeGate !== undefined) {
      await this.resumeGate;
    }
    if (this.resumeError !== undefined) {
      throw this.resumeError;
    }
  }

  async createConversation(project: Project, options?: ConversationOptions): Promise<string> {
    this.createOptions.push(options === undefined ? undefined : { ...options });
    return super.createConversation(project, options);
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

export function makeProject(): Project {
  return { id: `project-${Date.now()}`, directory: mkdtempSync(join(tmpdir(), 'wax-m3a-')) };
}

/** Returns the same native id for every create, to exercise duplicate checks. */
export class SharedNativeAdapter extends FakeAdapter {
  readonly closed: string[] = [];
  closeError: Error | undefined;

  async createConversation(_project: Project, _options?: ConversationOptions): Promise<string> {
    return 'native-shared';
  }

  async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

/** Store whose write path can be switched to fail after hydration. */
export class FailingUpsertStore extends ConversationStore {
  failUpsert = false;

  override upsert(record: ConversationRecord): void {
    if (this.failUpsert) {
      throw new Error('store write failed');
    }
    super.upsert(record);
  }
}

/** Fails a native close only for one chosen native session. */
export class SelectiveCloseFailureAdapter extends ResumableFakeAdapter {
  failNativeId: string | undefined;

  override async closeConversation(nativeId: string): Promise<void> {
    if (this.failNativeId === nativeId) {
      this.closed.push(nativeId);
      throw new Error('NATIVE_CLOSE_SECRET');
    }
    await super.closeConversation(nativeId);
  }
}

interface Harness {
  readonly adapter: ResumableFakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
}

export function setup(
  store?: ConversationStore,
  now: () => string = () => FIXED_NOW,
): Harness {
  const adapter = new ResumableFakeAdapter();
  const workspace = new Workspace(adapter);
  const project = makeProject();
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]),
    now,
    ...(store === undefined ? {} : { store }),
  });
  return { adapter, workspace, registry, project };
}

export function makeStore(): ConversationStore {
  return new ConversationStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m4c2c1-store-')), 'sessions.json'),
  );
}

/** A fresh process view: new adapter/workspace/registry over the same store. */
export function rehydrate(
  store: ConversationStore,
  project: Project,
  now: () => string = () => FIXED_NOW,
): Harness {
  const adapter = new ResumableFakeAdapter();
  const workspace = new Workspace(adapter);
  const registry = new SessionRegistry({ workspaces: new Map([['dsh-acp', workspace]]),
    now,
    store,
  });
  return { adapter, workspace, registry, project };
}

/** Mutable ISO clock: advance it between registry calls. */
export function isoClock(start = FIXED_NOW): { now: () => string; set: (value: string) => void } {
  let current = start;
  return {
    now: () => current,
    set: (value: string) => {
      current = value;
    },
  };
}

export function waitForExecutionSettled(workspace: Workspace, executionId: string): Promise<void> {
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

export function makeDefinition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'registry-binding-test',
    nodes: {
      run: { kind: 'forager', config: { connection: 'codex', prompt: 'go' } },
    },
    edges: [],
  });
}
