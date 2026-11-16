import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteJson } from '../storage/atomic-write.js';
import { BObjectValidationError, parseLiveHive } from './validation.js';
import type { BeeBinding, LiveHive } from './types.js';

export type { Bee, BeeBinding, Beeline, LiveHive, SessionMode } from './types.js';

export class LiveHiveStoreError extends Error {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LiveHiveStoreError';
  }
}

/**
 * One `live.json` document. `bees` and `bindings` are keyed by beeId and
 * `beelines` by beelineId; there is no separate binding file.
 */
export class LiveHiveStore {
  constructor(readonly path: string) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('LiveHiveStore path must be a non-empty string');
    }
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /** Missing, unreadable, malformed and structurally invalid files all fail. */
  load(): LiveHive {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new LiveHiveStoreError(this.path, `cannot read live hive: ${this.path}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new LiveHiveStoreError(this.path, `live hive is not valid JSON: ${this.path}`, {
        cause: error,
      });
    }

    try {
      return parseLiveHive(parsed);
    } catch (error) {
      if (error instanceof BObjectValidationError) {
        throw new LiveHiveStoreError(this.path, `live hive is invalid: ${this.path}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /** Overwrite the whole document through the existing atomic writer. */
  save(live: LiveHive): void {
    parseLiveHive(live);
    atomicWriteJson(this.path, live);
  }

  /** A single-document store's list is empty or one hive. */
  list(): readonly LiveHive[] {
    return this.exists() ? [this.load()] : [];
  }
}

/** Replace one bee's binding without mutating the input hive. */
export function bindBee(live: LiveHive, beeId: string, sessionId: string): LiveHive {
  const next: LiveHive = {
    ...live,
    bindings: { ...live.bindings, [beeId]: sessionId },
  };
  return parseLiveHive(next);
}

/** Remove one bee's binding; an absent bee is a no-op. */
export function unbindBee(live: LiveHive, beeId: string): LiveHive {
  if (!Object.hasOwn(live.bindings, beeId)) {
    return live;
  }
  const bindings = { ...live.bindings };
  delete bindings[beeId];
  return parseLiveHive({ ...live, bindings });
}

/** Derive the BeeBinding view from the single source of truth. */
export function bindingsOf(live: LiveHive): readonly BeeBinding[] {
  return Object.entries(live.bindings).map(([beeId, sessionId]) => ({
    beeId,
    sessionId,
  }));
}
