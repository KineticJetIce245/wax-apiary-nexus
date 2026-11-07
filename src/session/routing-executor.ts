import type {
  ExecutionContext,
  ForagerNode,
  NodeExecutor,
  NodeId,
  Value,
} from '../runtime/index.js';

export interface RoutingForagerOptions {
  /** One executor per forager node id. The map is read-only and not copied. */
  readonly executors: ReadonlyMap<NodeId, NodeExecutor>;
}

/** The node id has no executor bound to it in this routing table. */
export class UnknownForagerRouteError extends Error {
  constructor(readonly nodeId: NodeId) {
    super(`No forager executor is bound to node '${nodeId}'`);
    this.name = 'UnknownForagerRouteError';
  }
}

/** Routing is forager-only; a caller passed some other node kind. */
export class NotAForagerNodeError extends Error {
  constructor(
    readonly nodeId: NodeId,
    readonly kind: string,
  ) {
    super(`Node '${nodeId}' is a '${kind}' node, not a forager`);
    this.name = 'NotAForagerNodeError';
  }
}

/** The routing executor was disposed and must not accept new work. */
export class RoutingExecutorDisposedError extends Error {
  constructor() {
    super('Routing forager executor is disposed');
    this.name = 'RoutingExecutorDisposedError';
  }
}

interface Disposable {
  dispose(): void;
}

function isDisposable(value: object): value is Disposable {
  return typeof (value as { dispose?: unknown }).dispose === 'function';
}

/**
 * Routes each forager activation to the executor bound to that node id.
 *
 * Routing is by `node.id`, never by insertion order or connection name, so two
 * foragers in one graph can drive two different native sessions. This class
 * adds no cross-child concurrency control: each `WorkspaceForagerExecutor`
 * relies on its own conversation's busy check.
 */
export class RoutingForagerExecutor implements NodeExecutor {
  private readonly executors: ReadonlyMap<NodeId, NodeExecutor>;
  private lastProduced: Value | undefined;
  private disposed = false;

  constructor(options: RoutingForagerOptions) {
    this.executors = options.executors;
  }

  /** The most recent successful child output, for one-shot reporting. */
  get lastOutput(): Value | undefined {
    return this.lastProduced;
  }

  async execute(
    node: ForagerNode,
    input: Value,
    context?: ExecutionContext,
  ): Promise<Value> {
    if (this.disposed) {
      throw new RoutingExecutorDisposedError();
    }
    if (node.kind !== 'forager') {
      throw new NotAForagerNodeError(node.id, node.kind);
    }
    const executor = this.executors.get(node.id);
    if (executor === undefined) {
      throw new UnknownForagerRouteError(node.id);
    }

    // A child failure propagates unchanged: routing adds neither retries nor
    // a second error type, so callers can tell which session failed and how.
    const output = await executor.execute(node, input, context);
    this.lastProduced = output;
    return output;
  }

  /** Idempotent. Each distinct child that exposes `dispose()` is released once. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const seen = new Set<NodeExecutor>();
    for (const executor of this.executors.values()) {
      if (seen.has(executor)) {
        continue;
      }
      seen.add(executor);
      if (isDisposable(executor)) {
        executor.dispose();
      }
    }
  }
}
