import { NotImplementedError } from './errors.js';
import type { SpreadNode } from './types.js';

/**
 * Spread clone/cleave is M19c. The configuration and its parser are part of
 * this slice so the model compiles, but the execution path fails with a typed
 * error instead of keeping the removed branch/lineage behaviour.
 */
export function runSpread(node: SpreadNode): never {
  throw new NotImplementedError(
    'spread',
    `bee '${node.id}' uses strategy '${node.config.strategy}', implemented in M19c`,
  );
}
