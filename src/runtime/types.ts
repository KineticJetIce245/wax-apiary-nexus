/**
 * Core value and graph types for the PheromoneField runtime.
 *
 * The full contract lives in CONTRACT.md; this module mirrors the implemented
 * parts: Value, Pheromone, NodeState, gathers, and the composition definition.
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
 * A Value is what a Pheromone carries. Triggers, executors and Gather use the
 * same union. Stage 5C adds `structured` so an object/array Gather can preserve
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
 * One Spread branch a Pheromone belongs to. A nested Spread appends its tag to the
 * incoming lineage, so the array is ordered outer-to-inner and the last tag is
 * the current spread. Stage 5D adds the lineage; `spreadId`/`branchId` stay on the
 * Pheromone for compatibility and always point at the last tag.
 */
export interface BranchTag {
  spreadId: string;
  branchId: string;
}

export interface Pheromone {
  id: string;
  spreadId?: string;
  branchId?: string;
  /** Spread ancestry, outer-to-inner; absent for an untagged Pheromone. */
  lineage?: readonly BranchTag[];
  value: Value;
  /**
   * The enqueue instant, as an ISO timestamp: the moment this Pheromone was
   * pushed into its target node's queue. `defaults.queueTtlMs` is measured from
   * here. Restore keeps the persisted value unchanged; it is never rewritten
   * when the Pheromone is dequeued, activated, or moved to `pending`.
   */
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

/** One labelled branch created by a Spread. Branch is not a node kind. */
export interface SpreadBranch {
  id: string;
  to: NodeId;
}

export interface SpreadConfig {
  branches: readonly SpreadBranch[];
}

export interface SpreadNode {
  id: NodeId;
  kind: 'spread';
  config: SpreadConfig;
  minIntervalMs: number;
}

/**
 * Stage 5A adds optional branches to the Stage 3A text combine. `optional` is
 * best effort: the required set completes the join immediately and an optional
 * branch only contributes when it has already arrived. Stage 5B adds
 * `timeoutMs`, measured from the first branch arrival for one spreadId. Stage 5C
 * adds `object` and `array`, which emit a `structured` Value instead of text.
 */
export type CombineMode = 'text' | 'object' | 'array';

export interface GatherConfig {
  required: readonly string[];
  optional: readonly string[];
  combine: CombineMode;
  timeoutMs: number;
}

export interface GatherNode {
  id: NodeId;
  kind: 'gather';
  config: GatherConfig;
  minIntervalMs: number;
}

export type NodeDefinition =
  | ForagerNode
  | WorkerNode
  | ConditionNode
  | CounterNode
  | UserNode
  | SpreadNode
  | GatherNode;

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
 * A scheduled trigger names a task node: forager, worker, or user. A scheduled
 * user target opens a Hover; the control answer surface completes it without a TTY.
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
 * Branch Pheromones a Gather has already received for one spreadId. The branch id
 * is the map key; a second arrival for the same branch is a protocol error.
 *
 * Stage 5A keeps a completed join as a tombstone: `completedAt` is set and the
 * consumed `arrived` entries are cleared, so a late optional branch can still be
 * dropped rather than reopening the join. Stage 5B adds the same tombstone for a
 * deadline failure (`timedOutAt`). `deadlineAt` is an absolute epoch-ms time set
 * when the first branch of the spread arrives; it is cleared when the join closes.
 *
 * Stage 5D adds `lineage`: the parent lineage shared by every arrival, i.e. the
 * arrived Pheromones' lineage with their current (last) tag removed. A nested
 * Gather emits with this lineage restored; a top-level join has none.
 */
export interface GatherState {
  spreadId: string;
  /** Parent lineage; absent when the joined spread is top-level. */
  lineage?: readonly BranchTag[];
  arrived: Map<string, Pheromone>;
  completedAt?: string;
  deadlineAt?: number;
  timedOutAt?: string;
}

export interface GatherStateSnapshot {
  spreadId: string;
  lineage?: readonly BranchTag[];
  arrived: readonly Pheromone[];
  completedAt?: string;
  deadlineAt?: number;
  timedOutAt?: string;
}

/** Mutable per-node runtime state. Never handed out directly. */
export interface NodeState {
  /**
   * The bee's receptor: input waiting to be activated, in FIFO order. It exists
   * only while the bee is awake; the drain removes it when the receptor is empty
   * and no pending activation is held, so a resting bee keeps no receptor.
   */
  receptor?: Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  /**
   * Output slots reserved by an in-flight activation that is about to enqueue
   * here. Reservations make `queueMax` a pre-consumption limit: a running task
   * already owns the space its result will need, so no result can be refused
   * after the task has run. They are process-local and never persisted.
   */
  reserved?: number;
  lastActivatedAt?: string;
  hover?: HoverSpec;
  /** The Pheromone parked behind `hover`; it is still part of the field. */
  hoverPheromone?: Pheromone;
  state?: Record<string, unknown>;
  /** Gather-only: partially complete gathers, keyed by spreadId. */
  gathers?: Map<string, GatherState>;
  /**
   * The Value produced by this bee's last completed activation. It is an
   * in-memory cache owned by the field (D2): it is never persisted, carries no
   * run identity, and is released with the field on unload.
   */
  lastOutput?: Value;
}

/** Immutable view returned by PheromoneRuntime.snapshot(). */
export interface NodeStateSnapshot {
  receptor: readonly Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  hover?: HoverSpec;
  lastActivatedAt?: string;
  state: Readonly<Record<string, unknown>>;
  gathers?: Readonly<Record<string, GatherStateSnapshot>>;
  /** Field-owned last completed output; memory-only and never persisted. */
  lastOutput?: Value;
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
export interface PersistedGatherState {
  /** Parent lineage restored by this join's Gather; absent at top level. */
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
  /**
   * The awake bee's waiting receptor, FIFO. A resting bee has no receptor, so
   * the key is omitted instead of writing an empty array (the same rule the
   * live NodeState uses). Restore treats a missing key as an empty receptor.
   * The per-bee last output is memory-only and is deliberately absent here.
   */
  receptor?: Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  hover?: HoverSpec;
  hoverPheromone?: Pheromone;
  lastActivatedAt?: string;
  state?: Record<string, unknown>;
  /** Gather-only: partial gathers keyed by spreadId. */
  gathers?: Record<string, PersistedGatherState>;
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
