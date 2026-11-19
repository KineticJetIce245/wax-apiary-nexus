import { createHash } from 'node:crypto';

import type {
  CompositionDefaults,
  CompositionDefinition,
  EdgeDefinition,
  NodeDefinition,
  NodeId,
} from './types.js';
import { CompositionValidationError } from './definition-error.js';
import {
  parseDefaults,
  parseEdges,
  parseNodes,
  validateEdgeShape,
} from './definition-nodes.js';
import { isNonEmptyString, isRecord, pushUnknownFields } from './definition-primitives.js';
import { parseTriggers } from './definition-triggers.js';

export { CompositionValidationError } from './definition-error.js';
export {
  DEFAULT_MERGE_TIMEOUT_MS,
  MAX_MERGE_TIMEOUT_MS,
} from './definition-constants.js';

export function parseComposition(input: unknown): CompositionDefinition {
  const issues: string[] = [];

  if (!isRecord(input)) {
    throw new CompositionValidationError(['composition: expected an object']);
  }

  pushUnknownFields(
    input,
    ['schemaVersion', 'id', 'nodes', 'edges', 'defaults', 'triggers'],
    'composition',
    issues,
  );

  if (input['schemaVersion'] !== 1) {
    issues.push('schemaVersion: expected 1');
  }

  const id = input['id'];
  if (!isNonEmptyString(id)) {
    issues.push('id: expected a non-empty string');
  }

  const defaults = parseDefaults(input['defaults'], issues);
  const nodes = parseNodes(input['nodes'], defaults, issues);
  const edges = parseEdges(input['edges'], nodes, issues);
  validateEdgeShape(nodes, edges, issues);
  const triggers = parseTriggers(input['triggers'], nodes, issues);

  if (issues.length > 0) {
    throw new CompositionValidationError(issues);
  }

  const composition: CompositionDefinition = {
    schemaVersion: 1,
    id: id as string,
    graphRevision: computeGraphRevision(id as string, nodes, edges, defaults),
    nodes,
    edges,
    defaults,
    triggers,
  };

  return composition;
}

function computeGraphRevision(
  id: string,
  nodes: ReadonlyMap<NodeId, NodeDefinition>,
  edges: readonly EdgeDefinition[],
  defaults: CompositionDefaults,
): string {
  const canonical = JSON.stringify({
    id,
    nodes: [...nodes.values()].map((node) => ({
      id: node.id,
      kind: node.kind,
      config: node.config,
      minIntervalMs: node.minIntervalMs,
    })),
    edges,
    defaults,
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
