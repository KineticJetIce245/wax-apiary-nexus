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
        this.sendHtml(response);
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

  private sendHtml(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(PAGE);
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

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unified Workspace — local view</title>
<style>
  /* Visual language follows DSH ui-theme (MIT): dark semantic tokens,
     hairlines, 8/12/16px radii, system + code stacks. No DSH runtime is loaded. */
  :root {
    color-scheme: dark;
    --bg-base: #151517;
    --bg-layer-1: #232324;
    --bg-layer-2: #2c2c2e;
    --bg-layer-3: #353638;
    --label-primary: #f9fafb;
    --label-secondary: #cfd3d6;
    --label-tertiary: #adb2b8;
    --border-l1: rgba(255, 255, 255, 0.06);
    --border-l2: rgba(255, 255, 255, 0.12);
    --border-l3: rgba(255, 255, 255, 0.16);
    --link: #7aaaff;
    --accent: #5686fe;
    --success: #4ed17e;
    --warning: #f7ad31;
    --danger: #f25a5a;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    --mono: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Microsoft YaHei', monospace;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --shadow-panel: 0 0 0 0.5px var(--border-l1), 0 12px 32px rgba(0, 0, 0, 0.24);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg-base);
    color: var(--label-primary);
    font: 14px/1.55 var(--font);
    -webkit-font-smoothing: antialiased;
  }
  .app { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100%; }
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 18px 14px;
    background: var(--bg-layer-1);
    border-right: 0.5px solid var(--border-l1);
    min-width: 0;
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 2px 6px 10px; }
  .brand-mark {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: var(--radius-sm);
    background: linear-gradient(145deg, var(--accent), #8cb8ff);
    color: #fff;
    font-weight: 600;
    font-size: 15px;
    box-shadow: 0 4px 14px rgba(86, 134, 254, 0.28);
  }
  .brand-name { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; }
  .brand-sub { font-size: 11px; color: var(--label-tertiary); margin-top: 1px; }
  .nav-caption {
    padding: 0 8px;
    margin-bottom: 6px;
    color: var(--label-tertiary);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .connections { display: flex; flex-direction: column; gap: 2px; }
  .connection {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px;
    border-radius: var(--radius-sm);
    color: var(--label-secondary);
  }
  .connection:hover { background: rgba(255, 255, 255, 0.04); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--label-tertiary); flex: none; }
  .dot.ready { background: var(--success); box-shadow: 0 0 0 3px rgba(78, 209, 126, 0.12); }
  .dot.busy { background: var(--warning); }
  .conn-name { font-size: 13px; }
  .conn-state { margin-left: auto; font: 11px var(--mono); color: var(--label-tertiary); }
  .sidebar-footer {
    margin-top: auto;
    padding: 12px 8px 2px;
    border-top: 0.5px solid var(--border-l1);
    color: var(--label-tertiary);
    font-size: 11px;
    line-height: 1.6;
  }
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    height: 64px;
    padding: 0 28px;
    border-bottom: 0.5px solid var(--border-l1);
    flex: none;
  }
  .topbar h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.01em; }
  .topbar-sub { margin-top: 2px; color: var(--label-tertiary); font-size: 11px; }
  .live {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--label-tertiary);
    font: 11px var(--mono);
    border: 0.5px solid var(--border-l2);
    border-radius: 999px;
    padding: 4px 10px;
  }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
  .scroll { flex: 1; min-height: 0; overflow: auto; padding: 24px 28px 44px; }
  .content { width: 100%; max-width: 840px; margin: 0 auto; }
  .approval {
    margin-bottom: 12px;
    padding: 12px 14px;
    border: 1px solid rgba(247, 173, 49, 0.32);
    background: rgba(247, 173, 49, 0.08);
    border-radius: var(--radius-md);
    color: #f3d9a3;
  }
  .approval strong { display: block; margin-bottom: 2px; font-size: 12px; font-weight: 600; }
  .approval span { color: #d9c39a; font-size: 12px; }
  .error { margin-bottom: 10px; color: var(--danger); font-size: 12px; }
  .turn {
    margin-bottom: 14px;
    padding: 16px 18px;
    background: var(--bg-layer-1);
    border: 0.5px solid var(--border-l2);
    border-radius: var(--radius-md);
  }
  .turn-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .who { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .avatar {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--bg-layer-3);
    color: var(--label-secondary);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    flex: none;
  }
  .who-name { font-size: 13px; font-weight: 600; color: var(--label-primary); }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--label-tertiary);
    font: 11px var(--mono);
    border: 0.5px solid var(--border-l2);
    border-radius: 999px;
    padding: 3px 8px;
  }
  .state::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--label-tertiary); }
  .state-completed { color: #9ee6b5; border-color: rgba(78, 209, 126, 0.28); }
  .state-completed::before { background: var(--success); }
  .state-running { color: #a9c9ff; border-color: rgba(122, 170, 255, 0.3); }
  .state-running::before { background: var(--link); }
  .state-failed { color: #ffb0b0; border-color: rgba(242, 90, 90, 0.3); }
  .state-failed::before { background: var(--danger); }
  .state-cancelled, .state-unknown { color: #f3d9a3; border-color: rgba(247, 173, 49, 0.28); }
  .state-cancelled::before, .state-unknown::before { background: var(--warning); }
  .output {
    margin: 12px 0 0;
    color: var(--label-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 14px;
    line-height: 1.72;
  }
  .output.empty { color: var(--label-tertiary); font-style: italic; }
  .tools { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
  .tool {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 6px;
    background: var(--bg-layer-2);
    color: var(--label-tertiary);
    font: 11px/1.5 var(--mono);
  }
  .tool-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-status { margin-left: auto; color: var(--label-tertiary); flex: none; }
  .attachments { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .attachment { max-width: 100%; }
  .attachment-image {
    display: block;
    max-width: 100%;
    max-height: 420px;
    object-fit: contain;
    border-radius: var(--radius-sm);
    border: 0.5px solid var(--border-l2);
    background: #0f0f11;
  }
  .attachment-caption { margin-top: 5px; color: var(--label-tertiary); font: 11px var(--mono); overflow-wrap: anywhere; }
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border: 0.5px solid var(--border-l2);
    border-radius: var(--radius-sm);
    color: var(--link);
    text-decoration: none;
    font: 12px var(--mono);
  }
  .file-chip:hover { background: rgba(122, 170, 255, 0.08); text-decoration: underline; text-underline-offset: 3px; }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 96px 20px;
    color: var(--label-tertiary);
    text-align: center;
  }
  .empty-mark {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    border: 0.5px solid var(--border-l2);
    background: var(--bg-layer-1);
    display: grid;
    place-items: center;
    color: var(--label-tertiary);
    font: 16px var(--mono);
  }
  .empty strong { color: var(--label-secondary); font-weight: 500; font-size: 14px; }
  .empty span { font-size: 12px; }
  .footer-note { margin-top: 24px; color: var(--label-tertiary); font-size: 11px; text-align: center; }
  .composer {
    display: flex; gap: 10px; align-items: flex-end; flex: none;
    padding: 12px 16px 16px; border-top: 0.5px solid var(--border-l1);
    background: var(--bg-layer-1);
  }
  .composer[hidden] { display: none; }
  .composer select, .composer textarea {
    background: var(--bg-base); color: var(--label-primary);
    border: 0.5px solid var(--border-l2); border-radius: var(--radius-sm);
    padding: 9px 11px; font: 13px system-ui, sans-serif;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .composer select { min-width: 132px; }
  .composer textarea { flex: 1; resize: none; min-height: 42px; max-height: 132px; line-height: 1.45; }
  .composer select:focus, .composer textarea:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(86, 134, 254, 0.18);
  }
  .composer button {
    flex: none; padding: 10px 16px; border-radius: var(--radius-sm); border: 0;
    background: var(--accent); color: #fff; cursor: pointer;
    font: 600 13px system-ui, sans-serif;
  }
  .composer button:hover { filter: brightness(1.06); }
  .composer button:disabled { opacity: 0.45; cursor: default; filter: none; }
  .send-status { font-size: 11px; color: var(--label-tertiary); min-width: 84px; padding-bottom: 11px; }
  .turn.user {
    background: rgba(86, 134, 254, 0.10);
    border-color: rgba(86, 134, 254, 0.34);
  }
  .user-text {
    white-space: pre-wrap; overflow-wrap: anywhere;
    font-size: 14px; line-height: 1.65; margin-top: 6px;
  }
  @media (max-width: 760px) {
    .app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); height: auto; min-height: 100%; }
    .sidebar { border-right: 0; border-bottom: 0.5px solid var(--border-l1); gap: 10px; }
    .connections { flex-direction: row; flex-wrap: wrap; }
    .connection { padding: 5px 7px; }
    .sidebar-footer { display: none; }
    .main { min-height: 70vh; }
    .scroll { padding: 16px 14px 32px; }
    .topbar { padding: 0 16px; height: 58px; }
    .composer { flex-wrap: wrap; }
    .composer textarea { flex-basis: 100%; order: -1; }
    .send-status { padding-bottom: 0; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">U</div>
      <div>
        <div class="brand-name">Unified Workspace</div>
        <div class="brand-sub">local view</div>
      </div>
    </div>
    <div>
      <div class="nav-caption">连接</div>
      <div id="connections" class="connections"></div>
    </div>
    <div class="sidebar-footer">
      本地视图 · 每秒刷新<br>提交需要页面 token；审批请在 CLI。
    </div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div>
        <h1>协作记录</h1>
        <div class="topbar-sub"><span id="session">本地会话</span> · 文本 · 工具 · 图片 · 文件</div>
      </div>
      <div class="live"><span class="live-dot"></span><span id="count">0</span> 条</div>
    </header>
    <div class="scroll">
      <div class="content">
        <div id="approvals"></div>
        <div id="errors"></div>
        <div id="executions"></div>
        <div class="footer-note">审批和取消仍通过 CLI；本页只提交文本。</div>
      </div>
    </div>
    <div id="composer" class="composer" hidden>
      <select id="target" aria-label="连接"></select>
      <textarea id="prompt" rows="2" placeholder="输入内容，Enter 发送，Shift+Enter 换行"></textarea>
      <button id="send" type="button">发送</button>
      <div id="send-status" class="send-status"></div>
    </div>
  </main>
</div>
<script>
'use strict';
const executions = document.getElementById('executions');
const connections = document.getElementById('connections');
const approvals = document.getElementById('approvals');
const errors = document.getElementById('errors');
const count = document.getElementById('count');
const session = document.getElementById('session');
const scrollEl = document.querySelector('.scroll');
const composer = document.getElementById('composer');
const target = document.getElementById('target');
const promptInput = document.getElementById('prompt');
const sendButton = document.getElementById('send');
const sendStatus = document.getElementById('send-status');
const controlToken = new URLSearchParams(location.search).get('token');
if (controlToken) {
  composer.hidden = false;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stateClass(value) {
  return value === 'completed' ? 'state-completed'
    : value === 'running' ? 'state-running'
    : value === 'failed' ? 'state-failed'
    : 'state-cancelled';
}

function renderConnection(connection) {
  const row = el('div', 'connection');
  const dot = el('span', 'dot ' + (connection.status === 'ready' ? 'ready' : ''));
  row.append(dot, el('span', 'conn-name', connection.name), el('span', 'conn-state', connection.status));
  return row;
}

function renderExecution(execution) {
  const group = el('div', 'execution-group');
  if (execution.prompt) {
    const userTurn = el('article', 'turn user');
    const userHead = el('div', 'turn-head');
    const userWho = el('div', 'who');
    userWho.append(el('span', 'avatar', '我'), el('span', 'who-name', '你'));
    userHead.append(userWho);
    userTurn.append(userHead, el('div', 'user-text', execution.prompt));
    group.append(userTurn);
  }
  const turn = el('article', 'turn');
  const head = el('div', 'turn-head');
  const who = el('div', 'who');
  const avatar = el('span', 'avatar', execution.connection.slice(0, 1));
  who.append(avatar, el('span', 'who-name', execution.connection));
  head.append(who, el('span', 'state ' + stateClass(execution.state), execution.state));
  turn.append(head);

  const output = el('div', 'output' + (execution.output ? '' : ' empty'), execution.output || '暂无文本输出');
  turn.append(output);

  if (execution.tools.length > 0) {
    const tools = el('div', 'tools');
    for (const tool of execution.tools) {
      const row = el('div', 'tool');
      row.append(el('span', 'tool-title', tool.title), el('span', 'tool-status', tool.status));
      tools.append(row);
    }
    turn.append(tools);
  }

  if (execution.attachments.length > 0) {
    const box = el('div', 'attachments');
    for (const attachment of execution.attachments) {
      const item = el('div', 'attachment');
      if ('unavailable' in attachment) {
        item.append(el('div', 'attachment-caption', attachment.name + ' 不可用：' + attachment.unavailable));
      } else if (attachment.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'attachment-image';
        img.src = attachment.url;
        img.alt = attachment.name;
        img.loading = 'lazy';
        item.append(img, el('div', 'attachment-caption', attachment.name));
      } else {
        const link = document.createElement('a');
        link.className = 'file-chip';
        link.href = attachment.url;
        link.download = attachment.name;
        link.textContent = attachment.name;
        item.append(link);
      }
      box.append(item);
    }
    turn.append(box);
  }

  if (execution.error) turn.append(el('div', 'error', execution.error));
  group.append(turn);
  return group;
}

let targetInitialised = false;
function renderTargets(list) {
  const current = target.value;
  target.replaceChildren(...list.map((connection) => {
    const option = document.createElement('option');
    option.value = connection.name;
    option.textContent = connection.name +
      (connection.conversationId ? ' · ' + connection.conversationId.slice(0, 8) : '');
    return option;
  }));
  if (list.some((connection) => connection.name === current)) {
    target.value = current;
  } else if (!targetInitialised && list.length > 0) {
    target.value = list[0].name;
  }
  targetInitialised = true;
}

function render(state) {
  const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
  count.textContent = String(state.executions.length);
  connections.replaceChildren(...state.connections.map(renderConnection));
  renderTargets(state.connections);
  const active = state.connections.find((connection) => connection.name === target.value) ?? state.connections[0];
  session.textContent = active
    ? active.name + (active.conversationId ? ' · ' + active.conversationId.slice(0, 8) : '')
    : '本地会话';
  approvals.replaceChildren(...state.approvals.map((approval) => {
    const box = el('div', 'approval');
    box.append(el('strong', '', '审批等待（只读）'), el('span', '', approval.connection + ' · ' + approval.summary));
    return box;
  }));
  errors.replaceChildren(...state.errors.map((message) => el('div', 'error', message)));
  if (state.executions.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'empty-mark', '∅'), el('strong', '', '还没有执行记录'), el('span', '', '在下方输入一条消息，发送后会出现在这里。'));
    executions.replaceChildren(empty);
    return;
  }
  executions.replaceChildren(...state.executions.map(renderExecution));
  if (nearBottom) {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }
}

async function sendPrompt() {
  const text = promptInput.value.trim();
  if (!controlToken) {
    sendStatus.textContent = '缺少 token';
    return;
  }
  if (text === '') {
    return;
  }
  sendButton.disabled = true;
  sendStatus.textContent = '发送中…';
  try {
    const response = await fetch('/api/prompt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + controlToken,
      },
      body: JSON.stringify({ connection: target.value, text }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      sendStatus.textContent = body.error || ('HTTP ' + response.status);
      return;
    }
    promptInput.value = '';
    sendStatus.textContent = '已提交 ' + String(body.executionId || '').slice(0, 8);
    await refresh();
  } catch (error) {
    sendStatus.textContent = '发送失败';
  } finally {
    sendButton.disabled = false;
  }
}
sendButton.addEventListener('click', () => { void sendPrompt(); });
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendPrompt();
  }
});

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    render(await response.json());
  } catch (error) {
    errors.replaceChildren(el('div', 'error', '无法读取状态：' + error.message));
  }
}
refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>`;
