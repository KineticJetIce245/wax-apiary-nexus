import assert from 'node:assert/strict';
import test from 'node:test';

import { attachmentForItem } from '../src/adapters/codex/attachments.js';

test('maps completed Codex image generations and image views', () => {
  assert.deepEqual(attachmentForItem('imageGeneration', { savedPath: 'C:\\tmp\\a.png' }), {
    kind: 'image',
    path: 'C:\\tmp\\a.png',
    mimeType: 'image/png',
    name: 'a.png',
  });
  assert.deepEqual(attachmentForItem('imageView', { path: 'C:\\tmp\\a.JPEG' }), {
    kind: 'image',
    path: 'C:\\tmp\\a.JPEG',
    mimeType: 'image/jpeg',
    name: 'a.JPEG',
  });
  assert.equal(attachmentForItem('imageGeneration', { savedPath: 'C:\\tmp\\a.webp' })?.mimeType, 'image/webp');
  assert.equal(attachmentForItem('imageGeneration', { savedPath: 'C:\\tmp\\a.gif' })?.mimeType, 'image/gif');
});

test('keeps unknown extensions as files and ignores missing paths', () => {
  assert.deepEqual(attachmentForItem('imageGeneration', { savedPath: 'C:\\tmp\\a.bin' }), {
    kind: 'file',
    path: 'C:\\tmp\\a.bin',
    mimeType: 'application/octet-stream',
    name: 'a.bin',
  });
  assert.equal(attachmentForItem('imageGeneration', {}), undefined);
  assert.equal(attachmentForItem('imageGeneration', { savedPath: '' }), undefined);
  assert.equal(attachmentForItem('imageView', { path: '   ' }), undefined);
  assert.equal(attachmentForItem('commandExecution', { command: 'echo' }), undefined);
});
