import type { GraphBindings } from '../graph/binding.js';
import type { GraphBindingStore } from '../graph/binding-store.js';
import type { LiveHiveCatalog } from '../daemon/live-hive-catalog.js';
import type { Project } from '../project/kernel.js';
import type { GuardDecision, Value } from '../runtime/index.js';
import type { SessionRegistry } from '../session/session-registry.js';
import type { HoneyStore } from '../storage/honey.js';

export interface ControlServerOptions {
  readonly registry: SessionRegistry;
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
  /**
   * Allow unload/sweep of a graph parked on quiescent hover(s) only. Default
   * false; `waxd` enables it explicitly so a local daemon can reclaim a field
   * that is waiting for an answer. Honey is flushed before release.
   */
  readonly allowHoverUnload?: boolean;
  /**
   * Idle TTL for WAX sessions; default 0 (disabled). When positive, the server
   * periodically closes sessions that have not been used for this long and are
   * neither busy nor bound to a loaded graph.
   */
  readonly sessionIdleTtlMs?: number;
  /**
   * Sweep period; default 60_000. Only started when `sessionIdleTtlMs > 0`.
   * `0` is accepted when the TTL is disabled so a caller can express "no timer";
   * a positive TTL requires a positive interval.
   */
  readonly sessionSweepIntervalMs?: number;
  /**
   * Period for automatic graph TTL sweeps; default 60_000. `0` disables the
   * timer. The manual `POST /sweep` route is unaffected.
   */
  readonly graphSweepIntervalMs?: number;
  /** Optional durable LiveHive identity index, shared by host and `/catalog`. */
  readonly catalog?: LiveHiveCatalog;
  /** Native guard decision timeout; defaults to one hour. */
  readonly guardTimeoutMs?: number;
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

export type ControlErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'not-found'
  | 'method-not-allowed'
  | 'conflict'
  | 'session-busy'
  | 'too-large'
  | 'unsupported-media-type'
  | 'internal';

export interface HttpErrorOptions {
  readonly allow?: readonly string[];
  /** Extra metadata (for example the current graph status on 409). */
  readonly body?: Record<string, unknown>;
}

export class HttpError extends Error {
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

export type RouteKind =
  | 'health'
  | 'status'
  | 'graph-status'
  | 'graph-output'
  | 'load'
  | 'trigger'
  | 'answer'
  | 'unload'
  | 'sweep'
  | 'catalog'
  | 'guards'
  | 'guard-decide'
  | 'sessions'
  | 'session-close'
  | 'session-sweep';

export interface Route {
  readonly kind: RouteKind;
  readonly methods: readonly string[];
  readonly graphId?: string;
}

export interface TriggerRequest {
  readonly graphId: string;
  readonly nodeId: string;
  readonly value: Value;
  /** Optional manifest path; consulted only when the graph is not in memory. */
  readonly graphRef?: string;
}

export interface AnswerRequest {
  readonly graphId: string;
  readonly nodeId: string;
  readonly value: Value;
  /** Hover token from the parked user hover; optional. Never logged. */
  readonly token?: string;
  /** Optional manifest path; consulted only when the graph is not in memory. */
  readonly graphRef?: string;
}

/** One lazy load from a manifest, with the node kind the caller can accept. */
export interface LazyLoadRequest {
  readonly graphId: string;
  readonly nodeId: string;
  readonly graphRef: string;
  readonly allowedNodeKinds: readonly string[];
  readonly nodeErrorMessage: string;
}

export type { GraphBindings, GuardDecision, Project };
