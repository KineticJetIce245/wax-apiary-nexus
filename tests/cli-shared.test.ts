import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionDisplayName } from '../src/cli-shared.js';

test('caps session display names at the DSH native title byte limit', () => {
  const name = sessionDisplayName('a'.repeat(64), 'b'.repeat(64));
  assert.equal(name.length, 80);
  assert.equal(Buffer.byteLength(name, 'utf8'), 80);
  assert.match(name, /^wax-apiary-nexus-session-/);
  assert.doesNotMatch(name, /[-.]$/);
});

test('keeps short session display names unchanged', () => {
  assert.equal(
    sessionDisplayName('apiary', 'composition'),
    'wax-apiary-nexus-session-apiary-composition',
  );
});
