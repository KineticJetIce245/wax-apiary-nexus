import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApprovalRequest } from '../src/adapters/harness.js';
import { ApprovalInbox } from '../src/approval-inbox.js';

function request(requestId: string): ApprovalRequest {
  return {
    requestId,
    executionId: `execution-${requestId}`,
    summary: `approval ${requestId}`,
    options: [{ id: 'allow', kind: 'allow_once', label: 'Allow' }],
  };
}

test('assigns stable ids that are never reused after removal', () => {
  const inbox = new ApprovalInbox();
  const first = inbox.add('dsh', request('one'));
  const second = inbox.add('codex', request('two'));
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);

  assert.equal(inbox.remove('dsh', 'one')?.id, 1);
  assert.equal(inbox.get(1), undefined);
  assert.equal(inbox.get(2)?.connection, 'codex');

  const third = inbox.add('dsh', request('three'));
  assert.equal(third.id, 3);
  assert.equal(inbox.get(1), undefined);
});

test('removing one connection leaves an identically named request pending elsewhere', () => {
  const inbox = new ApprovalInbox();
  inbox.add('dsh', request('same'));
  const codex = inbox.add('codex', request('same'));
  inbox.remove('dsh', 'same');
  assert.equal(inbox.get(1), undefined);
  assert.equal(inbox.get(codex.id)?.connection, 'codex');
  assert.deepEqual(
    inbox.list().map((entry) => [entry.id, entry.connection]),
    [[2, 'codex']],
  );
});

test('unknown ids stay unknown', () => {
  const inbox = new ApprovalInbox();
  assert.equal(inbox.get(99), undefined);
  assert.equal(inbox.remove('dsh', 'missing'), undefined);
});
