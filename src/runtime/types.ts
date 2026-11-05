/**
 * Core value and graph types for the single-Pheromone runtime slice.
 *
 * The full contract lives in CONTRACT.md; this module mirrors the parts that
 * Stage 1 implements: Value, Pheromone, NodeState, Composition definition.
 */

export type NodeId = string;

export interface Attachment {
  kind: 'image' | 'file' | 'audio';
  path?: string;
  mediaType?: string;
}

/**
 * A Value is what a Pheromone carries. Stage 1 only produces text values from
 * triggers and whatever the injected executor returns.
 */
export type Value =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; choice: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'message'; text?: string; attachments: Attachment[] }
  | { kind: 'attachments'; attachments: Attachment[] };

export interface Pheromone {
  id: string;
  traceId: string;
  forkId?: string;
  branchId?: string;
  value: Value;
  at: string;
}

export interface ForagerConfig {
  connection: string;
  prompt: string;
}

export interface ConditionTextConfig {
  mode: 'text';
  contains?: string;
  equals?: string;
}

export interface ConditionBooleanConfig {
  mode: 'boolean';
}

export interface ConditionChoiceConfig {
  mode: 'choice';
  choice: string;
}

export type ConditionConfig =
  | ConditionTextConfig
  | ConditionBooleanConfig
  | ConditionChoiceConfig;

export interface CounterConfig {
  max: number;
  step: number;
}

export interface ForagerNode {
  id: NodeId;
  kind: 'forager';
  config: ForagerConfig;
  minIntervalMs: number;
}

export interface ConditionNode {
  id: NodeId;
  kind: 'condition';
  config: ConditionConfig;
  minIntervalMs: number;
}

export interface CounterNode {
  id: NodeId;
  kind: 'counter';
  config: CounterConfig;
  minIntervalMs: number;
}

export type UserModality = 'text' | 'choice' | 'yes-no';

export interface UserConfig {
  modality: UserModality;
  prompt: string;
  /** Required for `choice`; the accepted labels. */
  choices?: readonly string[];
}

export interface UserNode {
  id: NodeId;
  kind: 'user';
  config: UserConfig;
  minIntervalMs: number;
}

export type NodeDefinition = ForagerNode | ConditionNode | CounterNode | UserNode;

export type NodeKind = NodeDefinition['kind'];

/**
 * A Hover parks one Pheromone while the runtime waits for an external event.
 * Stage 2B only opens `user` hovers; Guard/Forager hovers arrive in 2C.
 */
export interface HoverSpec {
  token: string;
  kind: 'user' | 'forager' | 'guard' | 'timer';
  compositionId: string;
  nodeId: NodeId;
  pheromoneId: string;
  expiresAt?: string;
  meta?: Record<string, unknown>;
}

export type EdgeWhen = 'true' | 'false' | 'continue' | 'done';

export interface EdgeDefinition {
  id: string;
  from: NodeId;
  to: NodeId;
  when?: EdgeWhen;
}

export interface CompositionDefaults {
  minIntervalMs: number;
  queueMax: number;
  queueTtlMs: number;
}

export interface CompositionDefinition {
  schemaVersion: 1;
  id: string;
  graphRevision: string;
  nodes: ReadonlyMap<NodeId, NodeDefinition>;
  edges: readonly EdgeDefinition[];
  defaults: CompositionDefaults;
}

/** Mutable per-node runtime state. Never handed out directly. */
export interface NodeState {
  queue: Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  lastActivatedAt?: string;
  hover?: HoverSpec;
  /** The Pheromone parked behind `hover`; it is still part of the field. */
  hoverPheromone?: Pheromone;
  state?: Record<string, unknown>;
}

/** Immutable view returned by PheromoneRuntime.snapshot(). */
export interface NodeStateSnapshot {
  queue: readonly Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  hover?: HoverSpec;
  lastActivatedAt?: string;
  state: Readonly<Record<string, unknown>>;
}

export interface PheromoneFieldSnapshot {
  schemaVersion: 1;
  compositionId: string;
  graphRevision: string;
  rest: boolean;
  pheromones: readonly Pheromone[];
  nodes: Readonly<Record<NodeId, NodeStateSnapshot>>;
}

/** JSON shape of `honey/field.json`. */
export interface PersistedNodeState {
  queue: Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  hover?: HoverSpec;
  hoverPheromone?: Pheromone;
  lastActivatedAt?: string;
  state?: Record<string, unknown>;
  /** Answers that arrived before this node hovered; applied on the next hover. */
  inputs?: Value[];
}

export interface PersistedField {
  schemaVersion: 1;
  compositionId: string;
  graphRevision: string;
  rest: boolean;
  nodes: Record<NodeId, PersistedNodeState>;
}

/** What a restore could not keep running, and why. */
export interface RecoveryReport {
  readonly resumedHovers: readonly NodeId[];
  /** A forager was mid-execution when the process died; never replayed. */
  readonly unknownActive: readonly NodeId[];
  /** An active Pheromone on a node that cannot be resumed at all. */
  readonly stuckActive: readonly NodeId[];
}
