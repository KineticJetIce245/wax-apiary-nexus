import type { ForagerBinding, GraphBindings } from '../graph/binding.js';
import type { LiveHiveHost, LiveHiveStatus } from '../daemon/graph-host.js';
import type { Project } from '../project/kernel.js';
import type { Value } from '../runtime/index.js';
import type { SessionRegistry } from '../session/session-registry.js';
import { DispatchService } from './dispatch-service.js';
import type { HiveTemplate, LiveHive, SessionParams } from './types.js';
import { LiveHiveReadService } from './live-hive-read.js';
import { LiveHiveRepository } from './live-hive-repository.js';
import { toCompositionDefinition } from './live-hive-codec.js';
import { LiveHiveServiceError } from './live-hive-service-errors.js';

export {
  LiveHiveNotFoundError,
  LiveHiveServiceError,
} from './live-hive-service-errors.js';

export interface LiveHiveServiceOptions {
  readonly liveHiveHost: LiveHiveHost;
  readonly registry: SessionRegistry;
  readonly livesRoot: string;
  readonly templateStore?: import('./hive-template.js').HiveTemplateStore;
  readonly defaultProject?: Project;
  readonly dispatchService?: DispatchService;
  readonly defaultHarness?: string;
}

export interface LiveHiveOperationResult {
  readonly liveId: string;
  readonly status: LiveHiveStatus;
}

export type {
  LiveHiveInspectResult,
  LiveHiveOutputResult,
  LiveHiveSummary,
} from './live-hive-read.js';

/** Per-bee session defaults for template instantiation. */
export type LiveHiveOverrides = Readonly<Record<string, SessionParams>>;

/**
 * The B operation layer over LiveHiveHost. Topology and explicit session bindings
 * live in live.json; LiveHiveHost owns the runtime and Honey lifecycle.
 */
export class LiveHiveService {
  private readonly repository: LiveHiveRepository;
  private readonly defaultProject: Project | undefined;
  readonly dispatchService: DispatchService;
  private readonly defaultHarness: string | undefined;
  readonly read: LiveHiveReadService;

  constructor(private readonly options: LiveHiveServiceOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('LiveHiveService options are required');
    }
    this.repository = new LiveHiveRepository(options.livesRoot, options.templateStore);
    this.defaultProject = options.defaultProject;
    this.defaultHarness = options.defaultHarness;
    this.read = new LiveHiveReadService(options.liveHiveHost, this.repository);
    this.dispatchService =
      options.dispatchService ??
      new DispatchService({
        registry: options.registry,
        liveHiveHost: options.liveHiveHost,
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
    const defaults = gatherDefaults(template, overrides);
    const live: LiveHive = {
      schemaVersion: 1,
      liveId: id,
      bees: template.hive.bees,
      beelines: template.hive.beelines,
      bindings: {},
      ...(template.schedules === undefined ? {} : { schedules: template.schedules }),
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

  /**
   * Deliver one Pheromone to a bee. The call only hands the input to the field
   * and resolves; execution continues in the background. A session shared with
   * other LiveHives is serialized by the harness adapter, not by this method.
   */
  async trigger(liveId: string, beeId: string, input: string): Promise<void> {
    this.repository.requireLiveId(liveId);
    await this.options.liveHiveHost.trigger(liveId, beeId, textValue(input));
  }

  async answer(
    liveId: string,
    beeId: string,
    input: string,
    token?: string,
  ): Promise<void> {
    this.repository.requireLiveId(liveId);
    await this.options.liveHiveHost.answer(liveId, beeId, textValue(input), token);
  }

  /** Flush Honey/scheduler and write live.json without releasing the graph. */
  async save(liveId: string): Promise<LiveHiveStatus> {
    const id = this.repository.requireLiveId(liveId);
    const live = this.repository.cacheGet(id) ?? this.repository.readLive(
      this.repository.pathFor(id),
      id,
    );
    const status = await this.options.liveHiveHost.save(id);
    this.syncBindings(live);
    return status;
  }

  /** LiveHiveHost unload (which flushes Honey), then write live.json. */
  async unload(liveId: string): Promise<boolean> {
    const id = this.repository.requireLiveId(liveId);
    const live = this.repository.cacheGet(id) ?? this.repository.tryReadLive(id);
    const synced = live === undefined ? undefined : this.syncBindings(live);
    const unloaded = await this.options.liveHiveHost.unload(id);
    if (unloaded && synced !== undefined) {
      this.repository.saveLive(synced);
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

  /**
   * Explicit structural replacement: unload, write the new live, load again.
   * There is no LiveHive copy command and no revision/CAS.
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
    const unloaded = await this.options.liveHiveHost.unload(id);
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

  private async start(
    live: LiveHive,
    project?: Project,
    defaults?: LiveHiveOverrides,
    restoreHoney?: boolean,
  ): Promise<LiveHiveStatus> {
    const resolvedProject = resolveProject(
      live,
      project,
      this.defaultProject,
      this.options.registry,
    );
    const definition = toCompositionDefinition(live);
    const status = await this.options.liveHiveHost.loadGraph({
      definition,
      bindings: bindingsFor(live, defaults),
      project: resolvedProject,
      ...(this.defaultHarness === undefined ? {} : { defaultHarness: this.defaultHarness }),
      ...(restoreHoney === undefined ? {} : { restoreHoney }),
    });
    // live.json is the binding truth: persist the sessions LiveHiveHost actually
    // created/attached for this topology.
    this.syncBindings(live);
    return status;
  }

  /** Combine the loaded bee -> session mapping into live.json. */
  private syncBindings(live: LiveHive): LiveHive {
    const loaded = this.options.liveHiveHost.bindingsOf(live.liveId);
    const bindings: Record<string, string> = {};
    for (const [beeId, bee] of Object.entries(live.bees)) {
      if (bee.kind !== 'forager') {
        continue;
      }
      const sessionId = loaded.get(beeId) ?? live.bindings[beeId];
      if (sessionId !== undefined) {
        bindings[beeId] = sessionId;
      }
    }
    const next = this.repository.parseLive({ ...live, bindings });
    this.repository.saveLive(next);
    this.repository.cacheSet(next);
    return next;
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
    const connection = bee.config['connection'];
    const inferred =
      connection === 'codex' || connection === 'dsh' ? connection : undefined;
    const harness = params.harness ?? inferred;
    bindings[beeId] = {
      kind: 'fresh',
      ...(mode === 'fresh_once' ? { mode: 'once' } : {}),
      ...(harness === undefined ? {} : { harness }),
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

function gatherDefaults(
  template: HiveTemplate,
  overrides: LiveHiveOverrides,
): LiveHiveOverrides {
  if (typeof overrides !== 'object' || overrides === null) {
    throw new LiveHiveServiceError('invalid', 'overrides must be an object');
  }
  const gatherd: Record<string, SessionParams> = {};
  for (const beeId of Object.keys(template.hive.bees)) {
    gatherd[beeId] = { ...(template.defaults[beeId] ?? {}), ...(overrides[beeId] ?? {}) };
  }
  return gatherd;
}

function textValue(input: string): Value {
  if (typeof input !== 'string') {
    throw new LiveHiveServiceError('invalid', 'input must be a string');
  }
  return { kind: 'text', text: input };
}
