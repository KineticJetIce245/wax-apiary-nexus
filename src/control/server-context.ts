import { join, resolve } from 'node:path';

import type { Server } from 'node:http';

import { DaemonLock } from '../daemon/daemon-lock.js';
import { GraphHost } from '../daemon/graph-host.js';
import type { SessionRegistry, SweepSessionsReport } from '../session/session-registry.js';
import { expandHomePath } from '../storage/conversation-store.js';
import { HoneyStore } from '../storage/honey.js';
import { RunStore } from '../storage/run-store.js';
import type { SweepReport } from '../graph/registry.js';
import type { LiveHiveService } from '../b/live-hive-service.js';
import { DEFAULT_GUARD_TIMEOUT_MS, GuardBroker } from './guard-broker.js';
import {
  DEFAULT_DAEMON_DIR,
  DEFAULT_GRAPH_SWEEP_INTERVAL_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_SESSION_SWEEP_INTERVAL_MS,
  LOOPBACK_HOST,
  MAX_TOKEN_LENGTH,
} from './server-constants.js';
import type { ControlServerInfo, ControlServerOptions } from './server-types.js';
import { HttpError } from './server-types.js';
import {
  requireConfigString,
  validateMaxBodyBytes,
  validateNonNegativeInteger,
  validatePort,
  validatePositiveInteger,
} from './validation.js';

/** Shared immutable configuration and the host's mutable runtime state. */
export class ControlServerContext {
  readonly options: ControlServerOptions;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly daemonDir: string;
  readonly tokenPath: string;
  readonly infoPath: string;
  readonly lockPath: string;
  readonly now: () => number;
  readonly logger: (line: string) => void;
  readonly honeyForGraph: (graphId: string) => HoneyStore;
  readonly configuredToken: string | undefined;
  readonly sessionIdleTtlMs: number;
  readonly sessionSweepIntervalMs: number;
  readonly graphSweepIntervalMs: number;
  readonly guardTimeoutMs: number;

  state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
  server: Server | undefined;
  lock: DaemonLock | undefined;
  graphHost: GraphHost | undefined;
  liveHiveService: LiveHiveService | undefined;
  runStore: RunStore | undefined;
  guardBroker: GuardBroker | undefined;
  tokenValue: string | undefined;
  currentInfo: ControlServerInfo | undefined;
  startPromise: Promise<ControlServerInfo> | undefined;
  stopPromise: Promise<void> | undefined;
  sweepTimer: NodeJS.Timeout | undefined;
  graphSweepTimer: NodeJS.Timeout | undefined;
  sweepingSessions = false;
  sweepingGraphs = false;

  constructor(options: ControlServerOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('ControlServer options are required');
    }
    if (typeof options.registry !== 'object' || options.registry === null) {
      throw new TypeError('ControlServer requires a session registry');
    }
    this.options = options;

    requireConfigString(options.apiary, 'apiary', 128);
    requireConfigString(options.stateRoot, 'stateRoot', 4_096);

    // Reject anything else before a socket or file is ever created. There is
    // deliberately no fallback to 0.0.0.0 or a hostname lookup.
    const host = options.host ?? LOOPBACK_HOST;
    if (host !== LOOPBACK_HOST) {
      throw new Error(
        `control server only binds ${LOOPBACK_HOST}; refusing host '${String(host)}'`,
      );
    }
    this.host = LOOPBACK_HOST;

    this.port = validatePort(options.port ?? 0);
    this.maxBodyBytes = validateMaxBodyBytes(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);

    const daemonDirInput =
      options.daemonDir === undefined
        ? DEFAULT_DAEMON_DIR
        : requireConfigString(options.daemonDir, 'daemonDir', 4_096);
    this.daemonDir = resolve(expandHomePath(daemonDirInput));

    const tokenPathInput =
      options.tokenPath === undefined
        ? join(this.daemonDir, 'token')
        : requireConfigString(options.tokenPath, 'tokenPath', 4_096);
    const infoPathInput =
      options.infoPath === undefined
        ? join(this.daemonDir, 'server.json')
        : requireConfigString(options.infoPath, 'infoPath', 4_096);
    const lockPathInput =
      options.lockPath === undefined
        ? join(this.daemonDir, 'daemon.lock')
        : requireConfigString(options.lockPath, 'lockPath', 4_096);

    this.tokenPath = resolve(expandHomePath(tokenPathInput));
    this.infoPath = resolve(expandHomePath(infoPathInput));
    this.lockPath = resolve(expandHomePath(lockPathInput));
    if (new Set([this.tokenPath, this.infoPath, this.lockPath]).size !== 3) {
      throw new Error('tokenPath, infoPath and lockPath must be distinct');
    }

    this.now = options.now ?? (() => Date.now());
    if (typeof this.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.logger = options.logger ?? (() => undefined);
    if (typeof this.logger !== 'function') {
      throw new TypeError('logger must be a function');
    }
    if (options.honeyForGraph !== undefined && typeof options.honeyForGraph !== 'function') {
      throw new TypeError('honeyForGraph must be a function');
    }
    if (
      options.allowHoverUnload !== undefined &&
      typeof options.allowHoverUnload !== 'boolean'
    ) {
      throw new TypeError('allowHoverUnload must be a boolean');
    }
    this.honeyForGraph =
      options.honeyForGraph ??
      ((graphId: string) => HoneyStore.forComposition(options.stateRoot, options.apiary, graphId));

    this.sessionIdleTtlMs = validateNonNegativeInteger(
      options.sessionIdleTtlMs ?? 0,
      'sessionIdleTtlMs',
    );
    this.sessionSweepIntervalMs = validateNonNegativeInteger(
      options.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS,
      'sessionSweepIntervalMs',
    );
    if (this.sessionIdleTtlMs > 0 && this.sessionSweepIntervalMs <= 0) {
      throw new TypeError(
        'sessionSweepIntervalMs must be positive when sessionIdleTtlMs is enabled',
      );
    }
    this.graphSweepIntervalMs = validateNonNegativeInteger(
      options.graphSweepIntervalMs ?? DEFAULT_GRAPH_SWEEP_INTERVAL_MS,
      'graphSweepIntervalMs',
    );
    this.guardTimeoutMs = validatePositiveInteger(
      options.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS,
      'guardTimeoutMs',
    );

    if (options.token !== undefined) {
      if (
        typeof options.token !== 'string' ||
        options.token.length === 0 ||
        options.token.length > MAX_TOKEN_LENGTH ||
        /\s/.test(options.token)
      ) {
        throw new TypeError('token must be a non-empty string without whitespace');
      }
      this.configuredToken = options.token;
    }
  }

  get registry(): SessionRegistry {
    return this.options.registry;
  }

  requireGraphHost(): GraphHost {
    const host = this.graphHost;
    if (host === undefined) {
      throw new HttpError(500, 'internal', 'internal error');
    }
    return host;
  }

  requireLiveHiveService(): LiveHiveService {
    const service = this.liveHiveService;
    if (service === undefined) {
      throw new HttpError(500, 'internal', 'internal error');
    }
    return service;
  }

  /** One idle-session pass, shared by `POST /sessions/sweep` and the timer. */
  sweepIdleSessions(): Promise<SweepSessionsReport> {
    const host = this.requireGraphHost();
    return this.registry.sweepIdle({
      idleTtlMs: this.sessionIdleTtlMs,
      exclude: host.loadedSessionIds(),
    });
  }

  /** One graph TTL pass shared by `POST /sweep` and the automatic timer. */
  sweepGraphs(): Promise<SweepReport> {
    return this.requireGraphHost().sweep();
  }
}
