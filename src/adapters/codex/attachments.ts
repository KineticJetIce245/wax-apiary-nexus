import { basename, extname } from 'node:path';

import type { AttachmentDraft, AttachmentKind } from '../../content.js';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Map a completed Codex item to a local attachment draft. This is pure; the
 * adapter checks that the path is a readable regular file before emitting it.
 * `item/started` must not call this: a half-written generation is not a result.
 */
export function attachmentForItem(
  type: string,
  item: Record<string, unknown>,
): AttachmentDraft | undefined {
  let path: string | undefined;
  if (type === 'imageGeneration') {
    // A failed generation can still carry metadata; a path is not a result.
    if (item.failure !== undefined && item.failure !== null) {
      return undefined;
    }
    if (item.status === 'failed') {
      return undefined;
    }
    path = asString(item.savedPath);
  } else if (type === 'imageView') {
    path = asString(item.path);
  }
  if (path === undefined || path.trim() === '') {
    return undefined;
  }
  const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const kind: AttachmentKind = mimeType.startsWith('image/') ? 'image' : 'file';
  return {
    kind,
    path,
    mimeType,
    name: basename(path),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
