import { assertJsonValue } from './json-value.js';
import type { UserNode, Value } from './types.js';

const VALUE_KINDS = ['text', 'choice', 'boolean', 'message', 'attachments', 'structured'] as const;

export function assertValue(value: unknown): asserts value is Value {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('value must be an object');
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(VALUE_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`value.kind must be one of ${VALUE_KINDS.join(', ')}`);
  }
  if (kind === 'structured') {
    assertJsonValue((value as { value?: unknown }).value, 'value.value');
  }
}

export function assertUserValue(node: UserNode, value: Value): void {
  const modality = node.config.modality;
  if (modality === 'text') {
    if (value.kind !== 'text') {
      throw new TypeError(`user node '${node.id}' expects a text value, got '${value.kind}'`);
    }
    return;
  }
  if (modality === 'yes-no') {
    if (value.kind !== 'boolean') {
      throw new TypeError(`user node '${node.id}' expects a boolean value, got '${value.kind}'`);
    }
    return;
  }
  if (modality === 'message') {
    assertMessageAnswer(node, value);
    return;
  }
  if (isAttachmentModality(modality)) {
    assertAttachmentAnswer(node, modality, value);
    return;
  }

  if (value.kind !== 'choice') {
    throw new TypeError(`user node '${node.id}' expects a choice value, got '${value.kind}'`);
  }
  const choices = node.config.choices ?? [];
  if (!choices.includes(value.choice)) {
    throw new TypeError(
      `user node '${node.id}' does not offer choice '${value.choice}' (${choices.join(', ')})`,
    );
  }
}

function isAttachmentModality(
  modality: UserNode['config']['modality'],
): modality is 'image' | 'file' {
  return modality === 'image' || modality === 'file';
}

/**
 * A message answer is text plus the (empty) attachment list fixed by Stage
 * 3C-2. The runtime validates the shape only: it never reads the filesystem.
 */
function assertMessageAnswer(node: UserNode, value: Value): void {
  if (value.kind !== 'message') {
    throw new TypeError(`user node '${node.id}' expects a message value, got '${value.kind}'`);
  }
  if (typeof value.text !== 'string') {
    throw new TypeError(`user node '${node.id}' message value must carry text`);
  }
  if (!Array.isArray(value.attachments) || value.attachments.length !== 0) {
    throw new TypeError(
      `user node '${node.id}' message value must have an empty attachments array`,
    );
  }
}

/**
 * An image/file answer is exactly one local path reference. Existence, file
 * type and absolute resolution belong to the CLI; the runtime checks shape.
 */
function assertAttachmentAnswer(
  node: UserNode,
  modality: 'image' | 'file',
  value: Value,
): void {
  if (value.kind !== 'attachments') {
    throw new TypeError(
      `user node '${node.id}' expects an attachments value, got '${value.kind}'`,
    );
  }
  if (!Array.isArray(value.attachments) || value.attachments.length !== 1) {
    throw new TypeError(
      `user node '${node.id}' expects exactly one ${modality} attachment`,
    );
  }
  const attachment = value.attachments[0];
  if (attachment === undefined || attachment.kind !== modality) {
    const expected = modality === 'image' ? 'an image' : 'a file';
    throw new TypeError(
      `user node '${node.id}' expects ${expected} attachment, got '${attachment?.kind ?? 'none'}'`,
    );
  }
  if (!hasNonEmptyPath(attachment.path)) {
    throw new TypeError(`user node '${node.id}' attachment must carry a non-empty path`);
  }
  if (!isOptionalString(attachment.mediaType)) {
    throw new TypeError(
      `user node '${node.id}' attachment mediaType must be a string when present`,
    );
  }
}

function hasNonEmptyPath(path: unknown): path is string {
  return typeof path === 'string' && path.trim() !== '';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
