export { parseComposition, CompositionValidationError } from './definition.js';
export { createMemoryLog } from './log.js';
export { renderPrompt, serializeValue } from './executor.js';
export { FieldRestoreError, PheromoneRuntime } from './runtime.js';
export type { NodeExecutor } from './executor.js';
export type { RuntimeOptions } from './runtime.js';
export type {
  Attachment,
  CompositionDefaults,
  CompositionDefinition,
  ConditionConfig,
  CounterConfig,
  EdgeDefinition,
  EdgeWhen,
  ForagerConfig,
  ForagerNode,
  HoverSpec,
  NodeDefinition,
  NodeId,
  NodeKind,
  NodeState,
  NodeStateSnapshot,
  PersistedField,
  PersistedNodeState,
  Pheromone,
  PheromoneFieldSnapshot,
  RecoveryReport,
  UserConfig,
  UserModality,
  UserNode,
  Value,
} from './types.js';
export type { RuntimeEvent, RuntimeLogEntry, RuntimeLogSink } from './log.js';
