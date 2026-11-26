import { NotImplementedError } from './errors.js';
import type { GatherNode } from './types.js';

/**
 * Gather assemble/batch is M19d. The configuration and its parser are part of
 * this slice so the model compiles, but the execution path fails with a typed
 * error instead of keeping the removed join/lineage behaviour.
 */
export function runGather(node: GatherNode): never {
  throw new NotImplementedError(
    'gather',
    `bee '${node.id}' uses strategy '${node.config.strategy}', implemented in M19d`,
  );
}
