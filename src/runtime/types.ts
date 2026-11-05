/**
 * Core value and graph types for the PheromoneField runtime.
 *
 * The full contract lives in CONTRACT.md; this module mirrors the implemented
 * parts: Value, Pheromone, NodeState, joins, and the composition definition.
 */

export type NodeId = string;

export interface Attachment {
  kind: 'image' | 'file' | 'audio';
  path?: string;
  mediaType?: string;
}

/**
 * A Value is what a Pheromone carries. Triggers, executors and Merge's text
 * combine use the same union; Stage 3A adds no new Value kind.
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

/**
 * A local task run as an argv array, never a shell string. `cwd` is resolved
 * against the registered project directory at activation; the default `.`
 * means the project directory itself.
 */
export interface WorkerConfig {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
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

/** Runs an argv worker and branches on its exit code; non-zero is `false`. */
export interface ConditionWorkerConfig extends WorkerConfig {
  mode: 'worker';
}

export type ConditionConfig =
  | ConditionTextConfig
  | ConditionBooleanConfig
  | ConditionChoiceConfig
  | ConditionWorkerConfig;

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

export interface WorkerNode {
  id: NodeId;
  kind: 'worker';
  config: WorkerConfig;
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

/** One labelled branch created by a Fork. Branch is not a node kind. */
export interface ForkBranch {
  id: string;
  to: NodeId;
}

export interface ForkConfig {
  branches: readonly ForkBranch[];
}

export interface ForkNode {
  id: NodeId;
  kind: 'fork';
  config: ForkConfig;
  minIntervalMs: number;
}

/**
 * Stage 3A merges only required branches and combines them as text. Optional
 * branches and the object/array combine shapes have no approved Value yet.
 */
export interface MergeConfig {
  required: readonly string[];
  combine: 'text';
}

export interface MergeNode {
  id: NodeId;
  kind: 'merge';
  config: MergeConfig;
  minIntervalMs: number;
}

export type NodeDefinition =
  | ForagerNode
  | WorkerNode
  | ConditionNode
  | CounterNode
  | UserNode
  | ForkNode
  | MergeNode;

export type NodeKind = NodeDefinition['kind'];

/**
 * A Hover parks one Pheromone while the runtime waits for an external event.
 * The runtime opens user and Guard hovers; forager/timer are reserved.
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

/**
 * Branch Pheromones a Merge has already received for one forkId. The branch id
 * is the map key; a second arrival for the same branch is a protocol error.
 */
export interface JoinState {
  forkId: string;
  arrived: Map<string, Pheromone>;
}

export interface JoinStateSnapshot {
  forkId: string;
  arrived: readonly Pheromone[];
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
  /** Merge-only: partially complete joins, keyed by forkId. */
  joins?: Map<string, JoinState>;
}

/** Immutable view returned by PheromoneRuntime.snapshot(). */
export interface NodeStateSnapshot {
  queue: readonly Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  hover?: HoverSpec;
  lastActivatedAt?: string;
  state: Readonly<Record<string, unknown>>;
  joins?: Readonly<Record<string, JoinStateSnapshot>>;
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
export interface PersistedJoinState {
  arrived: Pheromone[];
}

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
  /** Merge-only: partial joins keyed by forkId. */
  joins?: Record<string, PersistedJoinState>;
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
