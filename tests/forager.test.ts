import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ApprovalDecision, ApprovalRequest } from '../src/adapters/harness.js';
import { ForagerExecutionError, WorkspaceForagerExecutor, type ApprovalHandler } from '../src/session/forager.js';
import { SessionBusyError } from '../src/session/session-errors.js';
import { createKernel } from '../src/project/kernel.js';
import { parseComposition, type ForagerNode, type Value } from '../src/runtime/index.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions, type FakeTerminal } from './support/fake-adapter.js';

function foragerNode(prompt = 'do {{input}}'): ForagerNode {
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'bridge',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt } },
    },
    edges: [],
  });
  const node = definition.nodes.get('start');
  if (node === undefined || node.kind !== 'forager') {
    throw new Error('bad fixture');
  }
  return node;
}

interface Bridge {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly executor: WorkspaceForagerExecutor;
}

async function setup(options: FakeAdapterOptions, onApproval?: ApprovalHandler): Promise<Bridge> {
  return setupWith(new FakeAdapter(options), onApproval);
}

async function setupWith(adapter: FakeAdapter, onApproval?: ApprovalHandler): Promise<Bridge> {
  await adapter.start();
  const workspace = new Workspace(adapter);
  const project = createKernel().registerProject(mkdtempSync(join(tmpdir(), 'wax-forager-')));
  const conversation = await workspace.createConversation(project);
  const executor = new WorkspaceForagerExecutor({
    workspace,
    conversation,
    ...(onApproval === undefined ? {} : { onApproval }),
  });
  return { adapter, workspace, executor };
}

test('completed execution returns the assistant text and renders the prompt', async (t) => {
  const bridge = await setup({ output: 'HELLO' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const value = await bridge.executor.execute(foragerNode(), { message: 'hi' });

  assert.deepEqual(value, { message: 'HELLO' });
  assert.deepEqual(bridge.adapter.prompts, ['do hi']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [[]]);
  assert.deepEqual(bridge.executor.lastOutput, { message: 'HELLO' });
});

test('renders a structured input as JSON and forwards no nested attachments', async (t) => {
  const bridge = await setup({ output: 'SAW' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const input: Value = {
      branch: { message: 'A' },
      nested: { message: 'm', attachments: [{ path: '/tmp/notes.md' }] },
      n: 2,
    };
  await bridge.executor.execute(foragerNode(), input);

  assert.deepEqual(bridge.adapter.prompts, [`do ${JSON.stringify(input)}`]);
  assert.deepEqual(bridge.adapter.submittedAttachments, [[]]);
});

test('forwards an image attachment with an inferred mime type', async (t) => {
  const bridge = await setup({ output: 'SAW' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { attachments: [{ path: 'C:/tmp/photo.PNG' }] });

  assert.deepEqual(bridge.adapter.prompts, ['do ']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [
    [{ kind: 'image', path: 'C:/tmp/photo.PNG', mimeType: 'image/png' }],
  ]);
});

test('forwards file attachments from a message and skips unusable entries', async (t) => {
  const bridge = await setup({ output: 'SAW' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { message: 'please review', attachments: [
      { path: '/tmp/notes.md' },
      { path: '/tmp/diagram.jpeg' },
      { path: '/tmp/recording.mp3' },
      { kind: 'file' },
      { path: '   ' },
    ] });

  assert.deepEqual(bridge.adapter.prompts, ['do please review']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [
    [
      { kind: 'file', path: '/tmp/notes.md', mimeType: 'text/markdown' },
      { kind: 'image', path: '/tmp/diagram.jpeg', mimeType: 'image/jpeg' },
      { kind: 'file', path: '/tmp/recording.mp3', mimeType: 'application/octet-stream' },
    ],
  ]);
});

test('submits no attachments when the input carries none', async (t) => {
  const bridge = await setup({ output: 'TEXT' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { message: 'plain' });

  assert.deepEqual(bridge.adapter.prompts, ['do plain']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [[]]);
});

test('uses a stable prompt when only attachments remain', async (t) => {
  const bridge = await setup({ output: 'OK' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode('{{input}}'), { attachments: [{ path: '/tmp/photo.webp' }] });
  await bridge.executor.execute(foragerNode('{{input}}'), { message: '   ', attachments: [{ path: '/tmp/report.pdf' }] });

  assert.deepEqual(bridge.adapter.prompts, ['See attached input.', 'See attached input.']);
  assert.deepEqual(
    bridge.adapter.submittedAttachments.map((drafts) => drafts.map((draft) => draft.mimeType)),
    [['image/webp'], ['application/pdf']],
  );
});

test('infers mimeType from a small extension map with an octet-stream fallback', async (t) => {
  const bridge = await setup({ output: 'OK' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const cases: readonly (readonly [string, string])[] = [
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.pdf', 'application/pdf'],
    ['.txt', 'text/plain'],
    ['.json', 'application/json'],
    ['.md', 'text/markdown'],
    ['.bin', 'application/octet-stream'],
    ['', 'application/octet-stream'],
  ];

  for (const [extension] of cases) {
    await bridge.executor.execute(foragerNode(), { attachments: [{ path: `/tmp/input${extension}` }] });
  }

  assert.deepEqual(
    bridge.adapter.submittedAttachments.map((drafts) => drafts[0]?.mimeType),
    cases.map(([, mimeType]) => mimeType),
  );
});

for (const state of ['failed', 'cancelled', 'unknown'] as const satisfies readonly FakeTerminal[]) {
  test(`maps a ${state} execution to a ForagerExecutionError without retrying`, async (t) => {
    const bridge = await setup({ terminal: state, error: `${state}-detail` });
    t.after(async () => {
      bridge.executor.dispose();
      await bridge.workspace.stop();
    });

    await assert.rejects(
      bridge.executor.execute(foragerNode(), { message: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof ForagerExecutionError);
        assert.equal(error.state, state);
        assert.equal(error.nodeId, 'start');
        if (state !== 'cancelled') {
          assert.match(error.message, new RegExp(`${state}-detail`));
        }
        return true;
      },
    );

    assert.equal(bridge.adapter.prompts.length, 1, 'a terminal failure must not be retried');
    assert.equal(bridge.executor.lastOutput, undefined);
  });
}

test('an approval handler decides the native request (allow_once)', async (t) => {
  const seen: ApprovalRequest[] = [];
  const handler: ApprovalHandler = async (request) => {
    seen.push(request);
    return 'allow_once';
  };
  const bridge = await setup({ askApproval: true, output: 'APPROVED' }, handler);
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const value = await bridge.executor.execute(foragerNode(), { message: 'go' });

  assert.deepEqual(value, { message: 'APPROVED' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.summary, 'run a command');
  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['allow_once'],
  );
});

test('without a handler the bridge rejects instead of allowing', async (t) => {
  const bridge = await setup({ askApproval: true, output: 'AFTER-REJECT' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { message: 'go' });

  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['reject_once'],
  );
});

test('a handler may cancel the approval', async (t) => {
  const bridge = await setup({ askApproval: true }, async () => 'cancelled');
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { message: 'go' });

  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['cancelled'],
  );
});

test('a throwing approval handler falls back to rejecting', async (t) => {
  const bridge = await setup({ askApproval: true }, async () => {
    throw new Error('ui crashed');
  });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { message: 'go' });

  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['reject_once'],
  );
});

test('dispose stops approval handling but keeps the last output', async (t) => {
  const bridge = await setup({ output: 'LAST' });
  t.after(async () => {
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { message: 'x' });
  bridge.executor.dispose();
  bridge.executor.dispose();

  assert.deepEqual(bridge.executor.lastOutput, { message: 'LAST' });
});

/** Emits its approval from inside submit(), before submit() resolves. */
class SubmitApprovalAdapter extends FakeAdapter {
  private currentExecutionId: string | undefined;
  private readonly text: string;

  constructor(text = 'EARLY') {
    super();
    this.text = text;
  }

  override async submit(_nativeId: string, executionId: string, text: string): Promise<void> {
    this.prompts.push(text);
    this.currentExecutionId = executionId;
    this.emit({ type: 'execution/started', executionId });
    this.emit({
      type: 'execution/approval-requested',
      executionId,
      request: {
        requestId: `req-${executionId}`,
        executionId,
        summary: 'run a command',
        options: [
          { id: 'accept', kind: 'allow_once', label: 'Allow once' },
          { id: 'decline', kind: 'reject_once', label: 'Reject' },
        ],
      },
    });
  }

  override async respondToApproval(decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
    const executionId = this.currentExecutionId;
    if (executionId === undefined) {
      throw new Error('approval without a submission');
    }
    setTimeout(() => {
      this.emit({
        type: 'execution/output',
        executionId,
        channel: 'assistant',
        text: this.text,
      });
      this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, 0);
  }
}

/**
 * Two foragers share one Workspace conversation in the live daemon. Only the
 * executor that submitted the execution may decide its approval: an idle
 * sibling would otherwise take `defaultDecision` and reject it.
 */
async function twoExecutors(
  conversationOf: 'shared' | 'separate',
): Promise<{
  adapter: FakeAdapter;
  workspace: Workspace;
  owner: WorkspaceForagerExecutor;
  sibling: WorkspaceForagerExecutor;
}> {
  const adapter = new FakeAdapter({ askApproval: true, output: 'APPROVED' });
  await adapter.start();
  const workspace = new Workspace(adapter);
  const project = createKernel().registerProject(mkdtempSync(join(tmpdir(), 'wax-forager-')));
  const ownerConversation = await workspace.createConversation(project);
  const siblingConversation =
    conversationOf === 'shared' ? ownerConversation : await workspace.createConversation(project);
  const sibling = new WorkspaceForagerExecutor({
    workspace,
    conversation: siblingConversation,
  });
  const owner = new WorkspaceForagerExecutor({
    workspace,
    conversation: ownerConversation,
    onApproval: async () => 'allow_once',
  });
  return {
    adapter,
    workspace,
    owner,
    sibling,
  };
}

for (const conversationOf of ['shared', 'separate'] as const) {
  test(`an idle sibling forager never decides a ${conversationOf} approval`, async (t) => {
    const fixture = await twoExecutors(conversationOf);
    t.after(async () => {
      fixture.owner.dispose();
      fixture.sibling.dispose();
      await fixture.workspace.stop();
    });

    const value = await fixture.owner.execute(foragerNode(), { message: 'go' });

    assert.deepEqual(value, { message: 'APPROVED' });
    assert.deepEqual(
      fixture.adapter.approvals.map((decision) => decision.kind),
      ['allow_once'],
      'only the owning executor may decide the approval',
    );
  });
}

test(
  'an approval emitted before submit returns is adopted by its own executor',
  { timeout: 2_000 },
  async (t) => {
    const adapter = new SubmitApprovalAdapter('EARLY');
    await adapter.start();
    const workspace = new Workspace(adapter);
    const project = createKernel().registerProject(mkdtempSync(join(tmpdir(), 'wax-forager-')));
    const conversation = await workspace.createConversation(project);
    const executor = new WorkspaceForagerExecutor({
      workspace,
      conversation,
      onApproval: async () => 'allow_once',
    });
    t.after(async () => {
      executor.dispose();
      await workspace.stop();
    });

    const value = await executor.execute(foragerNode(), { message: 'early' });

    assert.deepEqual(value, { message: 'EARLY' });
    assert.deepEqual(
      adapter.approvals.map((decision) => decision.kind),
      ['allow_once'],
    );
  },
);

/**
 * Exposes the execution id and a way to emit a stale approval for it, the way a
 * native adapter may replay a request after its terminal event. With
 * `finishInsideSubmit`, the terminal lands before `submit()` resolves.
 */
class LateApprovalAdapter extends FakeAdapter {
  executionId: string | undefined;
  private readonly finishInsideSubmit: boolean;

  constructor(options: FakeAdapterOptions = {}, finishInsideSubmit = false) {
    super(options);
    this.finishInsideSubmit = finishInsideSubmit;
  }

  override async submit(_nativeId: string, executionId: string, text: string): Promise<void> {
    this.executionId = executionId;
    if (!this.finishInsideSubmit) {
      await super.submit(_nativeId, executionId, text);
      return;
    }
    this.prompts.push(text);
    this.emit({ type: 'execution/started', executionId });
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  }

  emitLateApproval(): void {
    const executionId = this.executionId;
    if (executionId === undefined) {
      throw new Error('no submitted execution');
    }
    this.emit({
      type: 'execution/approval-requested',
      executionId,
      request: {
        requestId: `late-${executionId}`,
        executionId,
        summary: 'late approval',
        options: [
          { id: 'accept', kind: 'allow_once', label: 'Allow once' },
          { id: 'decline', kind: 'reject_once', label: 'Reject' },
        ],
      },
    });
  }
}

/** White-box view of the executor's ownership ledger; it has no public getter. */
function ownedIds(executor: WorkspaceForagerExecutor): Set<string> {
  return (executor as unknown as { readonly ownedExecutionIds: Set<string> }).ownedExecutionIds;
}

/**
 * The Workspace already auto-cancels an approval for a settled execution, so
 * this test pins the executor's own cleanup: the terminal event must remove the
 * id, and the stale request must not reach the approval handler.
 */
test('a late approval after the terminal event is not adopted', { timeout: 2_000 }, async (t) => {
  const adapter = new LateApprovalAdapter({ askApproval: true, output: 'DONE' });
  let handled = 0;
  const bridge = await setupWith(adapter, async () => {
    handled += 1;
    return 'allow_once';
  });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const value = await bridge.executor.execute(foragerNode(), { message: 'go' });
  assert.deepEqual(value, { message: 'DONE' });
  assert.equal(handled, 1);
  assert.deepEqual([...ownedIds(bridge.executor)], [], 'the terminal event must release the id');

  adapter.emitLateApproval();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(handled, 1, 'a settled execution must not hand its late approval to the handler');
  assert.deepEqual([...ownedIds(bridge.executor)], [], 'the stale request must not re-own the id');
});

test(
  'a terminal emitted before submit() resolves does not revive ownership',
  { timeout: 2_000 },
  async (t) => {
    const adapter = new LateApprovalAdapter({}, true);
    let handled = 0;
    const bridge = await setupWith(adapter, async () => {
      handled += 1;
      return 'allow_once';
    });
    t.after(async () => {
      bridge.executor.dispose();
      await bridge.workspace.stop();
    });

    const value = await bridge.executor.execute(foragerNode(), { message: 'go' });
    assert.deepEqual(value, { message: '' });
    assert.equal(handled, 0);
    assert.deepEqual([...ownedIds(bridge.executor)], [], 'submit() must not re-add the settled id');

    adapter.emitLateApproval();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(handled, 0, 'the stale request must not reach the handler');
  },
);

test('a conversation already held by another execution surfaces SessionBusyError', async (t) => {
  const adapter = new FakeAdapter({ askApproval: true });
  await adapter.start();
  const workspace = new Workspace(adapter);
  const project = createKernel().registerProject(mkdtempSync(join(tmpdir(), 'wax-forager-')));
  const conversation = await workspace.createConversation(project);
  const executor = new WorkspaceForagerExecutor({ workspace, conversation });
  t.after(async () => {
    executor.dispose();
    await workspace.stop();
  });

  // The pending approval keeps the first execution running, so the
  // conversation is busy when the executor submits its own prompt.
  await workspace.submit(conversation.id, 'hold');

  await assert.rejects(
    executor.execute(foragerNode(), { message: 'wake' }),
    (error: unknown) => {
      assert.ok(error instanceof SessionBusyError);
      assert.equal(error.sessionId, conversation.id);
      return true;
    },
  );
  assert.equal(adapter.prompts.length, 1, 'the busy submit never reaches the adapter');
});
