import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type { Execution } from './workspace.js';
import type { Workbench } from './workbench.js';

export interface CollaborationGatewayOptions {
  readonly workerConnection?: string;
  readonly port?: number;
  readonly pollIntervalMs?: number;
  readonly maxTaskChars?: number;
}

export interface CollaborationGatewayInfo {
  readonly url: string;
  readonly token: string;
  readonly workerConnection: string;
}

export class CollaborationGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CollaborationGatewayError';
  }
}

/**
 * Local HTTP surface called by the MCP delegate bridge. It performs exactly one
 * worker submission per request and returns the completed worker output. It is
 * bound to loopback and requires a bearer token; it has no queue or retry.
 */
export class CollaborationGateway {
  private readonly workbench: Workbench;
  private readonly workerConnection: string;
  private readonly port: number;
  private readonly pollIntervalMs: number;
  private readonly maxTaskChars: number;
  private readonly token = randomUUID();
  private readonly host = '127.0.0.1' as const;
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private info: CollaborationGatewayInfo | undefined;

  constructor(workbench: Workbench, options: CollaborationGatewayOptions = {}) {
    this.workbench = workbench;
    this.workerConnection = options.workerConnection ?? 'dsh';
    this.port = options.port ?? 0;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.maxTaskChars = options.maxTaskChars ?? 20_000;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error(`port must be an integer between 0 and 65535: ${String(options.port)}`);
    }
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  async start(): Promise<CollaborationGatewayInfo> {
    if (this.server !== undefined) {
      throw new Error('Collaboration gateway is already running');
    }
    const server = createServer((request, response) => this.handleRequest(request, response));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.info = {
      url: `http://${this.host}:${String(address.port)}/delegate`,
      token: this.token,
      workerConnection: this.workerConnection,
    };
    return this.info;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.info = undefined;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    void this.handleRequestAsync(request, response).catch((error: unknown) => {
      const status = error instanceof CollaborationGatewayError ? error.status : 500;
      this.sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleRequestAsync(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const expectedHost = this.info === undefined ? undefined : `127.0.0.1:${String(new URL(this.info.url).port)}`;
    if (expectedHost === undefined || request.headers.host?.toLowerCase() !== expectedHost) {
      throw new CollaborationGatewayError('Forbidden host', 403);
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      throw new CollaborationGatewayError('Method not allowed', 405);
    }
    if (request.url !== '/delegate') {
      throw new CollaborationGatewayError('Not found', 404);
    }
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${this.token}`) {
      throw new CollaborationGatewayError('Unauthorized', 401);
    }

    const body = await readBody(request, this.maxTaskChars * 4 + 1024);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new CollaborationGatewayError('Invalid JSON body', 400);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CollaborationGatewayError('Body must be an object', 400);
    }
    const record = parsed as Record<string, unknown>;
    const extra = Object.keys(record).filter((key) => key !== 'task' && key !== 'worker');
    if (extra.length > 0) {
      throw new CollaborationGatewayError(`Unknown fields: ${extra.join(', ')}`, 400);
    }
    const task = record.task;
    if (typeof task !== 'string' || task.trim() === '' || task.length > this.maxTaskChars) {
      throw new CollaborationGatewayError('task must be a non-empty bounded string', 400);
    }
    const requestedWorker = record.worker;
    if (requestedWorker !== undefined && (typeof requestedWorker !== 'string' || requestedWorker.length > 64)) {
      throw new CollaborationGatewayError('worker must be a bounded string', 400);
    }
    const worker =
      typeof requestedWorker === 'string' && requestedWorker.trim() !== ''
        ? requestedWorker
        : this.workerConnection;
    if (this.workbench.getConnection(worker)?.status !== 'ready') {
      throw new CollaborationGatewayError(`Worker connection is not available: ${worker}`, 409);
    }

    let submitted;
    try {
      submitted = await this.workbench.submit(task, worker);
    } catch (error) {
      throw new CollaborationGatewayError(
        `Worker submission failed: ${error instanceof Error ? error.message : String(error)}`,
        409,
      );
    }
    const execution = await this.waitForTerminal(worker, submitted.execution.id);
    if (execution.state !== 'completed') {
      throw new CollaborationGatewayError(
        `Worker ended as ${execution.state}: ${execution.error ?? 'no output'}`,
        502,
      );
    }
    this.sendJson(response, 200, {
      worker,
      executionId: execution.id,
      output: execution.output,
    });
  }

  private async waitForTerminal(connection: string, executionId: string): Promise<Execution> {
    while (true) {
      const found = this.workbench.getExecution(connection, executionId);
      if (found === undefined) {
        throw new CollaborationGatewayError('Worker execution is no longer available', 502);
      }
      if (found.execution.state !== 'running') {
        return found.execution;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) {
      return;
    }
    const body = JSON.stringify(value);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  }
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new CollaborationGatewayError('Request body too large', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
