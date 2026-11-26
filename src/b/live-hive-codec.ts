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
 * normal edges, except spread beelines: the runtime represents spread targets in
 * `config.branches`, and a spread node may not also have outgoing edges.
 */
export function toCompositionDefinition(live: LiveHive): CompositionDefinition {
  const parsed = parseLiveHive(live);
  const nodes: Record<string, Record<string, unknown>> = {};

  for (const [beeId, bee] of Object.entries(parsed.bees)) {
    nodes[beeId] = {
      kind: bee.kind,
      config: spreadConfig(parsed, beeId, bee),
    };
  }

  const edges: Array<Record<string, unknown>> = [];
  for (const [beelineId, line] of Object.entries(parsed.beelines)) {
    const source = parsed.bees[line.fromBee];
    if (source === undefined) {
      throw new LiveHiveCodecError(`beeline '${beelineId}' has an unknown source bee`);
    }
    if (source.kind === 'spread') {
      // Spread branches live in the node config; a normal edge is invalid.
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
    triggers: (parsed.schedules ?? []).map((schedule) => ({
      id: schedule.scheduleId,
      target: schedule.targetBee,
      schedule: schedule.at !== undefined
        ? { kind: 'at', at: schedule.at }
        : { kind: 'every', everyMs: schedule.everyMs as number },
    })),
  });
}

/**
 * Only forager bindings become LiveHiveHost bindings. A binding on a control bee
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
    ...(definition.triggers.length === 0
      ? {}
      : {
          schedules: definition.triggers.map((trigger) => ({
            scheduleId: trigger.id,
            targetBee: trigger.target,
            ...(trigger.schedule.kind === 'at'
              ? { at: trigger.schedule.at }
              : { everyMs: trigger.schedule.everyMs }),
          })),
        }),
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
  // Spread targets live in config.targets and have no normal beelines.
  const outgoing = node.kind === 'spread' ? [] : importEdges(nodeId, edges, beelines);
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

function spreadConfig(
  live: LiveHive,
  beeId: string,
  bee: Bee,
): Readonly<Record<string, unknown>> {
  if (bee.kind !== 'spread') {
    return bee.config;
  }
  if (Array.isArray(bee.config['targets']) || isRecord(bee.config['targets'])) {
    return bee.config;
  }
  const targets = bee.outgoing.map((beelineId) => {
    const line = live.beelines[beelineId];
    if (line === undefined) {
      throw new LiveHiveCodecError(`bee '${beeId}' has an unknown outgoing beeline`);
    }
    return line.toBee;
  });
  if (targets.length === 0) {
    throw new LiveHiveCodecError(`spread bee '${beeId}' needs at least one target BeeId`);
  }
  return { ...bee.config, strategy: 'clone', targets };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
