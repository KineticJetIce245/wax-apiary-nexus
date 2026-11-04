import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';

import { ArtifactStore, type Artifact, type ArtifactStoreOptions } from './artifact-store.js';
import type { Attachment, AttachmentKind } from './content.js';
import type { TaggedWorkspaceEvent } from './workbench.js';
import type { Workbench } from './workbench.js';

const MAX_EXECUTIONS = 50;
const MAX_TOOLS_PER_EXECUTION = 50;
const MAX_ERRORS = 20;
const ARTIFACT_PATH = /^\/artifacts\/([a-f0-9]{64})$/;

export interface WebServerOptions {
  readonly port?: number;
  readonly maxArtifactBytes?: number;
  readonly artifactRoot?: string;
  /** Enables POST /api/prompt; the value is required as a bearer token. */
  readonly controlToken?: string;
}

export interface WebServerInfo {
  readonly url: string;
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface WebAttachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly name: string;
  readonly byteLength: number;
  readonly url: string;
}

export interface UnavailableWebAttachment {
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly name: string;
  readonly unavailable: string;
}

export interface WebTool {
  readonly title: string;
  readonly status: string;
}

export interface WebExecution {
  readonly id: string;
  readonly connection: string;
  readonly state: string;
  readonly output: string;
  readonly prompt?: string;
  readonly tools: readonly WebTool[];
  readonly attachments: readonly (WebAttachment | UnavailableWebAttachment)[];
  readonly error?: string;
  readonly updatedAt: string;
}

export interface WebApproval {
  readonly connection: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly summary: string;
}

export interface WebConnection {
  readonly name: string;
  readonly status: string;
  readonly conversationId?: string;
}

export interface WebState {
  readonly generatedAt: string;
  readonly connections: readonly WebConnection[];
  readonly executions: readonly WebExecution[];
  readonly approvals: readonly WebApproval[];
  readonly errors: readonly string[];
}

interface MutableExecution {
  readonly id: string;
  readonly connection: string;
  state: string;
  output: string;
  tools: WebTool[];
  attachments: (WebAttachment | UnavailableWebAttachment)[];
  error: string | undefined;
  updatedAt: number;
}

/**
 * Read-only local web view over the same Workbench. It never accepts writes:
 * only GET /, GET /api/state and GET /artifacts/<id>. The browser gets artifact
 * ids/URLs, never native file paths.
 */
export class WebServer {
  private readonly workbench: Workbench;
  private artifactStore: ArtifactStore | undefined;
  private readonly artifactOptions: ArtifactStoreOptions;
  private readonly port: number;
  private readonly host = '127.0.0.1' as const;
  private readonly executions = new Map<string, MutableExecution>();
  private readonly prompts = new Map<string, string>();
  private readonly approvals = new Map<string, WebApproval>();
  private readonly errors: string[] = [];
  private readonly sockets = new Set<Socket>();
  private unsubscribe: (() => void) | undefined;
  private server: Server | undefined;
  private info: WebServerInfo | undefined;
  private readonly controlToken: string | undefined;

  constructor(workbench: Workbench, options: WebServerOptions = {}) {
    this.workbench = workbench;
    this.port = options.port ?? 0;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error(`port must be an integer between 0 and 65535: ${String(options.port)}`);
    }
    if (options.controlToken !== undefined && options.controlToken.trim() === '') {
      throw new Error('controlToken must not be empty');
    }
    this.controlToken = options.controlToken;
    const artifactOptions: ArtifactStoreOptions = {
      ...(options.artifactRoot === undefined ? {} : { root: options.artifactRoot }),
      ...(options.maxArtifactBytes === undefined ? {} : { maxBytes: options.maxArtifactBytes }),
    };
    this.artifactOptions = artifactOptions;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  get url(): string | undefined {
    return this.info?.url;
  }

  async start(): Promise<WebServerInfo> {
    if (this.server !== undefined) {
      throw new Error('Web server is already running');
    }
    // A stopped server gets a fresh store on restart; old artifact ids remain
    // 404 because their files were removed by the previous stop().
    this.artifactStore = new ArtifactStore(this.artifactOptions);
    this.unsubscribe = this.workbench.onEvent((tagged) => this.handleEvent(tagged));
    const server = createServer((request, response) => this.handleRequest(request, response));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, this.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      this.unsubscribe();
      this.unsubscribe = undefined;
      this.artifactStore?.close();
      this.artifactStore = undefined;
      throw error;
    }
    const address = server.address() as AddressInfo;
    this.info = { url: `http://${this.host}:${String(address.port)}/`, host: this.host, port: address.port };
    return this.info;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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
    this.artifactStore?.close();
    this.artifactStore = undefined;
  }

  getState(): WebState {
    return {
      generatedAt: new Date().toISOString(),
      connections: this.workbench.connectionNames.flatMap((name) => {
        const connection = this.workbench.getConnection(name);
        return connection === undefined
          ? []
          : [
              {
                name,
                status: connection.status,
                conversationId: connection.conversation.id,
              },
            ];
      }),
      executions: [...this.executions.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_EXECUTIONS)
        .map((execution) => ({
          id: execution.id,
          connection: execution.connection,
          state: execution.state,
          output: execution.output,
          tools: execution.tools.map((tool) => ({ ...tool })),
          attachments: execution.attachments.map((attachment) => ({ ...attachment })),
          ...(this.prompts.has(execution.id) ? { prompt: this.prompts.get(execution.id) as string } : {}),
          ...(execution.error === undefined ? {} : { error: execution.error }),
          updatedAt: new Date(execution.updatedAt).toISOString(),
        })),
      approvals: [...this.approvals.values()].map((approval) => ({ ...approval })),
      errors: [...this.errors],
    };
  }

  private handleEvent(tagged: TaggedWorkspaceEvent): void {
    const { connection, event } = tagged;
    try {
      if (event.type === 'adapter/error') {
        this.addError(`${connection}: ${event.message}`);
        return;
      }
      if (event.type === 'execution/approval-requested') {
        this.approvals.set(
          approvalKey(connection, event.request.executionId, event.request.requestId),
          {
            connection,
            executionId: event.request.executionId,
            requestId: event.request.requestId,
            summary: event.request.summary,
          },
        );
        this.touch(connection, event.request.executionId);
        return;
      }
      if (event.type === 'execution/approval-decided') {
        this.approvals.delete(approvalKey(connection, event.executionId, event.requestId));
        this.touch(connection, event.executionId);
        return;
      }

      const execution = this.ensureExecution(connection, event.executionId);
      switch (event.type) {
        case 'execution/output':
          if (event.channel === 'assistant') {
            execution.output += event.text;
          }
          break;
        case 'execution/tool':
          execution.tools.push({ title: event.title, status: event.status });
          if (execution.tools.length > MAX_TOOLS_PER_EXECUTION) {
            execution.tools.splice(0, execution.tools.length - MAX_TOOLS_PER_EXECUTION);
          }
          break;
        case 'execution/attachment':
          execution.attachments.push(this.registerAttachment(event.attachment));
          break;
        case 'execution/state':
          execution.state = event.state;
          execution.error = event.error;
          break;
        default:
          break;
      }
      if (event.type === 'execution/state' && event.state !== 'running') {
        for (const [key, approval] of this.approvals) {
          if (approval.connection === connection && approval.executionId === event.executionId) {
            this.approvals.delete(key);
          }
        }
        this.trimExecutions();
      }
      execution.updatedAt = Date.now();
    } catch (error) {
      this.addError(`${connection}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private registerAttachment(attachment: Attachment): WebAttachment | UnavailableWebAttachment {
    const store = this.artifactStore;
    if (store === undefined) {
      return {
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        name: attachment.name ?? 'attachment',
        unavailable: 'ArtifactStore is not running',
      };
    }
    const attempt = store.tryRegister(attachment);
    if (attempt.artifact !== undefined) {
      return toWebAttachment(attempt.artifact);
    }
    return {
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      name: attachment.name ?? 'attachment',
      unavailable: attempt.error ?? 'Artifact is unavailable',
    };
  }

  private ensureExecution(connection: string, executionId: string): MutableExecution {
    const existing = this.executions.get(executionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: MutableExecution = {
      id: executionId,
      connection,
      state: 'running',
      output: '',
      tools: [],
      attachments: [],
      error: undefined,
      updatedAt: Date.now(),
    };
    this.executions.set(executionId, created);
    this.trimExecutions();
    return created;
  }

  private touch(connection: string, executionId: string): void {
    const execution = this.ensureExecution(connection, executionId);
    execution.updatedAt = Date.now();
  }

  private trimExecutions(): void {
    if (this.executions.size <= MAX_EXECUTIONS) {
      return;
    }
    const oldest = [...this.executions.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, this.executions.size - MAX_EXECUTIONS);
    for (const execution of oldest) {
      this.executions.delete(execution.id);
    }
  }

  private addError(message: string): void {
    this.errors.push(message);
    if (this.errors.length > MAX_ERRORS) {
      this.errors.splice(0, this.errors.length - MAX_ERRORS);
    }
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    try {
      // Reject DNS-rebinding hosts: only the exact loopback URL we printed is valid.
      const expectedHost = this.info === undefined ? undefined : `127.0.0.1:${String(this.info.port)}`;
      if (expectedHost === undefined || request.headers.host?.toLowerCase() !== expectedHost) {
        this.sendJson(response, 403, { error: 'Forbidden host' });
        return;
      }
      const url = new URL(request.url ?? '/', `http://${this.host}`);
      if (request.method === 'POST' && url.pathname === '/api/prompt') {
        if (this.controlToken === undefined) {
          response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Method not allowed\n');
          return;
        }
        this.handlePrompt(request, response);
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, {
          Allow: this.controlToken === undefined ? 'GET' : 'GET, POST',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Method not allowed\n');
        return;
      }
      if (url.pathname === '/') {
        this.sendJson(response, 404, {
          error: 'not found',
          hint: 'this server exposes /api/state and /artifacts; the local UI lives in the wax-web repository',
        });
        return;
      }
      if (url.pathname === '/api/state') {
        this.sendJson(response, 200, this.getState());
        return;
      }
      const artifactMatch = ARTIFACT_PATH.exec(url.pathname);
      if (artifactMatch !== null) {
        this.sendArtifact(response, artifactMatch[1] ?? '');
        return;
      }
      this.sendJson(response, 404, { error: 'Not found' });
    } catch {
      this.sendJson(response, 500, { error: 'Internal error' });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const token = this.controlToken;
    if (token === undefined) {
      return false;
    }
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      return false;
    }
    const provided = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private handlePrompt(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request)) {
      this.sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    const limit = 64 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    request.on('data', (chunk: Buffer) => {
      if (failed) {
        return;
      }
      total += chunk.length;
      if (total > limit) {
        failed = true;
        // Stop buffering but keep the socket alive long enough for the 413 to
        // flush; destroying the request here resets chunked clients.
        request.removeAllListeners('data');
        request.pause();
        this.sendJson(response, 413, { error: 'Payload too large' });
        response.once('finish', () => {
          request.resume();
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        this.sendJson(response, 400, { error: 'Expected a JSON body' });
        return;
      }
      if (typeof payload !== 'object' || payload === null) {
        this.sendJson(response, 400, { error: 'Expected a JSON object' });
        return;
      }
      const record = payload as Record<string, unknown>;
      const connection = record.connection;
      const text = record.text;
      if (typeof connection !== 'string' || connection.trim() === '') {
        this.sendJson(response, 400, { error: 'connection is required' });
        return;
      }
      if (typeof text !== 'string' || text.trim() === '') {
        this.sendJson(response, 400, { error: 'text is required' });
        return;
      }
      if (text.length > 20_000) {
        this.sendJson(response, 400, { error: 'text is too long' });
        return;
      }
      void this.workbench
        .submit(text, connection)
        .then((execution) => {
          this.prompts.set(execution.execution.id, text);
          while (this.prompts.size > MAX_EXECUTIONS) {
            const oldest = this.prompts.keys().next().value;
            if (oldest === undefined) {
              break;
            }
            this.prompts.delete(oldest);
          }
          this.sendJson(response, 202, {
            connection: execution.connection,
            executionId: execution.execution.id,
          });
        })
        .catch((error: unknown) => {
          this.sendJson(response, 409, {
            error: error instanceof Error ? error.message : 'Submit failed',
          });
        });
    });
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(body);
  }

  private sendArtifact(response: ServerResponse, id: string): void {
    const store = this.artifactStore;
    if (store === undefined) {
      this.sendJson(response, 404, { error: 'Artifact not found' });
      return;
    }
    const artifact = store.get(id);
    const bytes = artifact === undefined ? undefined : store.read(id);
    if (artifact === undefined || bytes === undefined) {
      this.sendJson(response, 404, { error: 'Artifact not found' });
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': artifact.mimeType,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (artifact.kind === 'file') {
      headers['Content-Disposition'] = 'attachment';
    }
    response.writeHead(200, headers);
    response.end(bytes);
  }
}

function approvalKey(connection: string, executionId: string, requestId: string): string {
  return `${connection}\u0000${executionId}\u0000${requestId}`;
}

function toWebAttachment(artifact: Artifact): WebAttachment {  return {
    id: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    name: artifact.name,
    byteLength: artifact.byteLength,
    url: `/artifacts/${artifact.id}`,
  };
}
