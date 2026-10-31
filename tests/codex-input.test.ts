import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexInput } from '../src/adapters/codex/input.js';

test('builds text + localImage inputs and leaves non-images on the text manifest', () => {
  const input = buildCodexInput('review this', [
    { kind: 'image', path: 'C:\\tmp\\a.png', mimeType: 'image/png', name: 'a.png' },
    { kind: 'file', path: 'C:\\tmp\\a.txt', mimeType: 'text/plain', name: 'a.txt' },
  ]);
  assert.deepEqual(input, [
    { type: 'text', text: 'review this' },
    { type: 'localImage', path: 'C:\\tmp\\a.png' },
  ]);
});

test('keeps text-only input when there are no image attachments', () => {
  assert.deepEqual(buildCodexInput('hello'), [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(
    buildCodexInput('hello', [
      { kind: 'file', path: 'C:\\tmp\\a.txt', mimeType: 'text/plain' },
    ]),
    [{ type: 'text', text: 'hello' }],
  );
});
