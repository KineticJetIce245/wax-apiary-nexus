import { readFileSync } from 'node:fs';

import type { AttachmentDraft } from '../../content.js';

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
