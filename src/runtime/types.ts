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
  /**
   * Template rendered per activation. Placeholders are `{{dot.path}}`; the
   * parser rejects a placeholder that is not declared in `reads` or `fallback`.
   */
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

/** A condition evaluates one rule; the result selects the true/false edge. */
export interface ConditionConfig {
  when: Rule;
}

export interface CounterConfig {
  max: number;
  step: number;
}

/** Optional output gate applied to a raw reply before the `writes` check. */
export interface FilterConfig {
  /** When non-empty, only paths equal to or under an allow entry survive. */
  readonly allow: readonly string[];
  /** Removed after allow; deny wins on overlap. */
  readonly deny: readonly string[];
}

/**
 * Bee I/O shared by every kind. Built-in kinds seed `reads`/`writes`; an
 * instance may override either list. `fallback` supplies static values for
 * missing paths and may also declare prompt placeholder sources.
 */
export interface NodeBase {
  id: NodeId;
  minIntervalMs: number;
  /** Dot paths this Bee needs from the value. */
  readonly reads: readonly string[];
  /** Dot paths that must be present in the filtered reply. */
  readonly writes: readonly string[];
  /** Static values for missing read paths. */
  readonly fallback?: Readonly<Record<string, JsonValue>>;
  /** Optional output gate applied before the writes check. */
  readonly filter?: FilterConfig;
}

export interface ForagerNode extends NodeBase {
  kind: 'forager';
  config: ForagerConfig;
}

export interface WorkerNode extends NodeBase {
  kind: 'worker';
  config: WorkerConfig;
}

export interface ConditionNode extends NodeBase {
  kind: 'condition';
  config: ConditionConfig;
}

export interface CounterNode extends NodeBase {
  kind: 'counter';
  config: CounterConfig;
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

export interface UserNode extends NodeBase {
  kind: 'user';
  config: UserConfig;
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

export interface SpreadNode extends NodeBase {
  kind: 'spread';
  config: SpreadConfig;
}

export interface GatherNode extends NodeBase {
  kind: 'gather';
  config: GatherConfig;
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
