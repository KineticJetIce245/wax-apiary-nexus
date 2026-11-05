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
 * The JSON-safe data a `structured` Value may carry: null, booleans, finite
 * numbers, strings, arrays and plain objects. Existing Value objects are legal
 * members because they are plain JSON objects; the type itself stays JSON-only
 * so the Honey and serialization boundaries have one shape to check.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A Value is what a Pheromone carries. Triggers, executors and Merge use the
 * same union. Stage 5C adds `structured` so an object/array Merge can preserve
 * structure instead of flattening every branch to text.
 */
export type Value =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; choice: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'message'; text?: string; attachments: Attachment[] }
  | { kind: 'attachments'; attachments: Attachment[] }
  | { kind: 'structured'; value: JsonValue };

/**
 * One Fork branch a Pheromone belongs to. A nested Fork appends its tag to the
 * incoming lineage, so the array is ordered outer-to-inner and the last tag is
 * the current fork. Stage 5D adds the lineage; `forkId`/`branchId` stay on the
 * Pheromone for compatibility and always point at the last tag.
 */
export interface BranchTag {
  forkId: string;
  branchId: string;
}

export interface Pheromone {
  id: string;
  traceId: string;
  forkId?: string;
  branchId?: string;
  /** Fork ancestry, outer-to-inner; absent for an untagged Pheromone. */
  lineage?: readonly BranchTag[];
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

/**
 * Stage 3C-2 adds the rich manual modalities. `message` answers carry text
 * only; `image` and `file` answers carry one local path as an attachment.
 */
export type UserModality = 'text' | 'choice' | 'yes-no' | 'message' | 'image' | 'file';

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
 * Stage 5A adds optional branches to the Stage 3A text combine. `optional` is
 * best effort: the required set completes the join immediately and an optional
 * branch only contributes when it has already arrived. Stage 5B adds
 * `timeoutMs`, measured from the first branch arrival for one forkId. Stage 5C
 * adds `object` and `array`, which emit a `structured` Value instead of text.
 */
export type MergeCombine = 'text' | 'object' | 'array';

export interface MergeConfig {
  required: readonly string[];
  optional: readonly string[];
  combine: MergeCombine;
  timeoutMs: number;
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

/**
 * A scheduled trigger. Stage 3C-1 supports one-shot `at` and fixed-interval
 * `every`; a manual trigger is a CLI action and is never stored in the file.
 * `at` must carry `Z` or an explicit offset, so it names one instant.
 */
export type TriggerSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number };

/**
 * A scheduled trigger names a forager or worker task node. Control nodes and
 * scheduled `user` targets are not valid in 3C-1.
 */
export interface TriggerDefinition {
  id: string;
  target: NodeId;
  schedule: TriggerSchedule;
}

export interface CompositionDefinition {
  schemaVersion: 1;
  id: string;
  graphRevision: string;
  nodes: ReadonlyMap<NodeId, NodeDefinition>;
  edges: readonly EdgeDefinition[];
  defaults: CompositionDefaults;
  /** Scheduled triggers; empty when the composition has none. */
  triggers: readonly TriggerDefinition[];
}

/**
 * Branch Pheromones a Merge has already received for one forkId. The branch id
 * is the map key; a second arrival for the same branch is a protocol error.
 *
 * Stage 5A keeps a completed join as a tombstone: `completedAt` is set and the
 * consumed `arrived` entries are cleared, so a late optional branch can still be
 * dropped rather than reopening the join. Stage 5B adds the same tombstone for a
 * deadline failure (`timedOutAt`). `deadlineAt` is an absolute epoch-ms time set
 * when the first branch of the fork arrives; it is cleared when the join closes.
 *
 * Stage 5D adds `lineage`: the parent lineage shared by every arrival, i.e. the
 * arrived Pheromones' lineage with their current (last) tag removed. A nested
 * Merge emits with this lineage restored; a top-level join has none.
 */
export interface JoinState {
  forkId: string;
  /** Parent lineage; absent when the joined fork is top-level. */
  lineage?: readonly BranchTag[];
  arrived: Map<string, Pheromone>;
  completedAt?: string;
  deadlineAt?: number;
  timedOutAt?: string;
}

export interface JoinStateSnapshot {
  forkId: string;
  lineage?: readonly BranchTag[];
  arrived: readonly Pheromone[];
  completedAt?: string;
  deadlineAt?: number;
  timedOutAt?: string;
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
  /** Parent lineage restored by this join's Merge; absent at top level. */
  lineage?: BranchTag[];
  arrived: Pheromone[];
  /** Set on a completed tombstone; its `arrived` list is empty. */
  completedAt?: string;
  /** Absolute epoch-ms deadline for an incomplete join. */
  deadlineAt?: number;
  /** Set on a timed-out tombstone; its `arrived` list is empty. */
  timedOutAt?: string;
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
