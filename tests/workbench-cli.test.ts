import assert from 'node:assert/strict';
import test from 'node:test';

import { assertResumeTargetReady, parseReplaceCommand, parseArgs } from '../src/workbench-cli.js';

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

test('parses --resume and --conversation-store', () => {
  const options = parseArgs(['C:/work', '--resume', 'conv-1', '--conversation-store', 'C:/state.json']);
  assert.equal(options?.resume, 'conv-1');
  assert.equal(options?.conversationStore, 'C:/state.json');
});

test('rejects --resume and --conversation-store without a value', () => {
  assert.throws(() => parseArgs(['C:/work', '--resume']), /Missing value for --resume/);
  assert.throws(
    () => parseArgs(['C:/work', '--conversation-store']),
    /Missing value for --conversation-store/,
  );
});


test('supports --resume=id and trims values', () => {
  const options = parseArgs(['C:/work', '--resume=  conv-1  ', '--conversation-store=  C:/state.json  ']);
  assert.equal(options?.resume, 'conv-1');
  assert.equal(options?.conversationStore, 'C:/state.json');
});

test('rejects duplicate --resume flags', () => {
  assert.throws(
    () => parseArgs(['C:/work', '--resume', 'a', '--resume', 'b']),
    /Duplicate option: --resume/,
  );
});

test('assertResumeTargetReady passes only when the target connection is ready', () => {
  const ready = {
    getConnection: () => ({ status: 'ready' }),
    connectionFailures: [],
  } as unknown as Parameters<typeof assertResumeTargetReady>[0];
  assert.doesNotThrow(() => assertResumeTargetReady(ready, 'codex'));

  const failed = {
    getConnection: () => undefined,
    connectionFailures: [{ name: 'codex', message: 'thread not found' }],
  } as unknown as Parameters<typeof assertResumeTargetReady>[0];
  assert.throws(() => assertResumeTargetReady(failed, 'codex'), /thread not found/);
});
