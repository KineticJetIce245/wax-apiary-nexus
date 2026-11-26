import { assertJsonValue } from './json-value.js';
import type { Attachment, JsonValue, UserNode, Value } from './types.js';

const ATTACHMENT_KEYS = ['path', 'mediaType'] as const;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

/** A Value is a plain JSON object; arrays and `null` are not root values. */
export function assertValue(value: unknown, label = 'value'): asserts value is Value {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  assertJsonValue(value, label);
}

export function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !(ATTACHMENT_KEYS as readonly string[]).includes(key))) {
    return false;
  }
  if (typeof record['path'] !== 'string' || record['path'].trim() === '') {
    return false;
  }
  return record['mediaType'] === undefined || typeof record['mediaType'] === 'string';
}

/**
 * Reads the `attachments` convention from a Value. Entries that are not
 * `{ path, mediaType? }` are ignored here; a user answer uses the strict
 * validator below instead.
 */
export function readAttachments(value: Value): Attachment[] {
  const raw = value['attachments'];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isAttachment) as unknown as Attachment[];
}

/** True when the attachment is an image by media type prefix or extension. */
export function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.mediaType !== undefined && attachment.mediaType.startsWith('image/')) {
    return true;
  }
  const path = attachment.path.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function assertUserValue(node: UserNode, value: Value): void {
  switch (node.config.modality) {
    case 'text':
      requireStringMessage(node, value);
      return;
    case 'yes-no':
      requireBoolean(node, value);
      return;
    case 'message':
      requireStringMessage(node, value);
      assertAttachmentList(node.id, value['attachments'] ?? [], 0, Number.POSITIVE_INFINITY);
      return;
    case 'image':
      requireAttachment(node, value, 'image');
      return;
    case 'file':
      requireAttachment(node, value, 'file');
      return;
    case 'choice':
      requireChoice(node, value);
      return;
  }
}

function requireBoolean(node: UserNode, value: Value): void {
  if (typeof value['boolean'] !== 'boolean') {
    throw new TypeError(`user node '${node.id}' expects a boolean field 'boolean'`);
  }
}

function requireAttachment(
  node: UserNode,
  value: Value,
  modality: 'image' | 'file',
): void {
  const attachments = assertAttachmentList(node.id, value['attachments'], 1, 1);
  if (modality === 'image' && !isImageAttachment(attachments[0] as Attachment)) {
    throw new TypeError(`user node '${node.id}' expects one image attachment`);
  }
}

function requireChoice(node: UserNode, value: Value): void {
  const choice = value['choice'];
  if (typeof choice !== 'string') {
    throw new TypeError(`user node '${node.id}' expects a string field 'choice'`);
  }
  const choices = node.config.choices ?? [];
  if (!choices.includes(choice)) {
    throw new TypeError(
      `user node '${node.id}' does not offer choice '${choice}' (${choices.join(', ')})`,
    );
  }
}

function requireStringMessage(node: UserNode, value: Value): void {
  if (typeof value['message'] !== 'string') {
    throw new TypeError(`user node '${node.id}' expects a string field 'message'`);
  }
}

/**
 * Validates `attachments` as `[{ path: string; mediaType?: string }]`. The
 * runtime never reads the filesystem; path existence belongs to the CLI.
 */
function assertAttachmentList(
  nodeId: string,
  raw: JsonValue | undefined,
  min: number,
  max: number,
): Attachment[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(`user node '${nodeId}' attachments must be an array`);
  }
  if (raw.length < min || raw.length > max) {
    const expected = min === max ? String(min) : `${String(min)}..${String(max)}`;
    throw new TypeError(
      `user node '${nodeId}' expects ${expected} attachment(s), got ${String(raw.length)}`,
    );
  }
  return raw.map((entry) => {
    if (!isAttachment(entry)) {
      throw new TypeError(
        `user node '${nodeId}' attachment must be { path: string; mediaType?: string }`,
      );
    }
    return entry;
  }) as Attachment[];
}
