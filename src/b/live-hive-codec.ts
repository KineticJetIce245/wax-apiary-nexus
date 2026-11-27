import type { GraphBindings } from '../graph/binding.js';
import {
  parseComposition,
  type CompositionDefinition,
  type EdgeDefinition,
  type GatherConfig,
  type NodeDefinition,
  type SpreadConfig,
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
 * normal edges; a condition beeline carries its `true`/`false` outcome as the
 * edge `when`. A spread has no edges: its BeeId targets live in `config.targets`.
 */
export function toCompositionDefinition(live: LiveHive): CompositionDefinition {
  const parsed = parseLiveHive(live);
  const nodes: Record<string, Record<string, unknown>> = {};

  for (const [beeId, bee] of Object.entries(parsed.bees)) {
    nodes[beeId] = nodeRecord(bee);
  }

  return parseComposition({
    schemaVersion: 1,
    id: parsed.liveId,
    nodes,
    edges: edgeRecords(parsed),
    triggers: (parsed.schedules ?? []).map((schedule) => ({
      id: schedule.scheduleId,
      target: schedule.targetBee,
      schedule: schedule.at !== undefined
        ? { kind: 'at', at: schedule.at }
        : { kind: 'every', everyMs: schedule.everyMs as number },
    })),
  });
}

function nodeRecord(bee: Bee): Record<string, unknown> {
  const record: Record<string, unknown> = {
    kind: bee.kind,
    config: bee.config,
  };
  if (bee.reads !== undefined) {
    record['reads'] = bee.reads;
  }
  if (bee.writes !== undefined) {
    record['writes'] = bee.writes;
  }
  if (bee.fallback !== undefined) {
    record['fallback'] = bee.fallback;
  }
  if (bee.filter !== undefined) {
    record['filter'] = bee.filter;
  }
  return record;
}

function edgeRecords(live: LiveHive): Array<Record<string, unknown>> {
  const edges: Array<Record<string, unknown>> = [];
  for (const [beelineId, line] of Object.entries(live.beelines)) {
    const source = live.bees[line.fromBee];
    if (source === undefined) {
      throw new LiveHiveCodecError(`beeline '${beelineId}' has an unknown source bee`);
    }
    if (source.kind === 'spread') {
      throw new LiveHiveCodecError(
        `spread bee '${line.fromBee}' targets config.targets, not beeline '${beelineId}'`,
      );
    }
    const edge: Record<string, unknown> = {
      id: beelineId,
      from: line.fromBee,
      to: line.toBee,
    };
    if (source.kind === 'condition') {
      if (line.when !== 'true' && line.when !== 'false') {
        throw new LiveHiveCodecError(
          `condition beeline '${beelineId}' must have when 'true' or 'false'`,
        );
      }
      edge['when'] = line.when;
    } else if (line.when !== undefined) {
      throw new LiveHiveCodecError(
        `beeline '${beelineId}' carries a condition outcome from a non-condition bee`,
      );
    }
    edges.push(edge);
  }
  return edges;
}

/**
 * Reverse importer for the composition shape. Node/edge ids are preserved and
 * an explicit session binding becomes `bindings`. Spread targets stay in the
 * spread config; no beeline is fabricated for them. A counter node has no B
 * kind and is rejected.
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
    assertNoSpreadEdges(nodeId, node, definition.edges);
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

function assertNoSpreadEdges(
  nodeId: string,
  node: Exclude<NodeDefinition, { kind: 'counter' }>,
  edges: readonly EdgeDefinition[],
): void {
  if (node.kind === 'spread' && edges.some((edge) => edge.from === nodeId)) {
    throw new LiveHiveCodecError(`spread node '${nodeId}' must not have outgoing edges`);
  }
}

function importNode(
  nodeId: string,
  node: Exclude<NodeDefinition, { kind: 'counter' }>,
  edges: readonly EdgeDefinition[],
  binding: GraphBindings[string] | undefined,
  beelines: Record<string, Beeline>,
  sessionBindings: Record<string, string>,
): Bee {
  const config = importConfig(node);
  const outgoing = node.kind === 'spread'
    ? []
    : importEdges(nodeId, node.kind, edges, beelines);
  const sessionMode = importBinding(nodeId, binding, config, sessionBindings);
  return {
    kind: node.kind as BeeKind,
    config,
    outgoing,
    ...(node.reads.length === 0 ? {} : { reads: node.reads }),
    ...(node.writes.length === 0 ? {} : { writes: node.writes }),
    ...(node.fallback === undefined ? {} : { fallback: node.fallback }),
    ...(node.filter === undefined ? {} : { filter: node.filter }),
    ...(sessionMode === undefined ? {} : { sessionMode }),
  };
}

function importConfig(
  node: Exclude<NodeDefinition, { kind: 'counter' }>,
): Record<string, unknown> {
  if (node.kind === 'spread') {
    return importSpreadConfig(node.config);
  }
  if (node.kind === 'gather') {
    return importGatherConfig(node.config);
  }
  return structuredClone(node.config) as unknown as Record<string, unknown>;
}

function importSpreadConfig(config: SpreadConfig): Record<string, unknown> {
  const spread: Record<string, unknown> = {
    strategy: config.strategy,
    targets: structuredClone(config.targets),
  };
  return spread;
}

/** Batch types carry no `count`; the runtime normalizes it to one internally. */
function importGatherConfig(config: GatherConfig): Record<string, unknown> {
  const types: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(config.types)) {
    types[name] = {
      match: structuredClone(type.match),
      ...(config.strategy === 'assemble' ? { count: type.count } : {}),
      reads: [...type.reads],
    };
  }
  const gather: Record<string, unknown> = {
    strategy: config.strategy,
    types,
    typeQueueMax: config.typeQueueMax,
  };
  if (config.strategy === 'assemble' && config.groupBy !== undefined) {
    gather['groupBy'] = structuredClone(config.groupBy);
  }
  if (config.strategy === 'batch') {
    gather['batch'] = structuredClone(config.batch);
  }
  return gather;
}

function importEdges(
  nodeId: string,
  kind: BeeKind,
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
    if (kind === 'condition') {
      if (edge.when !== 'true' && edge.when !== 'false') {
        throw new LiveHiveCodecError(
          `condition edge '${edge.id}' must have when 'true' or 'false'`,
        );
      }
      beelines[edge.id] = { fromBee: nodeId, toBee: edge.to, when: edge.when };
    } else {
      if (edge.when !== undefined) {
        throw new LiveHiveCodecError(
          `edge '${edge.id}' carries an outcome from a non-condition bee`,
        );
      }
      beelines[edge.id] = { fromBee: nodeId, toBee: edge.to };
    }
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
