import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createAnswerId,
  ensureAnswerInbox,
  listAnswerFiles,
  parseAnswerRecord,
  readAnswerRecord,
  removeAnswerFile,
  writeAnswerRecord,
  type AnswerRecord,
} from '../src/answer-inbox.js';

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function record(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    answerId: createAnswerId(),
    compositionId: 'inbox',
    nodeId: 'ask',
    hoverToken: 'hv_test',
    value: { kind: 'text', text: 'hello' },
    at: new Date().toISOString(),
    ...overrides,
  };
}

test('writes one answer file and leaves no temp file behind', () => {
  const directory = tempDirectory('wax-answer-inbox-');
  ensureAnswerInbox(directory);
  const answer = record();

  const path = writeAnswerRecord(directory, answer);

  assert.deepEqual(readdirSync(directory), [`${answer.answerId}.json`]);
  assert.equal(listAnswerFiles(directory)[0], path);
  assert.deepEqual(readAnswerRecord(path), answer);
  // Permissions are enforced by the OS on POSIX; Windows ignores mode bits.
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.ok(statSync(path).size > 0);
});

test('a repeated write replaces the previous complete record', () => {
  const directory = tempDirectory('wax-answer-inbox-');
  ensureAnswerInbox(directory);
  const first = record({ answerId: 'ans_repeat' });
  const second = { ...first, value: { kind: 'text' as const, text: 'second' } };

  writeAnswerRecord(directory, first);
  writeAnswerRecord(directory, second);

  assert.deepEqual(readdirSync(directory), ['ans_repeat.json']);
  assert.deepEqual(readAnswerRecord(join(directory, 'ans_repeat.json')), second);
});

test('lists only json answer files in name order and ignores temp files', () => {
  const directory = tempDirectory('wax-answer-inbox-');
  ensureAnswerInbox(directory);
  writeFileSync(join(directory, 'b.json'), '{}');
  writeFileSync(join(directory, 'a.json'), '{}');
  writeFileSync(join(directory, '.a.json.tmp-1-abc'), '{}');
  writeFileSync(join(directory, 'note.txt'), '{}');

  assert.deepEqual(
    listAnswerFiles(directory).map((path) => path.slice(directory.length + 1)),
    ['a.json', 'b.json'],
  );
  assert.deepEqual(listAnswerFiles(join(directory, 'missing')), []);
});

test('rejects an answer id that could escape the inbox directory', () => {
  const directory = tempDirectory('wax-answer-inbox-');
  ensureAnswerInbox(directory);
  assert.throws(
    () => writeAnswerRecord(directory, record({ answerId: '../escape' })),
    /invalid answer id/,
  );
  assert.throws(
    () => writeAnswerRecord(directory, record({ answerId: '' })),
    /invalid answer id/,
  );
});

test('rejects malformed records instead of accepting a partial answer', () => {
  const base = record();
  assert.throws(() => parseAnswerRecord(null), /expected an object/);
  assert.throws(
    () => parseAnswerRecord({ ...base, answerId: '' }),
    /answerId: expected a non-empty string/,
  );
  assert.throws(
    () => parseAnswerRecord({ ...base, compositionId: 7 }),
    /compositionId: expected a non-empty string/,
  );
  assert.throws(
    () => parseAnswerRecord({ ...base, nodeId: undefined }),
    /nodeId: expected a non-empty string/,
  );
  assert.throws(
    () => parseAnswerRecord({ ...base, hoverToken: '' }),
    /hoverToken: expected a non-empty string/,
  );
  assert.throws(
    () => parseAnswerRecord({ ...base, at: 'yesterday' }),
    /at: expected an ISO timestamp/,
  );
  assert.throws(
    () => parseAnswerRecord({ ...base, value: { kind: 'text', text: 5 } }),
    /text: expected a string/,
  );
  assert.throws(
    () => parseAnswerRecord({ ...base, value: { kind: 'bogus' } }),
    /unknown value kind/,
  );
});

test('readAnswerRecord reports invalid JSON and removes the file', () => {
  const directory = tempDirectory('wax-answer-inbox-');
  ensureAnswerInbox(directory);
  const path = join(directory, 'broken.json');
  writeFileSync(path, '{ not json');

  assert.throws(() => readAnswerRecord(path), /not valid JSON/);
  removeAnswerFile(path);
  assert.deepEqual(readdirSync(directory), []);
});

