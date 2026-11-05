import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { CliUsageError, messageOf } from './cli-shared.js';
import { expandHomePath } from './conversation-store.js';
import type { UserNode, Value } from './runtime/index.js';

/**
 * Converts one human-supplied answer string to the Value required by the node's
 * modality. Shared by the interactive one-shot CLI and `wax answer`, so an
 * answer typed on stdin and an answer queued in the inbox validate identically.
 *
 * Path handling is CLI behavior, not runtime behavior: the runtime stays
 * filesystem-free and only checks Value shape.
 */
export function parseUserAnswer(node: UserNode, answer: string): Value {
  if (node.config.modality === 'yes-no') {
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'y' || normalized === 'yes' || normalized === 'true') {
      return { kind: 'boolean', value: true };
    }
    if (normalized === 'n' || normalized === 'no' || normalized === 'false') {
      return { kind: 'boolean', value: false };
    }
    throw new CliUsageError(`expected y or n, got '${answer}'`);
  }

  if (node.config.modality === 'choice') {
    const choices = node.config.choices ?? [];
    const index = Number(answer.trim());
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      const choice = choices[index - 1];
      if (choice !== undefined) {
        return { kind: 'choice', choice };
      }
    }
    if (choices.includes(answer.trim())) {
      return { kind: 'choice', choice: answer.trim() };
    }
    throw new CliUsageError(`expected one of: ${choices.join(', ')}`);
  }

  if (node.config.modality === 'message') {
    if (answer.trim() === '') {
      throw new CliUsageError(`user node '${node.id}' needs a non-empty message`);
    }
    return { kind: 'message', text: answer, attachments: [] };
  }

  if (node.config.modality === 'image' || node.config.modality === 'file') {
    const path = resolveAttachmentPath(node, node.config.modality, answer);
    return { kind: 'attachments', attachments: [{ kind: node.config.modality, path }] };
  }

  return { kind: 'text', text: answer };
}

/**
 * Resolves one local attachment path: expands a leading `~`, requires an
 * existing regular file, and returns the absolute path. The path is a
 * reference only; nothing is copied, previewed or scanned.
 */
function resolveAttachmentPath(
  node: UserNode,
  modality: 'image' | 'file',
  answer: string,
): string {
  const trimmed = answer.trim();
  if (trimmed === '') {
    throw new CliUsageError(`user node '${node.id}' expects a local ${modality} path`);
  }
  const absolute = resolve(expandHomePath(trimmed));
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliUsageError(`attachment path does not exist: '${absolute}'`);
    }
    throw new CliUsageError(
      `attachment path cannot be read: '${absolute}' (${messageOf(error)})`,
    );
  }
  if (!stats.isFile()) {
    throw new CliUsageError(`attachment path is not a regular file: '${absolute}'`);
  }
  return absolute;
}
