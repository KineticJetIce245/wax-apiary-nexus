import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, join, resolve } from 'node:path';

import { DaemonLock } from '../daemon/daemon-lock.js';
import {
  GraphHost,
  GraphHostDisposedError,
  GraphLoadError,
  GraphNotFoundError,
  type LoadGraphOptions,
} from '../daemon/graph-host.js';
import type { GraphBindings } from '../graph/binding.js';
import type { GraphBindingStore } from '../graph/binding-store.js';
import { GraphAlreadyLoadedError } from '../graph/registry.js';
import type { Project } from '../project/kernel.js';
import { ProjectDirectoryError } from '../project/project-directory.js';
import {
  CompositionValidationError,
  parseComposition,
  QueueFullError,
  type Value,
} from '../runtime/index.js';
import { BindingValidationError } from '../session/instantiate-foragers.js';
import type { SessionRegistry } from '../session/session-registry.js';
import type { Workspace } from '../session/workspace.js';
import { expandHomePath } from '../storage/conversation-store.js';
import { HoneyStore } from '../storage/honey.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_DAEMON_DIR = join(expandHomePath('~/.wax'), 'waxd');
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 2_048;
const MAX_TOKEN_LENGTH = 4_096;

export interface ControlServerOptions {
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly harness: string;
  /** WAX state root (`~/.wax` or a test temp directory). */
  readonly stateRoot: string;
  readonly apiary: string;
  /** Only `127.0.0.1` is accepted; the control channel is never remote. */
  readonly host?: '127.0.0.1';
  /** 0 lets the OS assign a port. */
  readonly port?: number;
  /** Default `~/.wax/waxd`. */
  readonly daemonDir?: string;
  /** Tests only; production always generates 32 random bytes. */
  readonly token?: string;
  readonly tokenPath?: string;
  readonly infoPath?: string;
  readonly lockPath?: string;
  /** Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /**
   * Durable store per graph. When omitted, the server uses
   * `HoneyStore.forComposition(stateRoot, apiary, graphId)`, matching the
   * daemon's state layout.
   */
  readonly honeyForGraph?: (graphId: string) => HoneyStore;
  /**
   * Durable `fresh_once` reuse mappings. Omitted means `fresh_once` loads are
   * rejected; it never silently degrades to `fresh_always`.
   */
  readonly bindingStore?: GraphBindingStore;
  readonly now?: () => number;
  /**
   * Metadata-only request log. It never receives a body, prompt, output or
   * token; the line contains method, path, status, duration and error code.
   */
  readonly logger?: (line: string) => void;
}

export interface ControlServerInfo {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly tokenPath: string;
  readonly infoPath: string;
}

type ControlErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'not-found'
  | 'method-not-allowed'
  | 'conflict'
  | 'too-large'
  | 'unsupported-media-type'
  | 'internal';

interface HttpErrorOptions {
  readonly allow?: readonly string[];
  /** Extra metadata (for example the current graph status on 409). */
  readonly body?: Record<string, unknown>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ControlErrorCode,
    message: string,
    readonly options: HttpErrorOptions = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type RouteKind = 'health' | 'status' | 'graph-status' | 'load' | 'trigger' | 'unload' | 'sweep';

interface Route {
  readonly kind: RouteKind;
  readonly methods: readonly string[];
  readonly graphId?: string;
}

interface TriggerRequest {
  readonly graphId: string;
  readonly nodeId: string;
  readonly value: Value;
}

/**
 * Local control API for one GraphHost.
 *
 * Transport is plain HTTP on loopback only; the token is the authentication
 * boundary. The class owns the GraphHost, the daemon lock and the token/info
 * files, but not the Workspace or SessionRegistry supplied by the caller.
 *
 * `start()` is idempotent while running. A failed start releases the lock,
 * closes the listener and removes the token/info files it wrote. `stop()` is
 * idempotent and closes the listener before releasing the lock, so a second
 * process can never observe a half-stopped daemon.
 */
export class ControlServer {
  private readonly options: ControlServerOptions;
  private readonly host: '127.0.0.1';
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private readonly daemonDir: string;
  private readonly tokenPath: string;
  private readonly infoPath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly logger: (line: string) => void;
  private readonly honeyForGraph: (graphId: string) => HoneyStore;
  private readonly configuredToken: string | undefined;

  private state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
  private server: Server | undefined;
  private lock: DaemonLock | undefined;
  private graphHost: GraphHost | undefined;
  private tokenValue: string | undefined;
  private currentInfo: ControlServerInfo | undefined;
  private startPromise: Promise<ControlServerInfo> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(options: ControlServerOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('ControlServer options are required');
    }
    if (typeof options.workspace !== 'object' || options.workspace === null) {
      throw new TypeError('ControlServer requires a workspace');
    }
    if (typeof options.registry !== 'object' || options.registry === null) {
      throw new TypeError('ControlServer requires a session registry');
    }
    this.options = options;

    requireConfigString(options.harness, 'harness', 128);
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
    this.honeyForGraph =
      options.honeyForGraph ??
      ((graphId: string) => HoneyStore.forComposition(options.stateRoot, options.apiary, graphId));

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

  async start(): Promise<ControlServerInfo> {
    if (this.state === 'running' && this.currentInfo !== undefined) {
      return this.currentInfo;
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }
    if (this.state === 'stopping') {
      throw new Error('control server is stopping');
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /** Idempotent. Best-effort cleanup must not turn a stop into a rejection. */
  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  info(): ControlServerInfo {
    if (this.currentInfo === undefined) {
      throw new Error('control server is not running');
    }
    return this.currentInfo;
  }

  private async startInternal(): Promise<ControlServerInfo> {
    this.state = 'starting';
    const startedAt = new Date(this.now()).toISOString();
    let lock: DaemonLock | undefined;
    let server: Server | undefined;
    let graphHost: GraphHost | undefined;
    let tokenAttempted = false;
    let infoAttempted = false;

    try {
      ensurePrivateDirectory(this.daemonDir);
      ensureParentDirectory(this.tokenPath);
      ensureParentDirectory(this.infoPath);
      ensureParentDirectory(this.lockPath);

      // The lock is acquired before the token is written. A second server must
      // not overwrite the first server's live token before being refused.
      lock = DaemonLock.acquire(this.lockPath, this.options.apiary);

      const token = this.configuredToken ?? randomBytes(32).toString('hex');
      tokenAttempted = true;
      writeSecretFile(this.tokenPath, token);

      graphHost = new GraphHost({
        workspace: this.options.workspace,
        registry: this.options.registry,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
        honeyForGraph: this.honeyForGraph,
        ...(this.options.bindingStore === undefined
          ? {}
          : { bindingStore: this.options.bindingStore }),
      });

      server = createServer((request, response) => {
        void this.handle(request, response);
      });
      // A late server-level error must never become an unhandled exception.
      // Request-level failures are handled (and logged as metadata) in handle().
      server.on('error', () => undefined);

      await listenOnLoopback(server, this.port, this.host);

      const address = server.address();
      if (
        address === null ||
        typeof address === 'string' ||
        address.address !== this.host ||
        address.family !== 'IPv4'
      ) {
        throw new Error(`control server is not bound to ${this.host}`);
      }

      const info: ControlServerInfo = {
        url: `http://${this.host}:${String(address.port)}`,
        host: this.host,
        port: address.port,
        pid: process.pid,
        startedAt,
        tokenPath: this.tokenPath,
        infoPath: this.infoPath,
      };

      infoAttempted = true;
      writeSecretFile(
        this.infoPath,
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

      this.server = server;
      this.lock = lock;
      this.graphHost = graphHost;
      this.tokenValue = token;
      this.currentInfo = info;
      this.state = 'running';
      return info;
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      if (graphHost !== undefined) {
        await graphHost.dispose().catch(() => undefined);
      }
      // Local flags make cleanup safe on the lock-failure path: a rejected
      // second server must never delete the first server's files.
      if (tokenAttempted) {
        safeRemoveFile(this.tokenPath);
      }
      if (infoAttempted) {
        safeRemoveFile(this.infoPath);
      }
      try {
        lock?.release();
      } catch {
        // Best effort. A leaked lock is stale after this process exits.
      }
      this.server = undefined;
      this.lock = undefined;
      this.graphHost = undefined;
      this.tokenValue = undefined;
      this.currentInfo = undefined;
      this.state = 'idle';
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise !== undefined) {
      // A stop racing a start waits for the attempt; a failed start already
      // cleaned itself up.
      try {
        await this.startPromise;
      } catch {
        return;
      }
    }

    const server = this.server;
    const graphHost = this.graphHost;
    const lock = this.lock;
    const hadResources = server !== undefined || graphHost !== undefined || lock !== undefined;

    this.state = 'stopping';
    this.server = undefined;
    this.graphHost = undefined;
    this.lock = undefined;
    this.tokenValue = undefined;
    this.currentInfo = undefined;

    if (!hadResources) {
      this.state = 'idle';
      return;
    }

    // Stop accepting requests first; closeAllConnections also releases pooled
    // keep-alive sockets held by local clients.
    await closeServer(server).catch(() => undefined);
    if (graphHost !== undefined) {
      await graphHost.dispose().catch(() => undefined);
    }

    // Remove the discovery material while the lock still excludes a new
    // server. Releasing first would allow a successor to write a fresh token
    // that this stop then deletes.
    safeRemoveFile(this.tokenPath);
    safeRemoveFile(this.infoPath);
    try {
      lock?.release();
    } catch {
      // Best effort; an unreleased lock becomes stale with this PID.
    }
    this.state = 'idle';
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestStartedAt = Date.now();
    const pathForLog = requestPathForLog(request.url);
    let status = 500;
    let code: ControlErrorCode | 'ok' = 'internal';

    request.on('error', () => undefined);
    response.on('error', () => undefined);

    try {
      this.authorize(request);

      const route = matchRoute(request.url);
      if (route === undefined) {
        throw new HttpError(404, 'not-found', 'not found');
      }
      if (!route.methods.includes(request.method ?? '')) {
        throw new HttpError(405, 'method-not-allowed', 'method not allowed', {
          allow: route.methods,
        });
      }

      let payload: Record<string, unknown> | undefined;
      if (route.methods[0] === 'POST') {
        requireJsonContentType(request);
        const body = await this.readBody(request);
        payload = parseJsonObject(body);
      } else {
        rejectBodyOnGet(request);
      }

      const responseBody = await this.dispatch(route, payload);
      status = 200;
      code = 'ok';
      sendJson(response, status, responseBody);
    } catch (error) {
      const httpError = this.toHttpError(error);
      status = httpError.status;
      code = httpError.code;
      if (response.headersSent) {
        response.destroy();
      } else {
        sendError(request, response, httpError);
      }
    } finally {
      this.logRequest(
        request.method ?? '-',
        pathForLog,
        status,
        Date.now() - requestStartedAt,
        code,
      );
    }
  }

  private authorize(request: IncomingMessage): void {
    const expected = this.tokenValue;
    if (expected === undefined) {
      throw unauthorized();
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      throw unauthorized();
    }
    const match = /^Bearer[ ]+([^\s]+)$/i.exec(header);
    if (match === null) {
      throw unauthorized();
    }
    const provided = match[1];
    if (provided === undefined || !tokensEqual(provided, expected)) {
      throw unauthorized();
    }
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolvePromise, reject) => {
      const declaredHeader = request.headers['content-length'];
      if (declaredHeader !== undefined) {
        const declared = Number(declaredHeader);
        if (!Number.isSafeInteger(declared) || declared < 0) {
          reject(new HttpError(400, 'bad-request', 'invalid content-length'));
          return;
        }
        // Reject from the header alone. This is the only way to answer before
        // a client that never sends the announced body has transferred it.
        if (declared > this.maxBodyBytes) {
          reject(new HttpError(413, 'too-large', 'request body too large'));
          return;
        }
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const cleanup = (): void => {
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('error', onError);
        request.off('aborted', onAborted);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        // Do not read the rest of an invalid body into memory. The error
        // response closes the connection after it is flushed.
        request.pause();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          fail(new HttpError(413, 'too-large', 'request body too large'));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolvePromise(Buffer.concat(chunks, total));
      };
      const onError = (): void => {
        fail(new HttpError(400, 'bad-request', 'request body could not be read'));
      };
      const onAborted = (): void => {
        fail(new HttpError(400, 'bad-request', 'request body could not be read'));
      };

      request.on('data', onData);
      request.on('end', onEnd);
      request.on('error', onError);
      request.on('aborted', onAborted);
    });
  }

  private async dispatch(
    route: Route,
    payload: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const host = this.graphHost;
    if (host === undefined) {
      throw new HttpError(500, 'internal', 'internal error');
    }

    switch (route.kind) {
      case 'health': {
        const info = this.currentInfo;
        if (info === undefined) {
          throw new HttpError(500, 'internal', 'internal error');
        }
        return {
          ok: true,
          harness: this.options.harness,
          pid: process.pid,
          startedAt: info.startedAt,
        };
      }
      case 'status':
        return { ok: true, status: host.status() };
      case 'graph-status': {
        const graphId = route.graphId;
        if (graphId === undefined) {
          throw new HttpError(404, 'not-found', 'not found');
        }
        const status = host.statusOf(graphId);
        if (status === undefined) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        return { ok: true, status };
      }
      case 'load': {
        const loadOptions = this.parseLoadBody(requirePayload(payload));
        try {
          const status = await host.loadGraph(loadOptions);
          return { ok: true, status };
        } catch (error) {
          if (error instanceof GraphLoadError) {
            const current = host.statusOf(error.graphId);
            // GraphHost reports an already-loaded graph either through the
            // registry's typed cause or, for its own early check and an
            // in-flight load, as a GraphLoadError message. The graph being
            // present is the strongest signal; the message covers the window
            // before the graph is registered.
            const duplicate =
              current !== undefined ||
              error.cause instanceof GraphAlreadyLoadedError ||
              /already loaded/i.test(error.message);
            if (duplicate) {
              throw new HttpError(409, 'conflict', 'graph is already loaded', {
                ...(current === undefined ? {} : { body: { status: current } }),
              });
            }
          }
          throw error;
        }
      }
      case 'trigger': {
        const trigger = this.parseTriggerBody(requirePayload(payload));
        const current = host.statusOf(trigger.graphId);
        if (current === undefined) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        const node = current.nodes.find((candidate) => candidate.nodeId === trigger.nodeId);
        if (
          node === undefined ||
          !['forager', 'worker', 'user'].includes(node.kind)
        ) {
          throw new HttpError(400, 'bad-request', 'unknown or untriggerable node');
        }
        try {
          const result = await host.trigger(trigger.graphId, trigger.nodeId, trigger.value);
          return { ok: true, result };
        } catch (error) {
          if (error instanceof GraphNotFoundError) {
            throw new HttpError(404, 'not-found', 'graph is not loaded');
          }
          if (error instanceof QueueFullError) {
            throw new HttpError(409, 'conflict', 'graph queue is full');
          }
          if (error instanceof TypeError) {
            throw new HttpError(400, 'bad-request', 'invalid trigger value');
          }
          throw error;
        }
      }
      case 'unload': {
        const graphId = this.parseUnloadBody(requirePayload(payload));
        const current = host.statusOf(graphId);
        if (current === undefined) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        const unloaded = await host.unload(graphId);
        if (!unloaded) {
          const latest = host.statusOf(graphId);
          if (latest === undefined) {
            // Another request unloaded the graph between our status read and
            // the unload attempt. Report the truthful current state.
            throw new HttpError(404, 'not-found', 'graph is not loaded');
          }
          throw new HttpError(409, 'conflict', 'graph is not unloadable', {
            body: { status: latest },
          });
        }
        return { ok: true, unloaded: true };
      }
      case 'sweep': {
        const body = requirePayload(payload);
        assertExactFields(body, [], 'sweep request');
        const report = await host.sweep();
        return { ok: true, report };
      }
    }
  }

  private parseLoadBody(body: Record<string, unknown>): LoadGraphOptions {
    assertExactFields(body, ['definition', 'bindings', 'project', 'idleTtlMs'], 'load request');
    const definition = parseComposition(requireBodyField(body, 'definition', 'load request'));
    const bindings = parseBindings(requireBodyField(body, 'bindings', 'load request'));
    const project = parseProject(requireBodyField(body, 'project', 'load request'));
    const idleTtlMs = parseOptionalNonNegativeInteger(body['idleTtlMs'], 'idleTtlMs');
    return {
      definition,
      bindings,
      project,
      ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
    };
  }

  private parseTriggerBody(body: Record<string, unknown>): TriggerRequest {
    assertExactFields(body, ['graphId', 'nodeId', 'value'], 'trigger request');
    const graphId = requireStringField(body, 'graphId', 'graphId', MAX_ID_LENGTH);
    const nodeId = requireStringField(body, 'nodeId', 'nodeId', MAX_ID_LENGTH);
    if (!Object.hasOwn(body, 'value') || body['value'] === undefined) {
      throw new HttpError(400, 'bad-request', "missing field 'value' in trigger request");
    }
    return { graphId, nodeId, value: body['value'] as Value };
  }

  private parseUnloadBody(body: Record<string, unknown>): string {
    assertExactFields(body, ['graphId'], 'unload request');
    return requireStringField(body, 'graphId', 'graphId', MAX_ID_LENGTH);
  }

  private toHttpError(error: unknown): HttpError {
    if (error instanceof HttpError) {
      return error;
    }
    if (error instanceof CompositionValidationError) {
      return new HttpError(400, 'bad-request', 'invalid composition definition');
    }
    if (error instanceof BindingValidationError) {
      return new HttpError(400, 'bad-request', 'invalid graph bindings');
    }
    if (error instanceof ProjectDirectoryError) {
      return new HttpError(400, 'bad-request', 'invalid project directory');
    }
    if (error instanceof GraphNotFoundError) {
      return new HttpError(404, 'not-found', 'graph is not loaded');
    }
    if (error instanceof QueueFullError) {
      return new HttpError(409, 'conflict', 'graph queue is full');
    }
    if (error instanceof TypeError) {
      // The runtime uses TypeError for malformed Value shapes.
      return new HttpError(400, 'bad-request', 'invalid request value');
    }
    if (error instanceof GraphHostDisposedError || error instanceof GraphLoadError) {
      return new HttpError(500, 'internal', 'internal error');
    }
    return new HttpError(500, 'internal', 'internal error');
  }

  private logRequest(
    method: string,
    path: string,
    status: number,
    durationMs: number,
    code: ControlErrorCode | 'ok',
  ): void {
    try {
      this.logger(
        `control method=${sanitizeLogText(method, 16)} path=${path} ` +
          `status=${String(status)} durationMs=${String(Math.max(0, Math.trunc(durationMs)))} ` +
          `code=${code}`,
      );
    } catch {
      // Logging is observability, never a reason to change a response.
    }
  }
}

function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'missing or invalid bearer token');
}

function tokensEqual(provided: string, expected: string): boolean {
  // Hash first so timingSafeEqual always receives equal-length buffers. The
  // token content is still compared exactly; the hash only hides the length
  // difference from the comparison primitive.
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function requireJsonContentType(request: IncomingMessage): void {
  const header = request.headers['content-type'];
  if (typeof header !== 'string') {
    throw new HttpError(415, 'unsupported-media-type', 'content-type must be application/json');
  }
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'unsupported-media-type', 'content-type must be application/json');
  }
}

function rejectBodyOnGet(request: IncomingMessage): void {
  const lengthHeader = request.headers['content-length'];
  const hasLength = lengthHeader !== undefined && lengthHeader !== '0';
  const hasTransferEncoding = request.headers['transfer-encoding'] !== undefined;
  if (hasLength || hasTransferEncoding) {
    throw new HttpError(400, 'bad-request', 'GET requests must not have a body');
  }
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  if (body.length === 0) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-request', 'request body is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object');
  }
  return parsed;
}

function parseBindings(value: unknown): GraphBindings {
  if (!isRecord(value)) {
    throw new HttpError(400, 'bad-request', 'bindings must be an object');
  }
  for (const raw of Object.values(value)) {
    if (!isRecord(raw)) {
      throw new HttpError(400, 'bad-request', 'each binding must be an object');
    }
    const kind = raw['kind'];
    if (kind === 'session') {
      assertExactFields(raw, ['kind', 'sessionId'], 'binding');
    } else if (kind === 'fresh') {
      assertExactFields(raw, ['kind', 'mode', 'model', 'reasoning'], 'binding');
    } else {
      throw new HttpError(400, 'bad-request', "binding kind must be 'session' or 'fresh'");
    }
  }
  // Semantic validation (missing/unknown/busy sessions, project and harness
  // match) stays in GraphHost's binding layer; this only enforces the request
  // schema and rejects unknown fields before a session can be created.
  return value as unknown as GraphBindings;
}

function parseProject(value: unknown): Project {
  if (!isRecord(value)) {
    throw new HttpError(400, 'bad-request', 'project must be an object');
  }
  assertExactFields(value, ['id', 'directory'], 'project');
  const id = requireStringField(value, 'id', 'project.id', 256);
  const directory = requireStringField(value, 'directory', 'project.directory', 4_096);
  return { id, directory };
}

function parseOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'bad-request', `${field} must be a non-negative integer`);
  }
  return value;
}

function requireBodyField(
  body: Record<string, unknown>,
  key: string,
  label: string,
): unknown {
  if (!Object.hasOwn(body, key)) {
    throw new HttpError(400, 'bad-request', `${label}: missing field '${key}'`);
  }
  return body[key];
}

function requireStringField(
  record: Record<string, unknown>,
  key: string,
  field: string,
  maxLength: number,
): string {
  const value = record[key];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new HttpError(
      400,
      'bad-request',
      `${field} must be a non-empty string of at most ${String(maxLength)} characters`,
    );
  }
  return value;
}

function assertExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      // The field name is not echoed: it is attacker-controlled and this
      // response is part of the no-body/no-token surface.
      throw new HttpError(400, 'bad-request', `${label}: unknown field`);
    }
  }
}

function requirePayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (payload === undefined) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object');
  }
  return payload;
}

function matchRoute(rawUrl: string | undefined): Route | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (!path.startsWith('/') || path.length > MAX_PATH_LENGTH) {
    return undefined;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(path)) {
    return undefined;
  }

  // Deliberately no URL normalization: `/status/../health` must be an
  // unknown path, never a redirect to `/health`. Dot segments and empty
  // segments are rejected before any route lookup.
  const parts = path.split('/').slice(1);
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return undefined;
  }

  if (parts.length === 1) {
    switch (parts[0]) {
      case 'health':
        return { kind: 'health', methods: ['GET'] };
      case 'status':
        return { kind: 'status', methods: ['GET'] };
      case 'trigger':
        return { kind: 'trigger', methods: ['POST'] };
      case 'sweep':
        return { kind: 'sweep', methods: ['POST'] };
      default:
        return undefined;
    }
  }

  if (parts.length === 2) {
    const first = parts[0];
    const second = parts[1];
    if (first === undefined || second === undefined) {
      return undefined;
    }
    if (first === 'status') {
      if (second.length > MAX_ID_LENGTH) {
        return undefined;
      }
      return { kind: 'graph-status', methods: ['GET'], graphId: second };
    }
    if (first === 'graphs' && second === 'load') {
      return { kind: 'load', methods: ['POST'] };
    }
    if (first === 'graphs' && second === 'unload') {
      return { kind: 'unload', methods: ['POST'] };
    }
  }

  return undefined;
}

function requestPathForLog(rawUrl: string | undefined): string {
  if (rawUrl === undefined) {
    return '-';
  }
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return sanitizeLogText(path, 200);
}

function sanitizeLogText(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[^\u0021-\u007e]/g, '?');
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function sendError(
  request: IncomingMessage,
  response: ServerResponse,
  error: HttpError,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json; charset=utf-8',
    Connection: 'close',
  };
  if (error.options.allow !== undefined) {
    headers['Allow'] = error.options.allow.join(', ');
  }

  try {
    response.writeHead(error.status, headers);
  } catch {
    response.destroy();
    return;
  }

  const payload: Record<string, unknown> = {
    ok: false,
    code: error.code,
    error: error.message,
  };
  if (error.options.body !== undefined) {
    Object.assign(payload, error.options.body);
  }

  const destroyRequest = (): void => {
    try {
      request.destroy();
    } catch {
      // The client may already have gone away.
    }
  };
  response.once('finish', destroyRequest);
  response.once('close', destroyRequest);
  response.end(JSON.stringify(payload));
}

function listenOnLoopback(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolvePromise();
    };
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host, exclusive: true });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolvePromise();
    };

    // close() waits for connections; a local keep-alive client must not make
    // stop() hang. closeAllConnections() is available on supported Node.
    timer = setTimeout(done, 1_000);
    timer.unref();
    try {
      server.close(() => done());
    } catch {
      done();
    }
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    // mkdir mode is subject to umask and does not change an existing
    // directory; the token directory is a security boundary, so enforce it.
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
    // A pre-existing file keeps its old mode unless it is set explicitly.
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

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError('port must be an integer between 0 and 65535');
  }
  return value;
}

function validateMaxBodyBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }
  return value;
}

function requireConfigString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${String(maxLength)} characters`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
