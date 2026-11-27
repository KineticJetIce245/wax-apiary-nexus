import {
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type ForagerNode,
  type NodeExecutor,
  type Pheromone,
  type QueueEntry,
  type RuntimeLogEntry,
  type RuntimeOptions,
  type Value,
} from '../../src/runtime/index.js';

/** M19 test helpers: a Value is a free JSON object, not a tagged union. */
export function text(message: string): Value {
  return { message };
}

export function choice(value: string): Value {
  return { choice: value };
}

export function queueEntry(value: Value, enqueuedAt: string): QueueEntry {
  return { value, enqueuedAt };
}

export function pheromone(value: Value): Pheromone {
  return { value };
}

export function definitionOf(
  id: string,
  nodes: Record<string, unknown>,
  edges: readonly Record<string, unknown>[] = [],
  defaults: Record<string, unknown> = {},
): CompositionDefinition {
  return parseComposition({ schemaVersion: 1, id, nodes, edges, defaults });
}

/** parseComposition then zero every pacing interval (graph-host fixture rule). */
export function fastDefinition(
  id: string,
  nodes: Record<string, unknown>,
  edges: readonly Record<string, unknown>[] = [],
  defaults: Record<string, unknown> = {},
): CompositionDefinition {
  const parsed = definitionOf(id, nodes, edges, defaults);
  const fast = new Map(
    [...parsed.nodes].map(([nodeId, node]) => [nodeId, { ...node, minIntervalMs: 0 }]),
  );
  return { ...parsed, nodes: fast };
}

export interface Recorder {
  readonly executor: NodeExecutor;
  readonly calls: { nodeId: string; input: Value }[];
}

export function recorder(
  output?: (node: ForagerNode, input: Value) => Value,
): Recorder {
  const calls: { nodeId: string; input: Value }[] = [];
  return {
    calls,
    executor: {
      async execute(node, input) {
        calls.push({ nodeId: node.id, input });
        return output === undefined ? input : output(node, input);
      },
    },
  };
}

export function runtimeOf(
  definition: CompositionDefinition,
  executor: NodeExecutor,
  overrides: Partial<RuntimeOptions> = {},
): PheromoneRuntime {
  return new PheromoneRuntime(definition, { executeForager: executor, ...overrides });
}

/**
 * A gather-only definition. With `sink` the gather has one outgoing edge to a
 * forager that records the package and accepts any value (`reads`/`writes`
 * empty); without it the gather is terminal and its package is a field output.
 */
export function gatherDefinition(
  id: string,
  config: Record<string, unknown>,
  options: { readonly sink?: boolean; readonly extraNodes?: Record<string, unknown> } = {},
): CompositionDefinition {
  const nodes: Record<string, unknown> = {
    gather: { kind: 'gather', config },
    ...(options.extraNodes ?? {}),
  };
  const edges: Record<string, unknown>[] = [];
  if (options.sink === true) {
    nodes['sink'] = {
      kind: 'forager',
      reads: [],
      writes: [],
      config: { connection: 'fake', prompt: 'sink' },
    };
    edges.push({ id: 'gather-sink', from: 'gather', to: 'sink' });
  }
  return fastDefinition(id, nodes, edges);
}

/** Failure messages logged for one Bee, in order. */
export function failureMessages(
  entries: readonly RuntimeLogEntry[],
  nodeId: string,
): string[] {
  return entries
    .filter((entry) => entry.event === 'node.failed' && entry.nodeId === nodeId)
    .map((entry) => entry.error ?? '');
}
