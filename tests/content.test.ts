import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResultEnvelope, type Attachment } from '../src/content.js';

const image: Attachment = {
  id: 'att-image',
  kind: 'image',
  path: 'C:\\tmp\\generated.png',
  mimeType: 'image/png',
  name: 'generated.png',
  byteLength: 1234,
};

const file: Attachment = {
  id: 'att-file',
  kind: 'file',
  path: 'C:\\tmp\\notes.txt',
  mimeType: 'text/plain',
  name: 'notes.txt',
};

test('builds a text-first envelope with typed attachment parts', () => {
  const envelope = buildResultEnvelope({
    source: { connection: 'codex', executionId: 'exec-1', nativeId: 'native-1' },
    output: 'generated',
    attachments: [image, file],
  });

  assert.equal(envelope.version, 1);
  assert.deepEqual(envelope.source, {
    connection: 'codex',
    executionId: 'exec-1',
    nativeId: 'native-1',
  });
  assert.equal(envelope.parts.length, 3);
  assert.deepEqual(envelope.parts[0], { type: 'text', text: 'generated' });
  assert.equal(envelope.parts[1]?.type, 'image');
  assert.equal(envelope.parts[2]?.type, 'file');
});

test('omits the text part when the execution produced no text', () => {
  const envelope = buildResultEnvelope({
    source: { connection: 'codex', executionId: 'exec-2', nativeId: 'native-2' },
    output: '',
    attachments: [image],
  });
  assert.equal(envelope.parts.length, 1);
  assert.equal(envelope.parts[0]?.type, 'image');
});

test('clones attachments so later mutation does not change an existing envelope', () => {
  const mutableImage: Attachment = { ...image };
  const envelope = buildResultEnvelope({
    source: { connection: 'codex', executionId: 'exec-3', nativeId: 'native-3' },
    output: 'x',
    attachments: [mutableImage],
  });
  (mutableImage as { path: string }).path = 'C:\\tmp\\changed.png';
  const part = envelope.parts[1];
  assert.equal(part?.type, 'image');
  if (part?.type === 'image') {
    assert.equal(part.attachment.path, 'C:\\tmp\\generated.png');
  }
});
