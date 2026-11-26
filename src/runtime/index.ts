export { parseComposition, CompositionValidationError } from './definition.js';
export { createMemoryLog } from './log.js';
export {
  FieldRestoreError,
  HoneyIncompatibleError,
  NotImplementedError,
  ValueDropOverlapError,
  ValuePathError,
} from './errors.js';
export { renderPrompt, serializeValue } from './executor.js';
export { assertJsonValue } from './json-value.js';
export { assertValue, isAttachment, readAttachments, assertUserValue } from './runtime-input.js';
export {
  applyDrop,
  applyWriteBack,
  assertNoDropOverlap,
  deepMerge,
  mergeInto,
} from './value-merge.js';
export {
  deletePath,
  getPath,
  isSubtreePath,
  isValidPath,
  parsePath,
  setPath,
} from './value-paths.js';
export {
  GuardDecisionError,
  PheromoneRuntime,
  QUEUE_RETRY_MS,
  ReceptorFullError,
} from './runtime.js';
export {
  DEFAULT_RECEPTOR_BLOCK_TIMEOUT_MS,
  ReceptorBlockTimeoutError,
  readReceptorOverflowOptions,
} from './receptor-overflow.js';
export type { ReceptorOverflowPolicy } from './receptor-overflow.js';
export {
  DEFAULT_WORKER_TIMEOUT_MS,
  MAX_WORKER_OUTPUT_BYTES,
  resolveWorkerCwd,
  runWorker,
  WorkerCwdError,
  WorkerExecutionError,
  workerExitError,
} from './worker.js';
export type { ExecutionContext, GuardDecision, GuardRequest, NodeExecutor } from './executor.js';
export type { RuntimeOptions } from './runtime.js';
export type { WorkerCwdErrorCode, WorkerFailureCode, WorkerResult } from './worker.js';
export type {
  AssembleGatherConfig,
  Attachment,
  BatchGatherConfig,
  CompositionDefaults,
  CompositionDefinition,
  ConditionConfig,
  ConditionWorkerConfig,
  CounterConfig,
  EdgeDefinition,
  EdgeWhen,
  ForagerConfig,
  ForagerNode,
  GroupKey,
  JsonType,
  Rule,
  SpreadCleaveConfig,
  SpreadCloneConfig,
  SpreadConfig,
  SpreadNode,
  GatherTypeConfig,
  GatherConfig,
  GatherNode,
  HoverSpec,
  JsonValue,
  NodeDefinition,
  NodeId,
  NodeKind,
  NodeState,
  NodeStateSnapshot,
  PersistedField,
  PersistedNodeState,
  Pheromone,
  PheromoneFieldSnapshot,
  QueueEntry,
  RecoveryReport,
  TriggerDefinition,
  TriggerSchedule,
  UserConfig,
  UserModality,
  UserNode,
  Value,
  WorkerConfig,
  WorkerNode,
} from './types.js';
export type { RuntimeEvent, RuntimeLogEntry, RuntimeLogFields, RuntimeLogSink } from './log.js';
