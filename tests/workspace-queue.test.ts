import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Project } from '../src/project/kernel.js';
import { Workspace } from '../src/session/workspace.js';
import { QueuedAdapter } from './support/queued-adapter.js';

function makeProject(): Project {
  return { id: `queue-project-${Date.now()}`, directory: mkdtempSync(join(tmpdir(), 'wax-ws-queue-')) };
}

async function setup(): Promise<{
  readonly adapter: QueuedAdapter;
  readonly workspace: Workspace;
  readonly conversationId: string;
  readonly nativeId: string;
}> {
  const adapter = new QueuedAdapter();
  const workspace = new Workspace(adapter);
  const conversation = await workspace.createConversation(makeProject());
  return {
    adapter,
    workspace,
    conversationId: conversation.id,
    nativeId: conversation.nativeId,
  };
}

test('admits a second submit and starts it only after the first terminal', async (t) => {
  const { adapter, workspace, conversationId, nativeId } = await setup();
  t.after(() => workspace.stop());

  assert.equal(workspace.canQueue(), true);
  const first = await workspace.submit(conversationId, 'one');
  const second = await workspace.submit(conversationId, 'two');

  // Both are WAX executions, but only the first reached the adapter.
  assert.equal(workspace.getExecution(first.id)?.state, 'running');
  assert.equal(workspace.getExecution(second.id)?.state, 'running');
  assert.deepEqual(adapter.startedIds, [first.id]);
  assert.deepEqual(adapter.waitingExecutionIds(nativeId), [second.id]);
  assert.equal(workspace.isConversationBusy(conversationId), true);

  adapter.completeActive(nativeId);
  assert.equal(workspace.getExecution(first.id)?.state, 'completed');
  assert.deepEqual(adapter.startedIds, [first.id, second.id]);
  // The queued execution still holds the conversation busy until it settles.
  assert.equal(workspace.isConversationBusy(conversationId), true);

  adapter.completeActive(nativeId);
  assert.equal(workspace.getExecution(second.id)?.state, 'completed');
  assert.equal(workspace.isConversationBusy(conversationId), false);
});

test('cancelling a queued execution drops only that prompt', async (t) => {
  const { adapter, workspace, conversationId, nativeId } = await setup();
  t.after(() => workspace.stop());

  const first = await workspace.submit(conversationId, 'one');
  const second = await workspace.submit(conversationId, 'two');
  const third = await workspace.submit(conversationId, 'three');

  await workspace.cancel(second.id);
  assert.deepEqual(adapter.droppedIds, [second.id]);
  assert.equal(workspace.getExecution(second.id)?.state, 'cancelled');
  assert.equal(workspace.getExecution(second.id)?.cancelReason, 'explicit-cancel');
  assert.deepEqual(adapter.cancels, [], 'a per-execution drop must not cancel the active prompt');
  assert.equal(workspace.getExecution(first.id)?.state, 'running');
  assert.equal(workspace.isConversationBusy(conversationId), true);

  adapter.completeActive(nativeId);
  assert.deepEqual(adapter.startedIds, [first.id, third.id]);
  assert.equal(workspace.getExecution(first.id)?.state, 'completed');

  adapter.completeActive(nativeId);
  assert.equal(workspace.getExecution(third.id)?.state, 'completed');
  assert.equal(workspace.isConversationBusy(conversationId), false);
});

test('closing a conversation settles queued executions and closes once', async (t) => {
  const { adapter, workspace, conversationId, nativeId } = await setup();
  t.after(() => workspace.stop());

  const first = await workspace.submit(conversationId, 'one');
  const second = await workspace.submit(conversationId, 'two');
  assert.deepEqual(adapter.startedIds, [first.id]);

  await workspace.closeConversation(conversationId);
  assert.deepEqual(adapter.closedNativeIds, [nativeId]);
  assert.equal(workspace.getExecution(second.id)?.state, 'cancelled');
  assert.equal(workspace.getExecution(second.id)?.cancelReason, 'close');
  assert.equal(workspace.getExecution(first.id)?.state, 'cancelled');
  assert.equal(workspace.getExecution(first.id)?.cancelReason, 'close');
  assert.equal(workspace.isConversationBusy(conversationId), false);
  assert.equal(workspace.getConversation(conversationId), undefined);
  // The queued prompt was never sent.
  assert.deepEqual(adapter.startedIds, [first.id]);
});

test('stopping settles queued executions as unknown instead of stranding them', async (t) => {
  const { adapter, workspace, conversationId } = await setup();

  const first = await workspace.submit(conversationId, 'one');
  const second = await workspace.submit(conversationId, 'two');
  assert.deepEqual(adapter.startedIds, [first.id]);

  await workspace.stop();
  assert.equal(workspace.getExecution(first.id)?.state, 'unknown');
  assert.equal(workspace.getExecution(second.id)?.state, 'unknown');
});
