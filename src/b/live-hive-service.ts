import type { ForagerBinding, GraphBindings } from '../graph/binding.js';
import type { GraphHost, GraphRunResult, GraphStatus } from '../daemon/graph-host.js';
import type { LiveHiveCatalogEntry } from '../daemon/live-hive-catalog.js';
import type { Project } from '../project/kernel.js';
import type { Value } from '../runtime/index.js';
import type { SessionRegistry } from '../session/session-registry.js';
import { DispatchService, type DispatchOptions, type DispatchResult } from './dispatch-service.js';
import type { HiveTemplate, LiveHive, SessionParams } from './types.js';
import { LiveHiveRepository } from './live-hive-repository.js';
import { toCompositionDefinition } from './live-hive-codec.js';
import { LiveHiveServiceError } from './live-hive-service-errors.js';

export {
  LiveHiveNotFoundError,
  LiveHiveServiceError,
} from './live-hive-service-errors.js';

export interface LiveHiveServiceOptions {
  readonly graphHost: GraphHost;
  readonly registry: SessionRegistry;
  readonly livesRoot: string;
  readonly templateStore?: import('./hive-template.js').HiveTemplateStore;
  readonly defaultProject?: Project;
  readonly dispatchService?: DispatchService;
  readonly defaultHarness?: string;
}

export interface LiveHiveOperationResult {
  readonly liveId: string;
  readonly status: GraphStatus;
}

export interface LiveHiveInspectResult {
  readonly liveId: string;
  readonly status?: GraphStatus;
  readonly outputs: readonly { readonly nodeId: string; readonly value: unknown }[];
  readonly catalog?: LiveHiveCatalogEntry;
}

/** Per-bee session defaults for template instantiation. */
export type LiveHiveOverrides = Readonly<Record<string, SessionParams>>;

/**
 * The B operation layer over GraphHost. Topology and explicit session bindings
 * live in live.json; GraphHost owns the runtime and Honey lifecycle.
 */
export class LiveHiveService {
  private readonly repository: LiveHiveRepository;
  private readonly defaultProject: Project | undefined;
  private readonly dispatchService: DispatchService;
  private readonly defaultHarness: string | undefined;

  constructor(private readonly options: LiveHiveServiceOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('LiveHiveService options are required');
    }
    this.repository = new LiveHiveRepository(options.livesRoot, options.templateStore);
    this.defaultProject = options.defaultProject;
    this.defaultHarness = options.defaultHarness;
    this.dispatchService =
      options.dispatchService ??
      new DispatchService({
        registry: options.registry,
        ...(options.defaultProject === undefined
          ? {}
          : { defaultProject: options.defaultProject }),
      });
  }

  /** Create a new LiveHive from an inline object, then load it. */
  async new(live: LiveHive, project?: Project): Promise<LiveHiveOperationResult> {
    const parsed = this.repository.parseLive(live);
    this.repository.saveLive(parsed);
    this.repository.cacheSet(parsed);
    try {
      return { liveId: parsed.liveId, status: await this.start(parsed, project) };
    } catch (error) {
      this.repository.cacheDelete(parsed.liveId);
      throw error;
    }
  }

  /**
   * Load from the canonical live path, an explicit path, or an inline object.
   * An inline object is written to the canonical path first so the daemon has
   * one durable copy.
   */
  async load(
    liveId: string,
    source?: string | LiveHive,
    project?: Project,
  ): Promise<LiveHiveOperationResult> {
    const id = this.repository.requireLiveId(liveId);
    let live: LiveHive;
    if (typeof source === 'object' && source !== null) {
      live = this.repository.parseLive(source);
      if (live.liveId !== id) {
        throw new LiveHiveServiceError('invalid', 'liveId does not match the live object');
      }
      this.repository.saveLive(live);
    } else {
      const path = source === undefined
        ? this.repository.pathFor(id)
        : this.repository.resolvePath(source);
      live = this.repository.readLive(path, id);
    }
    this.repository.cacheSet(live);
    try {
      return { liveId: id, status: await this.start(live, project) };
    } catch (error) {
      this.repository.cacheDelete(id);
      throw error;
    }
  }

  /** Materialize a template with per-bee default overrides, then load it. */
  async instantiate(
    templateId: string,
    liveId: string,
    overrides: LiveHiveOverrides = {},
    project?: Project,
  ): Promise<LiveHiveOperationResult> {
    const template = this.repository.loadTemplate(templateId);
    const id = this.repository.requireLiveId(liveId);
    const defaults = mergeDefaults(template, overrides);
    const live: LiveHive = {
      schemaVersion: 1,
      liveId: id,
      bees: template.hive.bees,
      beelines: template.hive.beelines,
      bindings: {},
    };
    this.repository.saveLive(live);
    this.repository.cacheSet(live);
    try {
      return { liveId: id, status: await this.start(live, project, defaults) };
    } catch (error) {
      this.repository.cacheDelete(id);
      throw error;
    }
  }

  async wake(liveId: string, beeId: string, input: string): Promise<GraphRunResult> {
    this.repository.requireLiveId(liveId);
    return this.options.graphHost.trigger(liveId, beeId, textValue(input));
  }

  async answer(
    liveId: string,
    beeId: string,
    input: string,
    token?: string,
  ): Promise<GraphRunResult> {
    this.repository.requireLiveId(liveId);
    return this.options.graphHost.answer(liveId, beeId, textValue(input), token);
  }

  /** Flush Honey/scheduler and write live.json without releasing the graph. */
  async save(liveId: string): Promise<GraphStatus> {
    const id = this.repository.requireLiveId(liveId);
    const live = this.repository.cacheGet(id) ?? this.repository.readLive(
      this.repository.pathFor(id),
      id,
    );
    const status = await this.options.graphHost.save(id);
    this.repository.saveLive(live);
    return status;
  }

  /** GraphHost unload (which flushes Honey), then write live.json. */
  async unload(liveId: string): Promise<boolean> {
    const id = this.repository.requireLiveId(liveId);
    const live = this.repository.cacheGet(id) ?? this.repository.tryReadLive(id);
    const unloaded = await this.options.graphHost.unload(id);
    if (unloaded && live !== undefined) {
      this.repository.saveLive(live);
    }
    return unloaded;
  }

  /** Save a template; no live hive or session is created. */
  compose(template: HiveTemplate): HiveTemplate {
    return this.repository.saveTemplate(template);
  }

  listTemplates(): readonly HiveTemplate[] {
    return this.repository.listTemplates();
  }

  /** Read-only status/output/catalog; never touches residency. */
  inspect(liveId: string): LiveHiveInspectResult {
    const id = this.repository.requireLiveId(liveId);
    const status = this.options.graphHost.statusOf(id);
    const catalog = this.options.graphHost
      .catalogEntries()
      .find((entry) => entry.liveId === id);
    if (status === undefined && catalog === undefined && !this.repository.cached(id)) {
      throw new LiveHiveServiceError('not-found', `live hive is not loaded: ${id}`);
    }
    const outputs = [...this.options.graphHost.outputsOf(id).entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([nodeId, value]) => ({ nodeId, value }));
    return {
      liveId: id,
      ...(status === undefined ? {} : { status }),
      outputs,
      ...(catalog === undefined ? {} : { catalog }),
    };
  }

  /**
   * Explicit structural replacement: unload, write the new live, load again.
   * There is no fork command and no revision/CAS.
   */
  async migrate(
    liveId: string,
    nextHive: LiveHive,
    project?: Project,
  ): Promise<LiveHiveOperationResult> {
    const id = this.repository.requireLiveId(liveId);
    const next = this.repository.parseLive(nextHive);
    if (next.liveId !== id) {
      throw new LiveHiveServiceError('invalid', 'liveId does not match the migrated hive');
    }
    const previous = this.repository.cacheGet(id) ?? this.repository.tryReadLive(id);
    const previousRevision = previous === undefined
      ? undefined
      : toCompositionDefinition(previous).graphRevision;
    const unloaded = await this.options.graphHost.unload(id);
    if (!unloaded) {
      throw new LiveHiveServiceError('conflict', 'live hive is not unloadable');
    }
    try {
      this.repository.saveLive(next);
      this.repository.cacheSet(next);
      const restoreHoney = previousRevision === toCompositionDefinition(next).graphRevision;
      return { liveId: id, status: await this.start(next, project, undefined, restoreHoney) };
    } catch (error) {
      if (previous !== undefined) {
        this.repository.saveLive(previous);
        this.repository.cacheSet(previous);
      }
      throw error;
    }
  }

  async dispatch(input: string, options: DispatchOptions): Promise<DispatchResult> {
    return this.dispatchService.dispatch(input, options);
  }

  private async start(
    live: LiveHive,
    project?: Project,
    defaults?: LiveHiveOverrides,
    restoreHoney?: boolean,
  ): Promise<GraphStatus> {
    const resolvedProject = resolveProject(
      live,
      project,
      this.defaultProject,
      this.options.registry,
    );
    const definition = toCompositionDefinition(live);
    return this.options.graphHost.loadGraph({
      definition,
      bindings: bindingsFor(live, defaults),
      project: resolvedProject,
      ...(this.defaultHarness === undefined ? {} : { defaultHarness: this.defaultHarness }),
      ...(restoreHoney === undefined ? {} : { restoreHoney }),
    });
  }
}

function bindingsFor(live: LiveHive, defaults?: LiveHiveOverrides): GraphBindings {
  const bindings: Record<string, ForagerBinding> = {};
  for (const [beeId, bee] of Object.entries(live.bees)) {
    if (bee.kind !== 'forager') {
      continue;
    }
    const sessionId = live.bindings[beeId];
    if (sessionId !== undefined) {
      bindings[beeId] = { kind: 'session', sessionId };
      continue;
    }
    const mode = bee.sessionMode ?? 'always_fresh';
    if (mode === 'reuse') {
      throw new LiveHiveServiceError('conflict', `forager '${beeId}' has no session binding`);
    }
    const params = defaults?.[beeId] ?? {};
    bindings[beeId] = {
      kind: 'fresh',
      ...(mode === 'fresh_once' ? { mode: 'once' } : {}),
      ...(params.harness === undefined ? {} : { harness: params.harness }),
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
    };
  }
  return bindings;
}

function resolveProject(
  live: LiveHive,
  requested: Project | undefined,
  defaultProject: Project | undefined,
  registry: SessionRegistry,
): Project {
  const foragers = Object.entries(live.bees)
    .filter(([, bee]) => bee.kind === 'forager')
    .map(([beeId]) => beeId);
  const allBound =
    foragers.length > 0 && foragers.every((beeId) => live.bindings[beeId] !== undefined);
  // A fully explicit-session live derives its project from those records; a
  // caller-supplied default is only needed when a fresh session is possible.
  if (allBound) {
    for (const beeId of foragers) {
      const sessionId = live.bindings[beeId];
      const record = sessionId === undefined ? undefined : registry.get(sessionId);
      if (record !== undefined) {
        return { id: record.projectId, directory: record.projectDirectory };
      }
    }
  }
  if (requested !== undefined) {
    return requested;
  }
  if (defaultProject !== undefined) {
    return defaultProject;
  }
  for (const sessionId of Object.values(live.bindings)) {
    const record = registry.get(sessionId);
    if (record !== undefined) {
      return { id: record.projectId, directory: record.projectDirectory };
    }
  }
  throw new LiveHiveServiceError(
    'project',
    'live hive requires a project for fresh sessions',
  );
}

function mergeDefaults(
  template: HiveTemplate,
  overrides: LiveHiveOverrides,
): LiveHiveOverrides {
  if (typeof overrides !== 'object' || overrides === null) {
    throw new LiveHiveServiceError('invalid', 'overrides must be an object');
  }
  const merged: Record<string, SessionParams> = {};
  for (const beeId of Object.keys(template.hive.bees)) {
    merged[beeId] = { ...(template.defaults[beeId] ?? {}), ...(overrides[beeId] ?? {}) };
  }
  return merged;
}

function textValue(input: string): Value {
  if (typeof input !== 'string') {
    throw new LiveHiveServiceError('invalid', 'input must be a string');
  }
  return { kind: 'text', text: input };
}
