import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildDshPrompt } from '../src/adapters/dsh-acp/content.js';

test('emits ACP image content only when the capability is enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-dsh-prompt-'));
  const image = join(dir, 'a.png');
  const bytes = Buffer.from('png-bytes');
  writeFileSync(image, bytes);

  const enabled = buildDshPrompt(
    'look',
    [{ kind: 'image', path: image, mimeType: 'image/png', name: 'a.png' }],
    true,
  );
  assert.equal(enabled.length, 2);
  assert.deepEqual(enabled[1], {
    type: 'image',
    data: bytes.toString('base64'),
    mimeType: 'image/png',
  });

  const disabled = buildDshPrompt(
    'look',
    [{ kind: 'image', path: image, mimeType: 'image/png', name: 'a.png' }],
    false,
  );
  assert.deepEqual(disabled, [{ type: 'text', text: 'look' }]);
});

test('skips images above the inline size cap and keeps the text fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-dsh-cap-'));
  const image = join(dir, 'a.png');
  writeFileSync(image, Buffer.from('12345678'));
  const prompt = buildDshPrompt(
    'cap',
    [{ kind: 'image', path: image, mimeType: 'image/png', name: 'a.png' }],
    true,
    4,
  );
  assert.deepEqual(prompt, [{ type: 'text', text: 'cap' }]);
  const allowed = buildDshPrompt(
    'cap',
    [{ kind: 'image', path: image, mimeType: 'image/png', name: 'a.png' }],
    true,
    8,
  );
  assert.equal(allowed.length, 2);
});

test('keeps the text fallback for unreadable images and ignores non-images', () => {
  const prompt = buildDshPrompt(
    'fallback',
    [
      { kind: 'image', path: join(tmpdir(), 'does-not-exist.png'), mimeType: 'image/png' },
      { kind: 'file', path: join(tmpdir(), 'a.txt'), mimeType: 'text/plain' },
    ],
    true,
  );
  assert.deepEqual(prompt, [{ type: 'text', text: 'fallback' }]);
});
