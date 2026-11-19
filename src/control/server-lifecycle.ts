import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';

import { DaemonLock } from '../daemon/daemon-lock.js';
import { GraphHost } from '../daemon/graph-host.js';
import { HiveTemplateStore } from '../b/hive-template.js';
import { LiveHiveService } from '../b/live-hive-service.js';
import { RunStore } from '../storage/run-store.js';
import { GuardBroker } from './guard-broker.js';
import {
  closeServer,
  listenOnLoopback,
  type ControlHttpServer,
} from './http-server.js';
import type { ControlServerContext } from './server-context.js';
import type { ControlServerInfo } from './server-types.js';

/** Start/stop, discovery files, host construction and both sweep timers. */
export class ControlServerLifecycle {
  constructor(
    private readonly context: ControlServerContext,
    private readonly http: ControlHttpServer,
  ) {}

  async start(): Promise<ControlServerInfo> {
    if (this.context.state === 'running' && this.context.currentInfo !== undefined) {
      return this.context.currentInfo;
    }
    if (this.context.startPromise !== undefined) {
      return this.context.startPromise;
    }
    if (this.context.state === 'stopping') {
      throw new Error('control server is stopping');
    }
    this.context.startPromise = this.startInternal().finally(() => {
      this.context.startPromise = undefined;
    });
    return this.context.startPromise;
  }

  /** Idempotent. Best-effort cleanup must not turn a stop into a rejection. */
  async stop(): Promise<void> {
    if (this.context.stopPromise !== undefined) {
      return this.context.stopPromise;
    }
    this.context.stopPromise = this.stopInternal().finally(() => {
      this.context.stopPromise = undefined;
    });
    return this.context.stopPromise;
  }

  info(): ControlServerInfo {
    if (this.context.currentInfo === undefined) {
      throw new Error('control server is not running');
    }
    return this.context.currentInfo;
  }

  private async startInternal(): Promise<ControlServerInfo> {
    const context = this.context;
    context.state = 'starting';
    const startedAt = new Date(context.now()).toISOString();
    let lock: DaemonLock | undefined;
    let server: Server | undefined;
    let graphHost: GraphHost | undefined;
    let runStore: RunStore | undefined;
    let guardBroker: GuardBroker | undefined;
    let tokenAttempted = false;
    let infoAttempted = false;

    try {
      ensurePrivateDirectory(context.daemonDir);
      ensureParentDirectory(context.tokenPath);
      ensureParentDirectory(context.infoPath);
      ensureParentDirectory(context.lockPath);

      // The lock is acquired before the token is written. A second server must
      // not overwrite the first server's live token before being refused.
      lock = DaemonLock.acquire(context.lockPath, context.options.apiary);

      const token = context.configuredToken ?? randomBytes(32).toString('hex');
      tokenAttempted = true;
      writeSecretFile(context.tokenPath, token);

      runStore = new RunStore(join(context.daemonDir, 'runs'));
      guardBroker = new GuardBroker({ timeoutMs: context.guardTimeoutMs });
      const broker = guardBroker;
      graphHost = new GraphHost({
        registry: context.registry,
        runStore,
        guardTimeoutMs: context.guardTimeoutMs,
        onGuard: (request) => broker.request(request),
        onGuardExpired: (requestId) => broker.expire(requestId),
        ...(context.options.catalog === undefined ? {} : { catalog: context.options.catalog }),
        ...(context.options.allowHoverUnload === undefined
          ? {}
          : { allowHoverUnload: context.options.allowHoverUnload }),
        ...(context.options.now === undefined ? {} : { now: context.options.now }),
        honeyForGraph: context.honeyForGraph,
        ...(context.options.bindingStore === undefined
          ? {}
          : { bindingStore: context.options.bindingStore }),
      });

      const liveHiveService = new LiveHiveService({
        graphHost,
        registry: context.registry,
        livesRoot: context.options.livesRoot ?? join(context.options.stateRoot, 'lives'),
        templateStore: new HiveTemplateStore(
          context.options.templatesRoot ?? join(context.options.stateRoot, 'templates'),
        ),
        ...(runStore === undefined ? {} : { runStore }),
        ...(context.options.liveProject === undefined
          ? {}
          : { defaultProject: context.options.liveProject }),
      });

      server = this.http.createServer();
      await listenOnLoopback(server, context.port, context.host);

      const address = server.address();
      if (
        address === null ||
        typeof address === 'string' ||
        address.address !== context.host ||
        address.family !== 'IPv4'
      ) {
        throw new Error(`control server is not bound to ${context.host}`);
      }

      const info: ControlServerInfo = {
        url: `http://${context.host}:${String(address.port)}`,
        host: context.host,
        port: address.port,
        pid: process.pid,
        startedAt,
        tokenPath: context.tokenPath,
        infoPath: context.infoPath,
      };

      infoAttempted = true;
      writeSecretFile(
        context.infoPath,
        `${JSON.stringify(
          {
            url: info.url,
            host: info.host,
            port: info.port,
            pid: info.pid,
            startedAt: info.startedAt,
            tokenPath: info.tokenPath,
          },
          null,
          2,
        )}\n`,
      );

      context.server = server;
      context.lock = lock;
      context.graphHost = graphHost;
      context.liveHiveService = liveHiveService;
      context.runStore = runStore;
      context.guardBroker = guardBroker;
      context.tokenValue = token;
      context.currentInfo = info;
      context.state = 'running';
      startSessionSweep(context);
      startGraphSweep(context);
      return info;
    } catch (error) {
      stopSessionSweep(context);
      stopGraphSweep(context);
      guardBroker?.cancelAll();
      guardBroker = undefined;
      await closeServer(server).catch(() => undefined);
      if (graphHost !== undefined) {
        await graphHost.dispose().catch(() => undefined);
      }
      if (tokenAttempted) {
        safeRemoveFile(context.tokenPath);
      }
      if (infoAttempted) {
        safeRemoveFile(context.infoPath);
      }
      try {
        lock?.release();
      } catch {
        // Best effort. A leaked lock is stale after this process exits.
      }
      context.server = undefined;
      context.lock = undefined;
      context.graphHost = undefined;
      context.liveHiveService = undefined;
      context.guardBroker = undefined;
      context.runStore = undefined;
      context.tokenValue = undefined;
      context.currentInfo = undefined;
      context.state = 'idle';
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    const context = this.context;
    if (context.startPromise !== undefined) {
      try {
        await context.startPromise;
      } catch {
        return;
      }
    }

    const server = context.server;
    const graphHost = context.graphHost;
    const lock = context.lock;
    const guardBroker = context.guardBroker;
    const hadResources = server !== undefined || graphHost !== undefined || lock !== undefined;

    stopSessionSweep(context);
    stopGraphSweep(context);
    guardBroker?.cancelAll();
    context.state = 'stopping';
    context.server = undefined;
    context.graphHost = undefined;
    context.liveHiveService = undefined;
    context.guardBroker = undefined;
    context.runStore = undefined;
    context.lock = undefined;
    context.tokenValue = undefined;
    context.currentInfo = undefined;

    if (!hadResources) {
      context.state = 'idle';
      return;
    }

    await closeServer(server).catch(() => undefined);
    if (graphHost !== undefined) {
      await graphHost.dispose().catch(() => undefined);
    }

    // Remove discovery material while the lock still excludes a new server.
    safeRemoveFile(context.tokenPath);
    safeRemoveFile(context.infoPath);
    try {
      lock?.release();
    } catch {
      // Best effort; an unreleased lock becomes stale with this PID.
    }
    context.state = 'idle';
  }

}

function startSessionSweep(context: ControlServerContext): void {
  if (context.sessionIdleTtlMs <= 0 || context.sessionSweepIntervalMs <= 0) {
    return;
  }
  const timer = setInterval(() => {
    void runAutomaticSessionSweep(context);
  }, context.sessionSweepIntervalMs);
  timer.unref();
  context.sweepTimer = timer;
}

function stopSessionSweep(context: ControlServerContext): void {
  const timer = context.sweepTimer;
  context.sweepTimer = undefined;
  if (timer !== undefined) {
    clearInterval(timer);
  }
}

async function runAutomaticSessionSweep(context: ControlServerContext): Promise<void> {
  if (context.sweepingSessions) {
    return;
  }
  context.sweepingSessions = true;
  try {
    await context.sweepIdleSessions();
  } catch (error) {
    context.logger(`event=session-sweep-failed error=${errorName(error)}`);
  } finally {
    context.sweepingSessions = false;
  }
}

function startGraphSweep(context: ControlServerContext): void {
  if (context.graphSweepIntervalMs <= 0) {
    return;
  }
  const timer = setInterval(() => {
    void runAutomaticGraphSweep(context);
  }, context.graphSweepIntervalMs);
  timer.unref();
  context.graphSweepTimer = timer;
}

function stopGraphSweep(context: ControlServerContext): void {
  const timer = context.graphSweepTimer;
  context.graphSweepTimer = undefined;
  if (timer !== undefined) {
    clearInterval(timer);
  }
}

async function runAutomaticGraphSweep(context: ControlServerContext): Promise<void> {
  if (context.sweepingGraphs) {
    return;
  }
  context.sweepingGraphs = true;
  try {
    await context.sweepGraphs();
  } catch (error) {
    context.logger(`event=graph-sweep-failed error=${errorName(error)}`);
  } finally {
    context.sweepingGraphs = false;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700);
  }
}

function ensureParentDirectory(path: string): void {
  const parent = dirname(path);
  if (parent !== path) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
}

function writeSecretFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
  }
}

function safeRemoveFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort cleanup. Never recurse: a directory in place of a file is
    // left alone rather than deleting its contents.
  }
}

function errorName(error: unknown): string {
  const name = error instanceof Error && error.name !== '' ? error.name : 'error';
  return name.slice(0, 80).replace(/[^\u0021-\u007e]/g, '?');
}
