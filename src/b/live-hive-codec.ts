import type { GraphBindings } from '../graph/binding.js';
import { parseComposition, type CompositionDefinition } from '../runtime/index.js';
import { parseLiveHive } from './validation.js';
import type { Bee, LiveHive } from './types.js';

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
