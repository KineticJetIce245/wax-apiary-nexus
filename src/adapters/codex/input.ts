import type { AttachmentDraft } from '../../content.js';

/**
 * Build the Codex `turn/start.input` array. Images with an image MIME type use
 * native `localImage`; non-image attachments stay on the text manifest
 * produced by the transfer layer (Codex has no generic local-file input).
 */
export function buildCodexInput(
  text: string,
  attachments: readonly AttachmentDraft[] = [],
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [{ type: 'text', text }];
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.mimeType.startsWith('image/')) {
      input.push({ type: 'localImage', path: attachment.path });
    }
  }
  return input;
}
