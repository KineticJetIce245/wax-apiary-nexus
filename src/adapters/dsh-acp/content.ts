import { readFileSync, statSync } from 'node:fs';

import type { AttachmentDraft } from '../../content.js';

const DEFAULT_MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Build ACP `session/prompt` content. Image blocks are emitted only when the
 * initialize response advertised promptCapabilities.image; otherwise the text
 * manifest (including paths) remains the sole carrier. A read failure silently
 * keeps the text fallback instead of failing the whole transfer.
 */
export function buildDshPrompt(
  text: string,
  attachments: readonly AttachmentDraft[] = [],
  imageEnabled = false,
  maxImageBytes = DEFAULT_MAX_INLINE_IMAGE_BYTES,
): Array<Record<string, unknown>> {
  const prompt: Array<Record<string, unknown>> = [{ type: 'text', text }];
  if (!imageEnabled) {
    return prompt;
  }
  for (const attachment of attachments) {
    if (attachment.kind !== 'image' || !attachment.mimeType.startsWith('image/')) {
      continue;
    }
    try {
      if (statSync(attachment.path).size > maxImageBytes) {
        continue;
      }
      prompt.push({
        type: 'image',
        data: readFileSync(attachment.path).toString('base64'),
        mimeType: attachment.mimeType,
      });
    } catch {
      // The text manifest still names the local path.
    }
  }
  return prompt;
}
