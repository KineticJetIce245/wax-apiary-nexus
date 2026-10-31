import { createInterface, type Interface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface RpcErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: NodeJS.Timeout;
}

export interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcServerRequest extends RpcNotification {
  readonly id: number | string;
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

export class CodexConnectionClosedError extends Error {
  constructor(message = 'Codex app-server connection closed') {
    super(message);
    this.name = 'CodexConnectionClosedError';
  }
}

export class CodexRequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`Codex app-server request timed out after ${timeoutMs}ms: ${method}`);
    this.name = 'CodexRequestTimeoutError';
  }
}

/**
 * Minimal newline-delimited JSON-RPC client for `codex app-server` stdio.
 * Codex omits the `jsonrpc` field on the wire, so it is not sent here.
 * This class owns framing and correlation only; protocol semantics live in
 * CodexAppServerAdapter.
 */
export class CodexRpcClient {
  private readonly readline: Interface;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestHandlers = new Set<(request: RpcServerRequest) => Promise<unknown> | unknown>();
  private readonly notificationHandlers = new Set<(notification: RpcNotification) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.readline.on('line', (line) => this.handleLine(line));
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.on('error', (error) => this.failAll(new CodexConnectionClosedError(error.message)));
    child.stdin.on('error', (error) => this.failAll(new CodexConnectionClosedError(error.message)));
    child.stdout.on('error', (error) => this.failAll(new CodexConnectionClosedError(error.message)));
  }

  request(method: string, params?: unknown, timeoutMs = 0): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new CodexConnectionClosedError());
    }
    const id = this.nextId++;
    const json = JSON.stringify({ id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(String(id));
              reject(new CodexRequestTimeoutError(method, timeoutMs));
            }, timeoutMs)
          : undefined;
      timer?.unref();
      this.pending.set(String(id), { method, resolve, reject, ...(timer === undefined ? {} : { timer }) });
      try {
        this.write(json);
      } catch (error) {
        this.pending.delete(String(id));
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw new CodexConnectionClosedError();
    }
    this.write(JSON.stringify({ method, params }));
  }

  onRequest(handler: (request: RpcServerRequest) => Promise<unknown> | unknown): () => void {
    this.requestHandlers.add(handler);
    return () => {
      this.requestHandlers.delete(handler);
    };
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  close(): void {
    this.closed = true;
    this.readline.close();
    this.failAll(new CodexConnectionClosedError('Codex app-server client closed'));
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (text === '') {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.reportError(new Error('Codex app-server stdout contained a non-JSON line'));
      return;
    }
    if (!isRecord(message)) {
      this.reportError(new Error('Codex app-server stdout contained a non-object JSON message'));
      return;
    }

    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = message.id;
    if (method !== undefined) {
      if (typeof id === 'number' || typeof id === 'string') {
        void this.handleRequest({ id, method, ...(message.params === undefined ? {} : { params: message.params }) });
      } else {
        this.handleNotification({
          method,
          ...(message.params === undefined ? {} : { params: message.params }),
        });
      }
      return;
    }

    if (typeof id === 'number' || typeof id === 'string') {
      this.handleResponse(id, message);
    }
  }

  private async handleRequest(request: RpcServerRequest): Promise<void> {
    for (const handler of this.requestHandlers) {
      try {
        const result = await handler(request);
        this.respond(request.id, result);
        return;
      } catch (error) {
        this.respondError(request.id, -32603, error instanceof Error ? error.message : String(error));
        return;
      }
    }
    this.respondError(request.id, -32601, `No Codex app-server request handler for ${request.method}`);
  }

  private handleNotification(notification: RpcNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleResponse(id: number | string, response: Record<string, unknown>): void {
    const pending = this.pending.get(String(id));
    if (pending === undefined) {
      return;
    }
    this.pending.delete(String(id));
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    const error = asRecord(response.error);
    if (error !== undefined) {
      pending.reject(
        new CodexRpcError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' ? error.message : 'Codex app-server request failed',
          error.data,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private respond(id: number | string, result: unknown): void {
    if (this.closed) {
      return;
    }
    try {
      this.write(JSON.stringify({ id, result }));
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private respondError(id: number | string, code: number, message: string): void {
    if (this.closed) {
      return;
    }
    try {
      this.write(JSON.stringify({ id, error: { code, message } }));
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private write(payload: string): void {
    if (!this.child.stdin.writable) {
      throw new CodexConnectionClosedError('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${payload}\n`);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.closed = true;
    this.failAll(
      new CodexConnectionClosedError(
        `Codex app-server process exited (code=${String(code)}, signal=${String(signal)})`,
      ),
    );
    for (const handler of this.exitHandlers) {
      try {
        handler(code, signal);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
  }

  private reportError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Ignore observer failures.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
