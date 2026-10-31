import { createInterface, type Interface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

type RequestHandler = (message: JsonRpcRequest) => Promise<unknown> | unknown;
type NotificationHandler = (message: JsonRpcNotification) => void;
type ErrorHandler = (error: Error) => void;
type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: NodeJS.Timeout;
}

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

export class AcpConnectionClosedError extends Error {
  constructor(message = 'ACP connection closed') {
    super(message);
    this.name = 'AcpConnectionClosedError';
  }
}

export class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`ACP request timed out after ${timeoutMs}ms: ${method}`);
    this.name = 'AcpRequestTimeoutError';
  }
}

/**
 * Minimal newline-delimited JSON-RPC 2.0 client for the ACP stdio transport.
 * It owns request correlation only; ACP semantics live in DshAcpAdapter.
 */
export class AcpRpcClient {
  private readonly readline: Interface;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestHandlers = new Set<RequestHandler>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.readline.on('line', (line) => this.handleLine(line));
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.on('error', (error) => this.failAll(new AcpConnectionClosedError(error.message)));
    child.stdin.on('error', (error) => this.failAll(new AcpConnectionClosedError(error.message)));
    child.stdout.on('error', (error) => this.failAll(new AcpConnectionClosedError(error.message)));
  }

  request(method: string, params?: unknown, timeoutMs = 0): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AcpConnectionClosedError());
    }
    const id = this.nextId++;
    const json = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(String(id));
              reject(new AcpRequestTimeoutError(method, timeoutMs));
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
      throw new AcpConnectionClosedError();
    }
    this.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  onRequest(handler: RequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => {
      this.requestHandlers.delete(handler);
    };
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  close(): void {
    this.closed = true;
    this.readline.close();
    this.failAll(new AcpConnectionClosedError('ACP client closed'));
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
      this.reportError(new Error('ACP stdout contained a non-JSON line'));
      return;
    }
    if (!isRecord(message)) {
      this.reportError(new Error('ACP stdout contained a non-object JSON message'));
      return;
    }

    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = message.id;
    if (method !== undefined) {
      if (id !== undefined && id !== null) {
        void this.handleRequest(message as unknown as JsonRpcRequest);
      } else {
        this.handleNotification(message as unknown as JsonRpcNotification);
      }
      return;
    }

    if (id !== undefined) {
      this.handleResponse(message as unknown as JsonRpcResponse);
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    for (const handler of this.requestHandlers) {
      try {
        const result = await handler(request);
        this.respond(request.id, result);
        return;
      } catch (error) {
        this.respondError(
          request.id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }
    this.respondError(request.id, -32601, `No ACP request handler for ${request.method}`);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id === null) {
      return;
    }
    const pending = this.pending.get(String(response.id));
    if (pending === undefined) {
      return;
    }
    this.pending.delete(String(response.id));
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    if (response.error !== undefined) {
      pending.reject(new AcpRpcError(response.error.code, response.error.message, response.error.data));
      return;
    }
    pending.resolve(response.result);
  }

  private respond(id: number | string, result: unknown): void {
    if (this.closed) {
      return;
    }
    try {
      this.write(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private respondError(id: number | string, code: number, message: string): void {
    if (this.closed) {
      return;
    }
    try {
      this.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private write(payload: string): void {
    if (!this.child.stdin.writable) {
      throw new AcpConnectionClosedError('ACP stdin is not writable');
    }
    this.child.stdin.write(`${payload}\n`);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.closed = true;
    this.failAll(new AcpConnectionClosedError(`ACP process exited (code=${String(code)}, signal=${String(signal)})`));
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
