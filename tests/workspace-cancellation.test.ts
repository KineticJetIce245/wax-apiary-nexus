import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createKernel } from '../src/project/kernel.js';
import {
  ForagerExecutionError,
  WorkspaceForagerExecutor,
  type ApprovalHandler,
} from '../src/session/forager.js';
import { Workspace, type Conversation } from '../src/session/workspace.js';
import { parseComposition, type ForagerNode } from '../src/runtime/index.js';
import { FakeAdapter } from './support/fake-adapter.js';

function foragerNode(): ForagerNode {
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'cancellation',
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt: 'run {{message}}' } },
    },
    edges: [],
  });
  const node = definition.nodes.get('only');
  if (node === undefined || node.kind !== 'forager') {
    throw new Error('bad fixture');
  }
  return node;
}

/** Keeps the native approval pending until the Workspace acts on it. */
const pendingApproval: ApprovalHandler = () => new Promise<never>(() => undefined);

interface Bridge {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly conversation: Conversation;
  readonly executor: WorkspaceForagerExecutor;
}

async function setup(options: {
  readonly onApproval?: ApprovalHandler;
} = {}): Promise<Bridge> {
  const adapter = new FakeAdapter({
    askApproval: true,
    approvalCancelTerminal: 'cancelled',
  });
  await adapter.start();
  const workspace = new Workspace(adapter);
  const project = createKernel().registerProject(mkdtempSync(join(tmpdir(), 'wax-cancel-')));
  const conversation = await workspace.createConversation(project);
  const executor = new WorkspaceForagerExecutor({
    workspace,
    conversation,
    ...(options.onApproval === undefined ? {} : { onApproval: options.onApproval }),
  });
  return { adapter, workspace, conversation, executor };
}

function cleanup(t: { after: (fn: () => Promise<void>) => void }, bridge: Bridge): void {
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });
}

/** Resolves with the execution id of the first native approval request. */
function approvalRequested(workspace: Workspace): Promise<string> {
  return new Promise((resolve) => {
    const off = workspace.onEvent((event) => {
      if (event.type === 'execution/approval-requested') {
        off();
        resolve(event.executionId);
      }
    });
  });
}

function rejectedWith(
  expected: 'approval-timeout' | 'explicit-cancel' | 'replace' | 'close' | undefined,
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof ForagerExecutionError);
    assert.equal(error.state, 'cancelled');
    assert.equal(error.cancelReason, expected);
    return true;
  };
}

test('an approval-timeout cancellation is recorded as approval-timeout', async (t) => {
  const bridge = await setup({ onApproval: pendingApproval });
  cleanup(t, bridge);
  const requested = approvalRequested(bridge.workspace);

  const rejection = assert.rejects(
    bridge.executor.execute(foragerNode(), { message: 'go' }),
    rejectedWith('approval-timeout'),
  );
  const executionId = await requested;
  await bridge.workspace.cancelForApprovalTimeout(executionId);
  await rejection;

  const execution = bridge.workspace.getExecution(executionId);
  assert.ok(execution !== undefined);
  assert.equal(execution.state, 'cancelled');
  assert.equal(execution.cancelReason, 'approval-timeout');
  assert.equal(execution.error, undefined);
});

test('an explicit cancel is recorded as explicit-cancel', async (t) => {
  const bridge = await setup({ onApproval: pendingApproval });
  cleanup(t, bridge);
  const requested = approvalRequested(bridge.workspace);

  const rejection = assert.rejects(
    bridge.executor.execute(foragerNode(), { message: 'go' }),
    rejectedWith('explicit-cancel'),
  );
  const executionId = await requested;
  await bridge.workspace.cancel(executionId);
  await rejection;

  const execution = bridge.workspace.getExecution(executionId);
  assert.equal(execution?.state, 'cancelled');
  assert.equal(execution?.cancelReason, 'explicit-cancel');
});

test('a close settles the execution as close provenance', async (t) => {
  const bridge = await setup({ onApproval: pendingApproval });
  cleanup(t, bridge);
  const requested = approvalRequested(bridge.workspace);

  const rejection = assert.rejects(
    bridge.executor.execute(foragerNode(), { message: 'go' }),
    rejectedWith('close'),
  );
  const executionId = await requested;
  await bridge.workspace.closeConversation(bridge.conversation.id);
  await rejection;

  const execution = bridge.workspace.getExecution(executionId);
  assert.equal(execution?.state, 'cancelled');
  assert.equal(execution?.cancelReason, 'close');
});

test('replace records its own reason on the cancelled execution', async (t) => {
  const bridge = await setup({ onApproval: pendingApproval });
  cleanup(t, bridge);
  const requested = approvalRequested(bridge.workspace);

  const first = await bridge.workspace.submit(bridge.conversation.id, 'first');
  await requested;
  const second = await bridge.workspace.replace(first.id, 'second');

  assert.equal(second.state, 'running');
  const settled = bridge.workspace.getExecution(first.id);
  assert.equal(settled?.state, 'cancelled');
  assert.equal(settled?.cancelReason, 'replace');
});

test('a native cancel without a Workspace call stays unattributed', async (t) => {
  const adapter = new FakeAdapter({ terminal: 'cancelled' });
  await adapter.start();
  const workspace = new Workspace(adapter);
  const project = createKernel().registerProject(mkdtempSync(join(tmpdir(), 'wax-cancel-')));
  const conversation = await workspace.createConversation(project);
  const executor = new WorkspaceForagerExecutor({ workspace, conversation });
  t.after(async () => {
    executor.dispose();
    await workspace.stop();
  });

  let cancelledId: string | undefined;
  workspace.onEvent((event) => {
    if (event.type === 'execution/state' && event.state === 'cancelled') {
      cancelledId = event.executionId;
    }
  });

  await assert.rejects(
    executor.execute(foragerNode(), { message: 'go' }),
    rejectedWith(undefined),
  );

  assert.ok(cancelledId !== undefined);
  const execution = workspace.getExecution(cancelledId);
  assert.equal(execution?.state, 'cancelled');
  assert.equal(Object.hasOwn(execution as object, 'cancelReason'), false);
});

test('a bridge-decided approval cancel is not claimed as approval-timeout', async (t) => {
  const bridge = await setup({ onApproval: async () => 'cancelled' });
  cleanup(t, bridge);

  await assert.rejects(
    bridge.executor.execute(foragerNode(), { message: 'go' }),
    rejectedWith(undefined),
  );
});
