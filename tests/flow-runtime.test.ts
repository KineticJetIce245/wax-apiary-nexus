import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ApprovalDecision,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
} from '../src/adapters/harness.js';
import { SubmitOutcomeUnknownError } from '../src/adapters/harness.js';
import type { AttachmentDraft } from '../src/content.js';
import type { FlowDefinition } from '../src/flow-definition.js';
import { parseFlowDefinition } from '../src/flow-definition.js';
import { FlowRuntime, type FlowEvent } from '../src/flow-runtime.js';
import type { Project } from '../src/kernel.js';
import { Workbench } from '../src/workbench.js';

interface Behavior {
  readonly output?: string;
  readonly error?: string;
  readonly unknown?: boolean;
  readonly hang?: boolean;
  readonly delayMs?: number;
  readonly attachmentPath?: string;
}

class FakeAdapter implements HarnessAdapter {
  capabilities: HarnessCapabilities = {
    approval: 'none',
    cancel: true,
    streaming: true,
    resume: false,
  };
  readonly submissions: Array<{
    text: string;
    executionId: string;
    attachments?: readonly AttachmentDraft[];
  }> = [];
  readonly cancels: string[] = [];
  readonly closed: string[] = [];
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

  async submit(
    nativeId: string,
    executionId: string,
    text: string,
    attachments?: readonly AttachmentDraft[],
  ): Promise<void> {
    this.submissions.push({
      text,
      executionId,
      ...(attachments === undefined ? {} : { attachments }),
    });
    const behavior = this.behavior(text);
    if (behavior.unknown === true) {
      throw new SubmitOutcomeUnknownError('native acceptance unknown', executionId);
    }
    if (behavior.error !== undefined) {
      throw new Error(behavior.error);
    }
    if (behavior.hang === true) {
      this.active.set(executionId, nativeId);
      return;
    }
    setTimeout(() => {
      if (behavior.attachmentPath !== undefined) {
        this.emit({
          type: 'execution/attachment',
          executionId,
          attachment: {
            kind: 'image',
            path: behavior.attachmentPath as string,
            mimeType: 'image/png',
            name: 'plan.png',
          },
        });
      }
      this.emit({
        type: 'execution/output',
        executionId,
        channel: 'assistant',
        text: behavior.output ?? '',
      });
      this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, behavior.delayMs ?? 0);
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
  async closeConversation(nativeId: string): Promise<void> {
    this.closed.push(nativeId);
  }

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

  complete(executionId: string, output: string): void {
    this.emit({ type: 'execution/output', executionId, channel: 'assistant', text: output });
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  }
}

interface Fixture {
  readonly workbench: Workbench;
  readonly runtime: FlowRuntime;
  readonly dsh: FakeAdapter;
  readonly codex: FakeAdapter;
  readonly events: FlowEvent[];
}

async function fixture(
  flow: Record<string, unknown>,
  behaviors?: { dsh?: (text: string) => Behavior; codex?: (text: string) => Behavior },
): Promise<Fixture> {
  const project: Project = {
    id: `g005-${Date.now()}`,
    directory: mkdtempSync(join(tmpdir(), 'uw-g005-flow-')),
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
  const definition: FlowDefinition = parseFlowDefinition(flow);
  const runtime = new FlowRuntime(workbench, definition, { pollIntervalMs: 5 });
  const events: FlowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return { workbench, runtime, dsh, codex, events };
}

function flow(nodes: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    strategy: 'graph',
    participants: {
      planner: { connection: 'dsh' },
      reviewer: { connection: 'codex' },
    },
    start: 'plan',
    nodes,
    ...extra,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error('condition not reached in time');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('runs a sequential flow with exact rendered prompts', async () => {
  const f = await fixture(
    flow(
      {
        plan: { participant: 'planner', prompt: 'Plan {{input}}', next: 'review' },
        review: { participant: 'reviewer', prompt: 'Review {{plan}}', next: 'end' },
        end: { type: 'end' },
      },
      { input: 'TOPIC' },
    ),
    {
      dsh: () => ({ output: 'PLAN' }),
      codex: () => ({ output: 'REVIEW' }),
    },
  );
  try {
    const result = await f.runtime.run();
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.outputs, { plan: 'PLAN', review: 'REVIEW' });
    assert.equal(f.dsh.submissions[0]?.text, 'Plan TOPIC');
    assert.equal(f.codex.submissions[0]?.text, 'Review PLAN');
    assert.equal(result.nodes.plan?.status, 'completed');
    assert.equal(result.nodes.end?.status, 'completed');
    assert.equal(f.events.filter((event) => event.type === 'node/completed').length, 2);
    assert.equal(f.events.at(-1)?.type, 'flow/completed');
    assert.ok(f.runtime.result !== undefined);
    (result.outputs as Record<string, string>).plan = 'MUTATED';
    assert.equal(f.runtime.result?.outputs.plan, 'PLAN');
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});

test('branch follows the condition and skips the other path', async () => {
  const makeFlow = () =>
    flow({
      plan: {
        participant: 'planner',
        prompt: 'Plan',
        next: { contains: 'APPROVED', then: 'accept', else: 'revise' },
      },
      accept: { participant: 'reviewer', prompt: 'Accept {{plan}}', next: 'end' },
      revise: { participant: 'planner', prompt: 'Revise {{plan}}', next: 'end' },
      end: { type: 'end' },
    });

  const approved = await fixture(makeFlow(), {
    dsh: () => ({ output: 'APPROVED' }),
    codex: () => ({ output: 'OK' }),
  });
  try {
    const result = await approved.runtime.run();
    assert.equal(result.status, 'completed');
    assert.equal(approved.codex.submissions.length, 1);
    assert.equal(approved.dsh.submissions.length, 1);
    assert.equal(result.nodes.accept?.status, 'completed');
    assert.equal(result.nodes.revise?.status, 'pending');
  } finally {
    await approved.workbench.stop().catch(() => undefined);
  }

  const rejected = await fixture(makeFlow(), {
    dsh: () => ({ output: 'NOPE' }),
    codex: () => ({ output: 'OK' }),
  });
  try {
    const result = await rejected.runtime.run();
    assert.equal(result.status, 'completed');
    assert.equal(rejected.codex.submissions.length, 0);
    assert.equal(rejected.dsh.submissions.length, 2);
    assert.equal(result.nodes.accept?.status, 'pending');
    assert.equal(result.nodes.revise?.status, 'completed');
  } finally {
    await rejected.workbench.stop().catch(() => undefined);
  }
});

test('runs parallel branches concurrently, waits for both, then joins', async () => {
  const f = await fixture(
    flow({
      plan: { participant: 'planner', prompt: 'Plan', next: 'reviewers' },
      a: { participant: 'planner', prompt: 'A {{plan}}' },
      b: { participant: 'reviewer', prompt: 'B {{plan}}' },
      reviewers: { type: 'parallel', branches: ['a', 'b'], next: 'merge' },
      merge: { participant: 'planner', prompt: '{{a}} + {{b}}', next: 'end' },
      end: { type: 'end' },
    }),
    {
      dsh: (text) =>
        text === 'Plan' ? { output: 'PLAN' } : text.startsWith('A-OUT') ? { output: 'DSH' } : { hang: true },
      codex: () => ({ hang: true }),
    },
  );
  try {
    const running = f.runtime.run();
    await waitUntil(() => f.dsh.submissions.length === 2 && f.codex.submissions.length === 1);
    const aExecution = f.dsh.submissions[1]?.executionId;
    const bExecution = f.codex.submissions[0]?.executionId;
    assert.ok(aExecution !== undefined && bExecution !== undefined);
    await delay(30);
    assert.equal(f.dsh.submissions.length, 2, 'merge must wait for both branches');

    f.dsh.complete(aExecution, 'A-OUT');
    await delay(30);
    assert.equal(f.dsh.submissions.length, 2, 'merge must wait for the second branch');
    f.codex.complete(bExecution, 'B-OUT');

    const result = await running;
    assert.equal(result.status, 'completed');
    assert.equal(f.dsh.submissions.at(-1)?.text, 'A-OUT + B-OUT');
    assert.equal(result.outputs.a, 'A-OUT');
    assert.equal(result.outputs.b, 'B-OUT');
    assert.equal(result.outputs.merge, 'DSH');
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});

test('cancels the sibling branch when one parallel branch fails', async () => {
  const f = await fixture(
    flow({
      plan: { participant: 'planner', prompt: 'Plan', next: 'reviewers' },
      failing: { participant: 'planner', prompt: 'FAIL' },
      hanging: { participant: 'reviewer', prompt: 'HANG' },
      reviewers: { type: 'parallel', branches: ['failing', 'hanging'], next: 'merge' },
      merge: { participant: 'planner', prompt: '{{failing}} {{hanging}}', next: 'end' },
      end: { type: 'end' },
    }),
    {
      dsh: (text) => (text === 'Plan' ? { output: 'PLAN' } : { error: 'native refused' }),
      codex: () => ({ hang: true }),
    },
  );
  try {
    const result = await f.runtime.run();
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /native refused/);
    assert.equal(result.nodes.failing?.status, 'failed');
    assert.equal(result.nodes.hanging?.status, 'cancelled');
    assert.equal(f.codex.cancels.length, 1);
    assert.equal(f.dsh.submissions.some((submission) => submission.text.startsWith('FAIL')), true);
    assert.equal(f.dsh.submissions.some((submission) => submission.text.includes('A') && submission.text.includes('B')), false);
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});

test('stops a sequential flow after a failed node', async () => {
  const f = await fixture(
    flow({
      plan: { participant: 'planner', prompt: 'Plan', next: 'review' },
      review: { participant: 'reviewer', prompt: 'Review', next: 'end' },
      end: { type: 'end' },
    }),
    {
      dsh: () => ({ error: 'boom' }),
      codex: () => ({ output: 'OK' }),
    },
  );
  try {
    const result = await f.runtime.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.nodes.plan?.status, 'failed');
    assert.equal(f.codex.submissions.length, 0);
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});

test('stops a flow when a node submit outcome is unknown', async () => {
  const f = await fixture(
    flow({
      plan: { participant: 'planner', prompt: 'Plan', next: 'review' },
      review: { participant: 'reviewer', prompt: 'Review', next: 'end' },
      end: { type: 'end' },
    }),
    {
      dsh: () => ({ unknown: true }),
      codex: () => ({ output: 'OK' }),
    },
  );
  try {
    const result = await f.runtime.run();
    assert.equal(result.status, 'unknown');
    assert.equal(result.nodes.plan?.status, 'unknown');
    assert.equal(f.codex.submissions.length, 0);
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});

test('cancels the running node and stops the flow', async () => {
  const f = await fixture(
    flow({
      plan: { participant: 'planner', prompt: 'Plan', next: 'review' },
      review: { participant: 'reviewer', prompt: 'Review', next: 'end' },
      end: { type: 'end' },
    }),
    {
      dsh: () => ({ hang: true }),
      codex: () => ({ output: 'OK' }),
    },
  );
  try {
    const running = f.runtime.run();
    await waitUntil(() => f.dsh.submissions.length === 1);
    await f.runtime.cancel();
    const result = await running;
    assert.equal(result.status, 'cancelled');
    assert.equal(f.dsh.cancels.length, 1);
    assert.equal(f.codex.submissions.length, 0);
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});

test('ignores connection checks for participants that no node uses', async () => {
  const project: Project = {
    id: 'g005-unused-participant',
    directory: mkdtempSync(join(tmpdir(), 'uw-g005-flow-')),
  };
  const dsh = new FakeAdapter('dsh-native', () => ({ output: 'DONE' }));
  const workbench = new Workbench({
    project,
    connections: [{ name: 'dsh', adapter: dsh }],
  });
  await workbench.start();
  const definition = parseFlowDefinition(
    flow({
      plan: { participant: 'planner', prompt: 'Plan', next: 'end' },
      end: { type: 'end' },
    }),
  );
  const runtime = new FlowRuntime(workbench, definition, { pollIntervalMs: 5 });
  try {
    const result = await runtime.run();
    assert.equal(result.status, 'completed');
    assert.equal(dsh.submissions.length, 1);
  } finally {
    await workbench.stop().catch(() => undefined);
  }
});

test('passes upstream attachments to a downstream node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-flow-attach-'));
  const imagePath = join(dir, 'plan.png');
  writeFileSync(imagePath, Buffer.from('plan-image'));
  const f = await fixture(
    flow({
      plan: { participant: 'planner', prompt: 'Plan', next: 'review' },
      review: {
        participant: 'reviewer',
        prompt: 'Review {{plan}}',
        attachments: ['plan'],
        next: 'end',
      },
      end: { type: 'end' },
    }),
    {
      dsh: () => ({ output: 'PLAN', attachmentPath: imagePath }),
      codex: () => ({ output: 'REVIEW' }),
    },
  );
  try {
    const result = await f.runtime.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.nodes.plan?.attachments?.length, 1);
    const review = f.codex.submissions.at(-1);
    assert.equal(review?.attachments?.length, 1);
    assert.equal(review?.attachments?.[0]?.path, imagePath);
    assert.equal(review?.attachments?.[0]?.mimeType, 'image/png');
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});

test('fails before submitting when a template value is unavailable', async () => {
  const f = await fixture(
    flow({
      plan: {
        participant: 'planner',
        prompt: 'Plan',
        next: { contains: 'A', then: 'left', else: 'right' },
      },
      left: { participant: 'planner', prompt: 'Left', next: 'merge' },
      right: { participant: 'reviewer', prompt: 'Right', next: 'merge' },
      merge: { participant: 'planner', prompt: '{{left}} {{right}}', next: 'end' },
      end: { type: 'end' },
    }),
    {
      dsh: (text) => (text === 'Plan' ? { output: 'A' } : { output: 'LEFT' }),
      codex: () => ({ output: 'RIGHT' }),
    },
  );
  try {
    const result = await f.runtime.run();
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /not available/);
    assert.equal(result.nodes.left?.status, 'completed');
    assert.equal(result.nodes.merge?.status, 'failed');
    assert.equal(f.dsh.submissions.some((submission) => submission.text.includes('LEFT RIGHT')), false);
  } finally {
    await f.workbench.stop().catch(() => undefined);
  }
});
