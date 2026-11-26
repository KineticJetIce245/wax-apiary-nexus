import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ConversationOptions,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import { LiveHiveHost } from '../src/daemon/graph-host.js';
import type { GraphBindings } from '../src/graph/binding.js';
import type { Project } from '../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type Value,
} from '../src/runtime/index.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { nodeStatus, triggerRun, waitUntil } from './support/graph-host-fixtures.js';

/**
 * A minimal adapter whose submissions can be held. Holding the native submit
 * makes a second graph entry observable: without the per-live lock it reaches
 * the adapter while the first trigger is still in flight.
 */
class GatedAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'none',
    cancel: true,
    streaming: true,
    rename: false,
    resume: false,
  };
  readonly prompts: string[] = [];
  hold: boolean;

  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly pending: string[] = [];
  private nativeSeq = 0;

  constructor(options: { readonly hold?: boolean } = {}) {
    this.hold = options.hold ?? true;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createConversation(
    _project: Project,
    _options?: ConversationOptions,
  ): Promise<string> {
    this.nativeSeq += 1;
    return `native-${String(this.nativeSeq)}`;
  }

  async submit(
    _nativeId: string,
    executionId: string,
    text: string,
  ): Promise<void> {
    this.prompts.push(text);
    if (this.hold) {
      this.pending.push(executionId);
      return;
    }
    this.finishSoon(executionId);
  }

  async cancel(_nativeId: string): Promise<void> {}

  async respondToApproval(): Promise<void> {
    throw new Error('no approvals in this test');
  }

  async closeConversation(_nativeId: string): Promise<void> {}

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async waitForSubmits(count: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.prompts.length < count) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${String(count)} submissions`);
      }
      await delay(5);
    }
  }

  releaseAll(): void {
    this.hold = false;
    const pending = this.pending.splice(0);
    for (const executionId of pending) {
      this.finishSoon(executionId);
    }
  }

  private finishSoon(executionId: string): void {
    setTimeout(() => {
      this.emit({ type: 'execution/output', executionId, channel: 'assistant', text: 'ok' });
      this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, 0);
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

interface Env {
  readonly host: LiveHiveHost;
  readonly workspace: Workspace;
  readonly project: Project;
}

function makeEnv(adapter: GatedAdapter, maxWaitMs?: number): Env {
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: `project-${String(Date.now())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9b-lock-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  return {
    host: new LiveHiveHost({
      registry,
      ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
    }),
    workspace,
    project,
  };
}

function definition(id: string): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      a: { kind: 'forager', config: { connection: 'fake', prompt: 'a {{message}}' } },
      b: { kind: 'forager', config: { connection: 'fake', prompt: 'b {{message}}' } },
    },
    edges: [],
  });
}

function bindings(): GraphBindings {
  return { a: { kind: 'fresh' }, b: { kind: 'fresh' } };
}

function text(value: string): Value {
  return { message: value };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test(
  'two bees of one live id start concurrently; admission does not hold the field',
  { timeout: 10_000 },
  async (t) => {
  const adapter = new GatedAdapter();
  const env = makeEnv(adapter);
  t.after(async () => {
    adapter.releaseAll();
    await env.host.dispose();
    await env.workspace.stop();
  });

  const graph = definition('live');
  await env.host.loadGraph({ definition: graph, bindings: bindings(), project: env.project });

  const first = triggerRun(env.host, 'live', 'a', text('one'));
  await adapter.waitForSubmits(1);
  const second = triggerRun(env.host, 'live', 'b', text('two'));

  // Different bees have independent mailboxes: the second submission must
  // reach the adapter while the first activation is still held.
  await adapter.waitForSubmits(2);

  adapter.releaseAll();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.rest, true);
  assert.equal(secondResult.rest, true);
  assert.deepEqual(adapter.prompts, ['a one', 'b two']);
  },
);

test('different live ids proceed concurrently', { timeout: 10_000 }, async (t) => {
  const adapter = new GatedAdapter();
  const env = makeEnv(adapter);
  t.after(async () => {
    adapter.releaseAll();
    await env.host.dispose();
    await env.workspace.stop();
  });

  await env.host.loadGraph({
    definition: definition('live-a'),
    bindings: bindings(),
    project: env.project,
  });
  await env.host.loadGraph({
    definition: definition('live-b'),
    bindings: bindings(),
    project: env.project,
  });

  const first = triggerRun(env.host, 'live-a', 'a', text('a'));
  const second = triggerRun(env.host, 'live-b', 'a', text('b'));
  await adapter.waitForSubmits(2);

  adapter.releaseAll();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.rest, true);
  assert.equal(secondResult.rest, true);
  assert.deepEqual(adapter.prompts, ['a a', 'a b']);
});

test('a failing locked trigger does not poison the next one', { timeout: 10_000 }, async (t) => {
  const adapter = new GatedAdapter({ hold: false });
  const env = makeEnv(adapter);
  t.after(async () => {
    await env.host.dispose();
    await env.workspace.stop();
  });

  await env.host.loadGraph({
    definition: definition('live'),
    bindings: bindings(),
    project: env.project,
  });

  await assert.rejects(triggerRun(env.host, 'live', 'missing', text('bad')));
  const result = await triggerRun(env.host, 'live', 'a', text('good'));

  assert.equal(result.rest, true);
  assert.deepEqual(adapter.prompts, ['a good']);
});

test('unload snapshots a held trigger after the host wait bound', { timeout: 10_000 }, async (t) => {
  const adapter = new GatedAdapter();
  const env = makeEnv(adapter, 0);
  t.after(async () => {
    adapter.releaseAll();
    await env.host.dispose();
    await env.workspace.stop();
  });

  await env.host.loadGraph({
    definition: definition('live'),
    bindings: bindings(),
    project: env.project,
  });

  await env.host.trigger('live', 'a', text('one'));
  await adapter.waitForSubmits(1);
  await waitUntil(
    () => hostNodeActive(env.host, 'live', 'a'),
    'the held activation to become active',
  );

  // An explicit unload observes the running drain only up to `maxWaitMs`, then
  // snapshots the active field and releases it; it does not deadlock on the
  // held native execution.
  assert.equal(await env.host.unload('live'), true);
  assert.equal(env.host.statusOf('live'), undefined);

  adapter.releaseAll();
  await waitUntil(() => listenerCount(env.workspace) === 0, 'the detached executor to release');
});

function hostNodeActive(host: LiveHiveHost, graphId: string, nodeId: string): boolean {
  const status = host.statusOf(graphId);
  return status?.nodes.some((node) => node.nodeId === nodeId && node.active) === true;
}

function listenerCount(workspace: Workspace): number {
  return (workspace as unknown as { readonly listeners: ReadonlySet<unknown> }).listeners.size;
}

test('trigger returns after delivery while the native execution is still held', async (t) => {
  const adapter = new GatedAdapter();
  const env = makeEnv(adapter);
  t.after(async () => {
    adapter.releaseAll();
    await env.host.dispose();
    await env.workspace.stop();
  });
  await env.host.loadGraph({
    definition: definition('admission'),
    bindings: bindings(),
    project: env.project,
  });

  await env.host.trigger('admission', 'a', text('start'));
  await adapter.waitForSubmits(1);
  const running = env.host.statusOf('admission');
  assert.ok(running !== undefined);
  assert.equal(running.rest, false);
  assert.equal(nodeStatus(running, 'a').active, true);

  adapter.releaseAll();
  await waitUntil(
    () => env.host.statusOf('admission')?.rest === true,
    'the released execution to settle',
  );
});
