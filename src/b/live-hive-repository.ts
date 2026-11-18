import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { expandHomePath } from '../storage/conversation-store.js';
import { HiveTemplateStore } from './hive-template.js';
import { LiveHiveStore } from './live-hive.js';
import type { HiveTemplate, LiveHive } from './types.js';
import { BObjectValidationError, parseHiveTemplate, parseLiveHive } from './validation.js';
import { LiveHiveServiceError } from './live-hive-service-errors.js';

const MAX_LIVE_ID_LENGTH = 128;

/** Filesystem/cache adapter for LiveHiveService; no GraphHost dependency. */
export class LiveHiveRepository {
  private readonly livesRoot: string;
  private readonly templateStore: HiveTemplateStore | undefined;
  private readonly cache = new Map<string, LiveHive>();

  constructor(livesRoot: string, templateStore?: HiveTemplateStore) {
    if (typeof livesRoot !== 'string' || livesRoot.length === 0) {
      throw new TypeError('LiveHiveRepository livesRoot must be a non-empty string');
    }
    this.livesRoot = resolve(expandHomePath(livesRoot));
    this.templateStore = templateStore;
  }

  requireLiveId(value: string): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_LIVE_ID_LENGTH ||
      value === '.' ||
      value === '..' ||
      /[\\/\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new LiveHiveServiceError('invalid', 'invalid liveId');
    }
    return value;
  }

  pathFor(liveId: string): string {
    return join(this.livesRoot, liveId, 'live.json');
  }

  resolvePath(input: string): string {
    const expanded = resolve(expandHomePath(input));
    return expanded.endsWith('.json') ? expanded : join(expanded, 'live.json');
  }

  cacheGet(liveId: string): LiveHive | undefined {
    return this.cache.get(liveId);
  }

  cacheSet(live: LiveHive): void {
    this.cache.set(live.liveId, live);
  }

  cacheDelete(liveId: string): void {
    this.cache.delete(liveId);
  }

  cached(liveId: string): boolean {
    return this.cache.has(liveId);
  }

  parseLive(value: unknown): LiveHive {
    try {
      return parseLiveHive(value);
    } catch (error) {
      if (error instanceof BObjectValidationError) {
        throw new LiveHiveServiceError('invalid', 'invalid live hive', { cause: error });
      }
      throw error;
    }
  }

  parseTemplate(value: unknown): HiveTemplate {
    try {
      return parseHiveTemplate(value);
    } catch (error) {
      if (error instanceof BObjectValidationError) {
        throw new LiveHiveServiceError('invalid', 'invalid hive template', { cause: error });
      }
      throw error;
    }
  }

  saveLive(live: LiveHive, path = this.pathFor(this.requireLiveId(live.liveId))): void {
    mkdirSync(dirname(path), { recursive: true });
    new LiveHiveStore(path).save(live);
  }

  readLive(path: string, expectedId: string): LiveHive {
    const store = new LiveHiveStore(path);
    if (!store.exists()) {
      throw new LiveHiveServiceError('not-found', `live hive is not loaded: ${expectedId}`);
    }
    let live: LiveHive;
    try {
      live = store.load();
    } catch (error) {
      throw new LiveHiveServiceError('invalid', 'live hive could not be loaded', {
        cause: error,
      });
    }
    if (live.liveId !== expectedId) {
      throw new LiveHiveServiceError('invalid', 'liveId does not match live.json');
    }
    return live;
  }

  tryReadLive(liveId: string): LiveHive | undefined {
    const path = this.pathFor(liveId);
    const store = new LiveHiveStore(path);
    return store.exists() ? store.load() : undefined;
  }

  /** Directory ids with a live.json; malformed names are ignored. */
  listLiveIds(): string[] {
    let names: readonly string[];
    try {
      names = readdirSync(this.livesRoot);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const name of names) {
      try {
        this.requireLiveId(name);
      } catch {
        continue;
      }
      const path = join(this.livesRoot, name, 'live.json');
      if (existsSync(path)) {
        ids.push(name);
      }
    }
    return ids;
  }

  loadTemplate(templateId: string): HiveTemplate {
    if (this.templateStore === undefined) {
      throw new LiveHiveServiceError('unsupported', 'template store is not configured');
    }
    try {
      return this.parseTemplate(this.templateStore.load(templateId));
    } catch (error) {
      if (error instanceof LiveHiveServiceError) {
        throw error;
      }
      throw new LiveHiveServiceError('not-found', 'hive template is not available', {
        cause: error,
      });
    }
  }

  saveTemplate(template: HiveTemplate): HiveTemplate {
    if (this.templateStore === undefined) {
      throw new LiveHiveServiceError('unsupported', 'template store is not configured');
    }
    const parsed = this.parseTemplate(template);
    try {
      this.templateStore.save(parsed);
    } catch (error) {
      throw new LiveHiveServiceError('invalid', 'hive template could not be saved', {
        cause: error,
      });
    }
    return parsed;
  }

  listTemplates(): readonly HiveTemplate[] {
    if (this.templateStore === undefined) {
      return [];
    }
    try {
      return this.templateStore.list();
    } catch (error) {
      throw new LiveHiveServiceError('invalid', 'hive templates could not be listed', {
        cause: error,
      });
    }
  }
}
