/**
 * Core value and graph types for the PheromoneField runtime.
 *
 * M19 target model (ARCHITECTURE.md §3/§4.12/§4.13): a Value is a free JSON
 * object, a Pheromone is `{ value }`, and the field's queue entry owns
 * `enqueuedAt`. There is no message identity, no lineage and no branch/join.
 */

export type NodeId = string;

/** A local file reference carried by the universal `attachments` convention. */
export interface Attachment {
  path: string;
  /** Optional and not an enum; image/audio are inferred from the prefix. */
  mediaType?: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A Value is a free JSON object: `message` is the universal text field,
 * `attachments` the file convention, and every other field is arbitrary JSON.
 * A plain `null` may appear as a field value but the root is always an object.
 */
export type Value = { [key: string]: JsonValue };

/** The only thing a Pheromone carries. No id, timestamp or lineage. */
export interface Pheromone {
  value: Value;
}

/**
 * One receptor slot: the same Pheromone object plus its queue instant. The
 * field moves this object by reference along a normal beeline; only cardinality
 * changes (spread/gather) create new Pheromones.
 */
export interface QueueEntry extends Pheromone {
  enqueuedAt: string;
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
 * The manual answer modalities. The answer maps to ordinary Value fields:
 * text/message -> `message`, choice -> `choice`, yes-no -> `boolean`,
 * image/file -> `attachments`.
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

/**
 * A rule is declarative (one dot path plus an operator) or a local code block.
 * M19b implements evaluation; M19a only parses and carries the shape.
 */
export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export type Rule =
  | { code: string }
  | { path: string; equals: JsonValue }
  | { path: string; oneOf: readonly JsonValue[] }
  | { path: string; exists: true }
  | { path: string; type: JsonType };

/** A group key is a dot path or a code block returning a non-empty string. */
export type GroupKey = string | { code: string };

/** `clone` targets are BeeIds, as an ordered list or a map keyed by BeeId. */
export interface SpreadCloneConfig {
  strategy: 'clone';
  targets: readonly NodeId[] | Readonly<Record<NodeId, JsonValue>>;
}

/** `cleave` projects the listed dot paths into each target's part. */
export interface SpreadCleaveConfig {
  strategy: 'cleave';
  targets: Readonly<Record<NodeId, readonly string[]>>;
}

export type SpreadConfig = SpreadCloneConfig | SpreadCleaveConfig;

export interface GatherTypeConfig {
  match: Rule;
  /** Positive integer; always 1 for batch. */
  count: number;
  /** Dot paths projected into a package entry. */
  reads: readonly string[];
}

/** `assemble` waits until every declared type reaches its count. */
export interface AssembleGatherConfig {
  strategy: 'assemble';
  types: Readonly<Record<string, GatherTypeConfig>>;
  groupBy?: GroupKey;
  /** Defaults to 256; M19d enforces it. */
  typeQueueMax: number;
}

/** `batch` accumulates until one input matches `batch.signal`. */
export interface BatchGatherConfig {
  strategy: 'batch';
  batch: { signal: Rule };
  types: Readonly<Record<string, GatherTypeConfig>>;
  typeQueueMax: number;
}

export type GatherConfig = AssembleGatherConfig | BatchGatherConfig;

export interface SpreadNode {
  id: NodeId;
  kind: 'spread';
  config: SpreadConfig;
  minIntervalMs: number;
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
 * It has no Pheromone id: the parked Pheromone is the field's state.
 */
export interface HoverSpec {
  token: string;
  kind: 'user' | 'forager' | 'guard' | 'timer';
  compositionId: string;
  nodeId: NodeId;
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
 * A scheduled trigger. Supports one-shot `at` and fixed-interval `every`; a
 * manual trigger is a CLI action and is never stored in the file.
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

/** Mutable per-node runtime state. Never handed out directly. */
export interface NodeState {
  /**
   * The bee's receptor: queue entries waiting to be activated, in FIFO order.
   * It exists only while the bee is awake; the drain removes it when the
   * receptor is empty and no pending activation is held.
   */
  receptor?: QueueEntry[];
  pending?: Pheromone;
  active?: Pheromone;
  /**
   * Output slots reserved by an in-flight activation that is about to enqueue
   * here. Reservations make `queueMax` a pre-consumption limit. They are
   * process-local and never persisted.
   */
  reserved?: number;
  lastActivatedAt?: string;
  hover?: HoverSpec;
  /** The Pheromone parked behind `hover`; it is still part of the field. */
  hoverPheromone?: Pheromone;
  state?: Record<string, unknown>;
  /**
   * The Value produced by this bee's last completed activation. It is an
   * in-memory cache owned by the field: never persisted, no run identity, and
   * released with the field on unload.
   */
  lastOutput?: Value;
}

/** Immutable view returned by PheromoneRuntime.snapshot(). */
export interface NodeStateSnapshot {
  receptor: readonly QueueEntry[];
  pending?: Pheromone;
  active?: Pheromone;
  hover?: HoverSpec;
  /** The Pheromone parked behind `hover`; field state, not persisted output. */
  hoverPheromone?: Pheromone;
  lastActivatedAt?: string;
  state: Readonly<Record<string, unknown>>;
  /** Field-owned last completed output; memory-only and never persisted. */
  lastOutput?: Value;
}

export interface PheromoneFieldSnapshot {
  schemaVersion: 2;
  compositionId: string;
  graphRevision: string;
  rest: boolean;
  nodes: Readonly<Record<NodeId, NodeStateSnapshot>>;
}

/** JSON shape of `honey/field.json`. */
export interface PersistedNodeState {
  /**
   * Queue entries as persisted. A resting bee omits the key instead of writing
   * an empty array. The per-bee last output is memory-only and absent here.
   */
  receptor?: QueueEntry[];
  pending?: Pheromone;
  active?: Pheromone;
  hover?: HoverSpec;
  hoverPheromone?: Pheromone;
  lastActivatedAt?: string;
  state?: Record<string, unknown>;
}

export interface PersistedField {
  schemaVersion: 2;
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
