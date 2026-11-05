import type { ForagerNode, Value } from './types.js';

/**
 * The runtime never talks to a harness directly. A forager node delegates to an
 * injected executor, which is scripted in tests and wired to real adapters later.
 */
export interface NodeExecutor {
  execute(node: ForagerNode, input: Value): Promise<Value>;
}

/**
 * Serializes a Value to the text carried by `{{input}}`.
 *
 * Stage 1 keeps this a pure helper so the contract's template rule is testable
 * without an adapter: the executor renders `node.config.prompt` with
 * `renderPrompt` before handing it to a harness.
 */
export function serializeValue(value: Value): string {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'choice':
      return value.choice;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'message':
      return value.text ?? '';
    case 'attachments':
      return '';
  }
}

export function renderPrompt(template: string, input: Value): string {
  return template.split('{{input}}').join(serializeValue(input));
}
