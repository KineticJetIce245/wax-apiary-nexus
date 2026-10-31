import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import type { Composition } from '../src/composition.js';
import { CompositionBusyError, CompositionRuntime, CompositionStateError } from '../src/composition.js';
import type { Project } from '../src/kernel.js';
import { Workbench } from '../src/workbench.js';

interface Behavior {
  readonly output?: string;
  readonly hang?: boolean;
  readonly error?: string;
}

class FakeAdapter implements HarnessAdapter {
  capabilities: HarnessCapabilities = {
    approval: 'none',
    cancel: true,
    streaming: true,
    resume: false,
  };
  readonly submissions: Array<{ text: string; executionId: string }> = [];
  readonly cancels: string[] = [];
  private readonly active = new Map<string, string>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(
    readonly nativeId: string,
    private readonly behavior: (text: string) => Behavior,
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> {
    return this.nativeId;
  }

  async submit(nativeId: string, executionId: string, text: string): Promise<void> {
    this.submissions.push({ text, executionId });
    const behavior = this.behavior(text);
    if (behavior.error !== undefined) {
      throw new Error(behavior.error);
    }
    if (behavior.hang === true) {
      this.active.set(executionId, nativeId);
      return;
    }
    setTimeout(() => {
      this.emit({
        type: 'execution/output',
        executionId,
        channel: 'assistant',
        text: behavior.output ?? `OUT:${text.slice(0, 20)}`,
      });
      this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, 0);
  }

  async cancel(nativeId: string): Promise<void> {
    this.cancels.push(nativeId);
    for (const [executionId, owner] of [...this.active]) {
      if (owner === nativeId) {
        this.active.delete(executionId);
        this.emit({ type: 'execution/cancelled', executionId });
      }
    }
  }

  async respondToApproval(_decision: ApprovalDecision): Promise<void> {}
  async closeConversation(): Promise<void> {}

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function makeComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    id: 'composition-1',
    version: 1,
    participants: {
      planner: { connection: 'dsh' },
      reviewer: { connection: 'codex' },
    },
    strategyId: 'single-chat',
    config: { participant: 'planner' },
    ...overrides,
  };
}

async function fixture(behaviors?: {
  dsh?: (text: string) => Behavior;
  codex?: (text: string) => Behavior;
}) {
  const project: Project = {
    id: `g007-${Date.now()}`,
    directory: mkdtempSync(join(tmpdir(), 'uw-g007-')),
  };
  const dsh = new FakeAdapter('dsh-native', behaviors?.dsh ?? (() => ({ output: 'DSH' })));
  const codex = new FakeAdapter('codex-native', behaviors?.codex ?? (() => ({ output: 'CODEX' })));
  const workbench = new Workbench({
    project,
    connections: [
      { name: 'dsh', adapter: dsh },
      { name: 'codex', adapter: codex },
    ],
  });
  await workbench.start();
  return { workbench, dsh, codex };
}

test('single chat routes only to the configured participant', async () => {
  const { workbench, dsh, codex } = await fixture();
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  try {
    await runtime.start();
    await runtime.send('hello');
    assert.equal(dsh.submissions.length, 1);
    assert.equal(codex.submissions.length, 0);
    assert.equal(runtime.turns.length, 1);
    assert.equal(runtime.turns[0]?.role, 'planner');
    assert.equal(runtime.status, 'idle');
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});

test('switches single -> debate -> single without changing native conversations', async () => {
  const { workbench, dsh, codex } = await fixture({
    dsh: () => ({ output: 'DSH-FIRST' }),
    codex: () => ({ output: 'CODEX-SECOND' }),
  });
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  const dshNative = workbench.getConnection('dsh')?.conversation.nativeId;
  const codexNative = workbench.getConnection('codex')?.conversation.nativeId;
  try {
    await runtime.start();
    await runtime.send('single topic');
    const versionBefore = runtime.version;

    runtime.switchStrategy('debate', { first: 'planner', second: 'reviewer' });
    assert.equal(runtime.version, versionBefore + 1);
    await runtime.send('debate topic');

    assert.equal(dsh.submissions.length, 2);
    assert.equal(codex.submissions.length, 1);
    assert.match(codex.submissions[0]?.text ?? '', /DSH-FIRST/);
    assert.equal(runtime.turns.length, 3);

    runtime.switchStrategy('single-chat', { participant: 'reviewer' });
    assert.equal(runtime.version, versionBefore + 2);
    await runtime.send('back to single');

    assert.equal(dsh.submissions.length, 2);
    assert.equal(codex.submissions.length, 2);
    assert.deepEqual(
      runtime.history.map((change) => change.strategyId),
      ['single-chat', 'debate', 'single-chat'],
    );
    assert.equal(workbench.getConnection('dsh')?.conversation.nativeId, dshNative);
    assert.equal(workbench.getConnection('codex')?.conversation.nativeId, codexNative);
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});

test('rejects unknown participants that collide with Object.prototype names', async () => {
  const { workbench, dsh } = await fixture();
  const runtime = new CompositionRuntime(
    workbench,
    makeComposition({ config: { participant: 'toString' } }),
    { pollIntervalMs: 5 },
  );
  try {
    await runtime.start();
    await assert.rejects(runtime.send('x'), /Unknown single-chat participant/);
    assert.equal(dsh.submissions.length, 0);
    assert.equal(runtime.status, 'failed');
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});

test('emits cancelled once after the in-flight turn settles, never failed', async () => {
  const { workbench } = await fixture({
    dsh: () => ({ hang: true }),
  });
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  const events: string[] = [];
  runtime.onEvent((event) => events.push(event.type));
  try {
    await runtime.start();
    const first = runtime.send('hang');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.cancel('stop requested');
    await assert.rejects(first, /cancelled/);
    assert.equal(runtime.status, 'cancelled');
    assert.equal(events.includes('composition/failed'), false);
    assert.deepEqual(events, [
      'composition/started',
      'turn/started',
      'turn/completed',
      'composition/cancelled',
    ]);
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});

test('rejects concurrent sends and cancels an in-flight turn', async () => {
  const { workbench, dsh } = await fixture({
    dsh: () => ({ hang: true }),
  });
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  try {
    await runtime.start();
    const first = runtime.send('hang');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(runtime.send('second'), CompositionBusyError);
    await runtime.cancel();
    await assert.rejects(first, /cancelled/);
    assert.equal(runtime.status, 'cancelled');
    assert.equal(dsh.cancels.length, 1);
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});

test('fails instead of hanging when the execution disappears', async () => {
  const { workbench } = await fixture({
    dsh: () => ({ hang: true }),
  });
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  try {
    await runtime.start();
    const first = runtime.send('hang');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await workbench.stop();
    await assert.rejects(first);
    assert.notEqual(runtime.status, 'running');
  } finally {
    await runtime.stop().catch(() => undefined);
  }
});

test('marks a failed turn and does not run the second debate participant', async () => {
  const { workbench, codex } = await fixture({
    dsh: () => ({ error: 'native refused' }),
  });
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  try {
    await runtime.start();
    runtime.switchStrategy('debate', { first: 'planner', second: 'reviewer' });
    await assert.rejects(runtime.send('fail'), /native refused/);
    assert.equal(runtime.status, 'failed');
    assert.equal(codex.submissions.length, 0);
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});

test('rejects debate participants sharing one connection', async () => {
  const { workbench } = await fixture();
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  try {
    await runtime.start();
    runtime.switchStrategy('single-chat', { participant: 'planner' });
    assert.throws(
      () => runtime.switchStrategy('debate', { first: 'planner', second: 'planner' }),
      CompositionStateError,
    );
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});

test('rejects strategy switching while a turn is running', async () => {
  const { workbench } = await fixture({
    dsh: () => ({ hang: true }),
  });
  const runtime = new CompositionRuntime(workbench, makeComposition(), { pollIntervalMs: 5 });
  try {
    await runtime.start();
    const first = runtime.send('hang');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.throws(
      () => runtime.switchStrategy('debate', { first: 'planner', second: 'reviewer' }),
      CompositionBusyError,
    );
    await runtime.cancel();
    await assert.rejects(first, /cancelled/);
  } finally {
    await runtime.stop();
    await workbench.stop();
  }
});
