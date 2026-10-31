import { readFileSync } from 'node:fs';

export interface FlowCondition {
  readonly contains?: string;
  readonly equals?: string;
  readonly then: string;
  readonly else: string;
}

export type FlowNext = string | FlowCondition;

export interface FlowSubmitNode {
  readonly type: 'submit';
  readonly participant: string;
  readonly prompt: string;
  readonly next?: FlowNext;
}

export interface FlowParallelNode {
  readonly type: 'parallel';
  readonly branches: readonly string[];
  readonly next: string;
}

export interface FlowEndNode {
  readonly type: 'end';
}

export type FlowNode = FlowSubmitNode | FlowParallelNode | FlowEndNode;

export interface FlowDefinition {
  readonly version: 1;
  readonly strategy: 'graph';
  readonly id?: string;
  readonly input?: string;
  readonly participants: Readonly<Record<string, { readonly connection: string }>>;
  readonly start: string;
  readonly nodes: Readonly<Record<string, FlowNode>>;
}

export class FlowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowDefinitionError';
  }
}

export class FlowTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowTemplateError';
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/** Placeholder names in appearance order. Rejects malformed braces. */
export function templatePlaceholders(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  const remaining = prompt.replace(PLACEHOLDER, '');
  if (remaining.includes('{{') || remaining.includes('}}')) {
    throw new FlowDefinitionError('Template contains an unmatched "{{" or "}}"');
  }
  return names;
}

export function renderTemplate(
  prompt: string,
  resolve: (name: string) => string | undefined,
): string {
  return prompt.replace(PLACEHOLDER, (_, rawName: string) => {
    const value = resolve(rawName);
    if (value === undefined) {
      throw new FlowTemplateError(`Value for {{${rawName}}} is not available on this path`);
    }
    return value;
  });
}

export function parseFlowDefinition(value: unknown): FlowDefinition {
  const root = asRecord(value, 'flow');
  const version = root.version;
  if (version !== 1) {
    throw new FlowDefinitionError(`Unsupported flow version: ${String(version)} (expected 1)`);
  }
  if (root.strategy !== 'graph') {
    throw new FlowDefinitionError(`Unsupported flow strategy: ${String(root.strategy)} (expected "graph")`);
  }
  const id = optionalString(root.id, 'flow.id');
  if (id !== undefined && id.trim() === '') {
    throw new FlowDefinitionError('flow.id must not be empty when present');
  }
  const input = optionalString(root.input, 'flow.input');
  const participants = parseParticipants(root.participants);
  const start = requiredString(root.start, 'flow.start');
  const rawNodes = asRecord(root.nodes, 'flow.nodes');
  const nodes: Record<string, FlowNode> = {};
  for (const [nodeId, rawNode] of Object.entries(rawNodes)) {
    if (!isReferenceName(nodeId)) {
      throw new FlowDefinitionError(
        `Node id ${JSON.stringify(nodeId)} must match [A-Za-z0-9_-]+ so templates can reference it`,
      );
    }
    nodes[nodeId] = parseNode(nodeId, rawNode);
  }
  if (Object.keys(nodes).length === 0) {
    throw new FlowDefinitionError('flow.nodes must not be empty');
  }

  const definition: FlowDefinition = {
    version: 1,
    strategy: 'graph',
    ...(id === undefined ? {} : { id }),
    ...(input === undefined ? {} : { input }),
    participants,
    start,
    nodes,
  };
  validateFlowDefinition(definition);
  return definition;
}

export function loadFlowDefinition(path: string): FlowDefinition {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new FlowDefinitionError(`Cannot read flow file ${path}: ${messageOf(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FlowDefinitionError(`Flow file ${path} is not valid JSON: ${messageOf(error)}`);
  }
  return parseFlowDefinition(value);
}

export function validateFlowDefinition(definition: FlowDefinition): void {
  if (Object.keys(definition.participants).length === 0) {
    throw new FlowDefinitionError('flow.participants must not be empty');
  }
  if (definition.start.trim() === '') {
    throw new FlowDefinitionError('flow.start must not be empty');
  }

  const branchOwner = new Map<string, string>();
  const referencedByNext = new Set<string>();

  // First pass: parallel groups establish branch ownership before submit nodes
  // are checked (a branch may appear before its group in JSON order).
  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    if (node.type !== 'parallel') {
      continue;
    }
    if (node.branches.length < 2) {
      throw new FlowDefinitionError(`Parallel node ${nodeId} must list at least two branches`);
    }
    if (new Set(node.branches).size !== node.branches.length) {
      throw new FlowDefinitionError(`Parallel node ${nodeId} lists a branch twice`);
    }
    if (!definition.nodes[node.next]) {
      throw new FlowDefinitionError(`Parallel node ${nodeId} points at unknown next node ${node.next}`);
    }
    referencedByNext.add(node.next);
    const connections = new Set<string>();
    for (const branchId of node.branches) {
      if (branchId === nodeId) {
        throw new FlowDefinitionError(`Parallel node ${nodeId} cannot use itself as a branch`);
      }
      const branch = definition.nodes[branchId];
      if (branch === undefined) {
        throw new FlowDefinitionError(`Parallel node ${nodeId} names unknown branch ${branchId}`);
      }
      if (branch.type !== 'submit' || branch.next !== undefined) {
        throw new FlowDefinitionError(
          `Parallel branch ${branchId} must be a submit node without next`,
        );
      }
      const previousOwner = branchOwner.get(branchId);
      if (previousOwner !== undefined) {
        throw new FlowDefinitionError(
          `Node ${branchId} belongs to more than one parallel group (${previousOwner}, ${nodeId})`,
        );
      }
      branchOwner.set(branchId, nodeId);
      const connection = participantConnection(definition, branch.participant, branchId);
      if (connections.has(connection)) {
        throw new FlowDefinitionError(
          `Parallel node ${nodeId} has two branches on connection ${connection}; parallel branches must use distinct connections`,
        );
      }
      connections.add(connection);
    }
  }

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    if (node.type !== 'submit') {
      continue;
    }
    participantConnection(definition, node.participant, nodeId);
    if (node.prompt.trim() === '') {
      throw new FlowDefinitionError(`Node ${nodeId} must have a non-empty prompt`);
    }
    const isBranch = branchOwner.has(nodeId);
    if (node.next === undefined) {
      if (!isBranch) {
        throw new FlowDefinitionError(`Node ${nodeId} must define next (only parallel branch nodes may omit it)`);
      }
      continue;
    }
    if (isBranch) {
      throw new FlowDefinitionError(`Parallel branch ${nodeId} must not define next`);
    }
    for (const target of nextTargets(node.next)) {
      if (!definition.nodes[target]) {
        throw new FlowDefinitionError(`Node ${nodeId} points at unknown next node ${target}`);
      }
      referencedByNext.add(target);
    }
  }

  for (const branchId of branchOwner.keys()) {
    if (referencedByNext.has(branchId)) {
      throw new FlowDefinitionError(
        `Parallel branch ${branchId} cannot be the target of another node's next`,
      );
    }
  }

  const startNode = definition.nodes[definition.start];
  if (startNode === undefined) {
    throw new FlowDefinitionError(`Unknown start node: ${definition.start}`);
  }
  if (startNode.type === 'end') {
    throw new FlowDefinitionError('Start node cannot be an end node');
  }
  if (branchOwner.has(definition.start)) {
    throw new FlowDefinitionError('Start node cannot be a parallel branch');
  }

  const reachable = new Set<string>();
  const queue = [definition.start];
  while (queue.length > 0) {
    const nodeId = queue.pop();
    if (nodeId === undefined || reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    const node = definition.nodes[nodeId];
    if (node === undefined || node.type === 'end') {
      continue;
    }
    if (node.type === 'parallel') {
      queue.push(...node.branches, node.next);
      continue;
    }
    if (node.next !== undefined) {
      queue.push(...nextTargets(node.next));
    }
  }
  for (const nodeId of Object.keys(definition.nodes)) {
    if (!reachable.has(nodeId)) {
      throw new FlowDefinitionError(`Node ${nodeId} is not reachable from start`);
    }
  }
  if (!Object.values(definition.nodes).some((node) => node.type === 'end')) {
    throw new FlowDefinitionError('Flow must contain an end node');
  }
  detectCycle(definition);

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    if (node.type !== 'submit') {
      continue;
    }
    for (const name of templatePlaceholders(node.prompt)) {
      if (name === 'input') {
        if (definition.input === undefined) {
          throw new FlowDefinitionError(
            `Node ${nodeId} uses {{input}} but flow.input is not set`,
          );
        }
        continue;
      }
      if (!definition.nodes[name]) {
        throw new FlowDefinitionError(`Node ${nodeId} references unknown placeholder {{${name}}}`);
      }
      if (definition.nodes[name]?.type !== 'submit') {
        throw new FlowDefinitionError(
          `Node ${nodeId} references {{${name}}}, but only submit nodes produce output`,
        );
      }
      if (name === nodeId) {
        throw new FlowDefinitionError(`Node ${nodeId} cannot reference its own output`);
      }
    }
  }
}

function parseParticipants(value: unknown): Record<string, { readonly connection: string }> {
  const record = asRecord(value, 'flow.participants');
  const participants: Record<string, { readonly connection: string }> = {};
  for (const [name, raw] of Object.entries(record)) {
    if (!isReferenceName(name)) {
      throw new FlowDefinitionError(
        `Participant name ${JSON.stringify(name)} must match [A-Za-z0-9_-]+`,
      );
    }
    const participant = asRecord(raw, `participant ${name}`);
    participants[name] = {
      connection: requiredString(participant.connection, `participant ${name}.connection`),
    };
  }
  return participants;
}

function parseNode(nodeId: string, value: unknown): FlowNode {
  const record = asRecord(value, `node ${nodeId}`);
  const type = record.type === undefined ? 'submit' : record.type;
  if (type === 'end') {
    return { type: 'end' };
  }
  if (type === 'parallel') {
    const branches = record.branches;
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new FlowDefinitionError(`Parallel node ${nodeId} must have a non-empty branches array`);
    }
    return {
      type: 'parallel',
      branches: branches.map((branch, index) => requiredString(branch, `node ${nodeId}.branches[${index}]`)),
      next: requiredString(record.next, `node ${nodeId}.next`),
    };
  }
  if (type !== 'submit') {
    throw new FlowDefinitionError(`Node ${nodeId} has unsupported type: ${String(type)}`);
  }
  return {
    type: 'submit',
    participant: requiredString(record.participant, `node ${nodeId}.participant`),
    prompt: requiredString(record.prompt, `node ${nodeId}.prompt`),
    ...(record.next === undefined ? {} : { next: parseNext(nodeId, record.next) }),
  };
}

function parseNext(nodeId: string, value: unknown): FlowNext {
  if (typeof value === 'string') {
    if (value.trim() === '') {
      throw new FlowDefinitionError(`Node ${nodeId}.next must not be empty`);
    }
    return value;
  }
  const record = asRecord(value, `node ${nodeId}.next`);
  const contains = optionalString(record.contains, `node ${nodeId}.next.contains`);
  const equals = optionalString(record.equals, `node ${nodeId}.next.equals`);
  if ((contains === undefined) === (equals === undefined)) {
    throw new FlowDefinitionError(
      `Node ${nodeId}.next must define exactly one of contains/equals`,
    );
  }
  return {
    ...(contains === undefined ? {} : { contains }),
    ...(equals === undefined ? {} : { equals }),
    then: requiredString(record.then, `node ${nodeId}.next.then`),
    else: requiredString(record.else, `node ${nodeId}.next.else`),
  };
}

function nextTargets(next: FlowNext): string[] {
  return typeof next === 'string' ? [next] : [next.then, next.else];
}

function participantConnection(
  definition: FlowDefinition,
  participantName: string,
  nodeId: string,
): string {
  const participant = definition.participants[participantName];
  if (participant === undefined) {
    throw new FlowDefinitionError(`Node ${nodeId} names unknown participant ${participantName}`);
  }
  return participant.connection;
}

function detectCycle(definition: FlowDefinition): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      throw new FlowDefinitionError(`Flow contains a cycle at node ${nodeId}`);
    }
    visiting.add(nodeId);
    const node = definition.nodes[nodeId];
    if (node !== undefined && node.type !== 'end') {
      if (node.type === 'parallel') {
        for (const branch of node.branches) {
          visit(branch);
        }
        visit(node.next);
      } else if (node.next !== undefined) {
        for (const target of nextTargets(node.next)) {
          visit(target);
        }
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(definition.start);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FlowDefinitionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FlowDefinitionError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new FlowDefinitionError(`${label} must be a string when present`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReferenceName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
