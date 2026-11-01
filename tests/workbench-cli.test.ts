import assert from 'node:assert/strict';
import test from 'node:test';

import { parseReplaceCommand } from '../src/workbench-cli.js';

test('parses a replace command with a multi-word instruction', () => {
  assert.deepEqual(parseReplaceCommand('/replace codex 1234-abc do the next thing'), {
    connection: 'codex',
    executionId: '1234-abc',
    text: 'do the next thing',
  });
});

test('trims extra whitespace around the instruction', () => {
  assert.deepEqual(parseReplaceCommand('/replace   dsh   exec-1    spaced out   '), {
    connection: 'dsh',
    executionId: 'exec-1',
    text: 'spaced out',
  });
});

test('rejects a missing instruction, missing arguments and empty text', () => {
  assert.equal(parseReplaceCommand('/replace'), undefined);
  assert.equal(parseReplaceCommand('/replace codex'), undefined);
  assert.equal(parseReplaceCommand('/replace codex exec-1'), undefined);
  assert.equal(parseReplaceCommand('/replace codex exec-1    '), undefined);
  assert.equal(parseReplaceCommand('not a command'), undefined);
});
