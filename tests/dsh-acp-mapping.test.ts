import assert from 'node:assert/strict';
import test from 'node:test';

import { mapApprovalOptions, mapStopReason } from '../src/adapters/dsh-acp/adapter.js';

test('maps known ACP stop reasons and keeps unknown values distinct', () => {
  assert.equal(mapStopReason('end_turn'), 'end_turn');
  assert.equal(mapStopReason('cancelled'), 'cancelled');
  assert.equal(mapStopReason('max_tokens'), 'max_tokens');
  assert.equal(mapStopReason('refusal'), 'refusal');
  assert.equal(mapStopReason('something-new'), 'unknown');
  assert.equal(mapStopReason(undefined), 'unknown');
});

test('maps only well-formed ACP approval options', () => {
  assert.deepEqual(
    mapApprovalOptions([
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'bad', name: 'Bad', kind: 'unknown_kind' },
      { optionId: 'missing-name', kind: 'allow_once' },
      null,
    ]),
    [
      { id: 'allow-once', label: 'Allow once', kind: 'allow_once' },
      { id: 'reject-once', label: 'Reject', kind: 'reject_once' },
    ],
  );
  assert.deepEqual(mapApprovalOptions(undefined), []);
});
