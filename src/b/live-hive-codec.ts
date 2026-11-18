import type { GraphBindings } from '../graph/binding.js';
import {
  parseComposition,
  type CompositionDefinition,
  type EdgeDefinition,
  type NodeDefinition,
} from '../runtime/index.js';
import { parseLiveHive } from './validation.js';
import type { Bee, BeeKind, Beeline, LiveHive, SessionMode } from './types.js';

/** A LiveHive that cannot be expressed as the existing composition schema. */
export class LiveHiveCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveHiveCodecError';
  }
}

/**
 * Map a LiveHive to the runtime's CompositionDefinition. Beelines become
 * normal edges, except fork beelines: the runtime represents fork targets in
 * `config.branches`, and a fork node may not also have outgoing edges.
 */
export function toCompositionDefinition(live: LiveHive): CompositionDefinition {
  const parsed = parseLiveHive(live);
  const nodes: Record<string, Record<string, unknown>> = {};

  for (const [beeId, bee] of Object.entries(parsed.bees)) {
    nodes[beeId] = {
      kind: bee.kind,
      config: forkConfig(parsed, beeId, bee),
    };
  }

  const edges: Array<Record<string, unknown>> = [];
  for (const [beelineId, line] of Object.entries(parsed.beelines)) {
    const source = parsed.bees[line.fromBee];
    if (source === undefined) {
      throw new LiveHiveCodecError(`beeline '${beelineId}' has an unknown source bee`);
    }
    if (source.kind === 'fork') {
      // Fork branches live in the node config; a normal edge is invalid.
      continue;
    }
    const edge: Record<string, unknown> = {
      id: beelineId,
      from: line.fromBee,
      to: line.toBee,
    };
    if (source.kind === 'condition') {
      if (line.branch !== 'true' && line.branch !== 'false') {
        throw new LiveHiveCodecError(
          `condition beeline '${beelineId}' must have branch 'true' or 'false'`,
        );
      }
      edge['when'] = line.branch;
    }
    edges.push(edge);
  }

  return parseComposition({
    schemaVersion: 1,
    id: parsed.liveId,
    nodes,
    edges,
    triggers: [],
  });
}

/**
 * Only forager bindings become GraphHost bindings. A binding on a control bee
 * is not a runtime binding and is deliberately ignored here.
 */
/**
 * One-way importer from the legacy composition shape. It preserves node/edge
 * ids and explicit session bindings; fresh binding harness/mode is copied where
 * the B object has a field. It is a migration helper, not a second truth.
 */
export function fromCompositionDefinition(
  definition: CompositionDefinition,
  bindings?: GraphBindings,
  liveId = definition.id,
): LiveHive {
  const bees: Record<string, Bee> = {};
  const beelines: Record<string, Beeline> = {};
  const sessionBindings: Record<string, string> = {};

  for (const [nodeId, node] of definition.nodes) {
    if (node.kind === 'counter') {
      throw new LiveHiveCodecError(`counter node '${nodeId}' has no B bee kind`);
    }
    bees[nodeId] = importNode(
      nodeId,
      node,
      definition.edges,
      bindings?.[nodeId],
      beelines,
      sessionBindings,
    );
  }

  return parseLiveHive({
    schemaVersion: 1,
    liveId,
    bees,
    beelines,
    bindings: sessionBindings,
  });
}

function importNode(
  nodeId: string,
  node: Exclude<NodeDefinition, { kind: 'counter' }>,
  edges: readonly EdgeDefinition[],
  binding: GraphBindings[string] | undefined,
  beelines: Record<string, Beeline>,
  sessionBindings: Record<string, string>,
): Bee {
  const config: Record<string, unknown> = { ...node.config };
  const outgoing = importEdges(nodeId, edges, beelines);
  if (node.kind === 'fork') {
    appendForkBranches(nodeId, node.config.branches, beelines, outgoing);
  }
  const sessionMode = importBinding(nodeId, binding, config, sessionBindings);
  return {
    kind: node.kind as BeeKind,
    config,
    outgoing,
    ...(sessionMode === undefined ? {} : { sessionMode }),
  };
}

function importEdges(
  nodeId: string,
  edges: readonly EdgeDefinition[],
  beelines: Record<string, Beeline>,
): string[] {
  const outgoing: string[] = [];
  for (const edge of edges) {
    if (edge.from !== nodeId) {
      continue;
    }
    if (Object.hasOwn(beelines, edge.id)) {
      throw new LiveHiveCodecError(`duplicate beeline id '${edge.id}'`);
    }
    beelines[edge.id] = {
      fromBee: nodeId,
      toBee: edge.to,
      ...(edge.when === undefined ? {} : { branch: edge.when }),
    };
    outgoing.push(edge.id);
  }
  return outgoing;
}

function appendForkBranches(
  nodeId: string,
  branches: readonly { readonly id: string; readonly to: string }[],
  beelines: Record<string, Beeline>,
  outgoing: string[],
): void {
  for (const branch of branches) {
    const beelineId = `fork:${nodeId}:${branch.id}`;
    if (Object.hasOwn(beelines, beelineId)) {
      throw new LiveHiveCodecError(`duplicate beeline id '${beelineId}'`);
    }
    beelines[beelineId] = {
      fromBee: nodeId,
      toBee: branch.to,
      branch: branch.id,
    };
    outgoing.push(beelineId);
  }
}

function importBinding(
  nodeId: string,
  binding: GraphBindings[string] | undefined,
  config: Record<string, unknown>,
  sessionBindings: Record<string, string>,
): SessionMode | undefined {
  if (binding?.kind === 'session') {
    sessionBindings[nodeId] = binding.sessionId;
    return undefined;
  }
  if (binding?.kind !== 'fresh') {
    return undefined;
  }
  if (binding.harness !== undefined) {
    config['connection'] = binding.harness;
  }
  return (binding.mode ?? 'always') === 'once' ? 'fresh_once' : 'always_fresh';
}

export function toGraphBindings(live: LiveHive): GraphBindings {
  const parsed = parseLiveHive(live);
  const bindings: Record<string, { kind: 'session'; sessionId: string }> = {};
  for (const [beeId, sessionId] of Object.entries(parsed.bindings)) {
    if (parsed.bees[beeId]?.kind === 'forager') {
      bindings[beeId] = { kind: 'session', sessionId };
    }
  }
  return bindings;
}

function forkConfig(
  live: LiveHive,
  beeId: string,
  bee: Bee,
): Readonly<Record<string, unknown>> {
  if (bee.kind !== 'fork') {
    return bee.config;
  }
  const existing = bee.config['branches'];
  if (Array.isArray(existing) && existing.length > 0) {
    return bee.config;
  }

  const branches = bee.outgoing.map((beelineId) => {
    const line = live.beelines[beelineId];
    if (line === undefined) {
      throw new LiveHiveCodecError(`bee '${beeId}' has an unknown outgoing beeline`);
    }
    return { id: line.branch ?? beelineId, to: line.toBee };
  });
  if (branches.length === 0) {
    throw new LiveHiveCodecError(`fork bee '${beeId}' needs at least one branch`);
  }
  return { ...bee.config, branches };
}
