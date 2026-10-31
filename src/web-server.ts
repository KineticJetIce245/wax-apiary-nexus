import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { ArtifactStore, type Artifact, type ArtifactStoreOptions } from './artifact-store.js';
import type { Attachment, AttachmentKind } from './content.js';
import type { TaggedWorkspaceEvent, Workbench } from './workbench.js';

const MAX_EXECUTIONS = 50;
const MAX_TOOLS_PER_EXECUTION = 50;
const MAX_ERRORS = 20;
const ARTIFACT_PATH = /^\/artifacts\/([a-f0-9]{64})$/;

export interface WebServerOptions {
  readonly port?: number;
  readonly maxArtifactBytes?: number;
  readonly artifactRoot?: string;
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
  private readonly artifactStore: ArtifactStore;
  private readonly port: number;
  private readonly host = '127.0.0.1' as const;
  private readonly executions = new Map<string, MutableExecution>();
  private readonly approvals = new Map<string, WebApproval>();
  private readonly errors: string[] = [];
  private readonly sockets = new Set<Socket>();
  private unsubscribe: (() => void) | undefined;
  private server: Server | undefined;
  private info: WebServerInfo | undefined;

  constructor(workbench: Workbench, options: WebServerOptions = {}) {
    this.workbench = workbench;
    this.port = options.port ?? 0;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error(`port must be an integer between 0 and 65535: ${String(options.port)}`);
    }
    const artifactOptions: ArtifactStoreOptions = {
      ...(options.artifactRoot === undefined ? {} : { root: options.artifactRoot }),
      ...(options.maxArtifactBytes === undefined ? {} : { maxBytes: options.maxArtifactBytes }),
    };
    this.artifactStore = new ArtifactStore(artifactOptions);
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
      this.artifactStore.close();
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
    this.artifactStore.close();
  }

  getState(): WebState {
    return {
      generatedAt: new Date().toISOString(),
      connections: this.workbench.connectionNames.flatMap((name) => {
        const connection = this.workbench.getConnection(name);
        return connection === undefined ? [] : [{ name, status: connection.status }];
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
        this.approvals.set(event.request.requestId, {
          connection,
          executionId: event.request.executionId,
          requestId: event.request.requestId,
          summary: event.request.summary,
        });
        this.touch(connection, event.request.executionId);
        return;
      }
      if (event.type === 'execution/approval-decided') {
        this.approvals.delete(event.requestId);
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
        for (const [requestId, approval] of this.approvals) {
          if (approval.executionId === event.executionId) {
            this.approvals.delete(requestId);
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
    const attempt = this.artifactStore.tryRegister(attachment);
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
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method not allowed\n');
        return;
      }
      const url = new URL(request.url ?? '/', `http://${this.host}`);
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
    const artifact = this.artifactStore.get(id);
    const bytes = artifact === undefined ? undefined : this.artifactStore.read(id);
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

function toWebAttachment(artifact: Artifact): WebAttachment {
  return {
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
<title>Unified Workspace — read only</title>
<style>
  :root { color-scheme: dark; --bg:#0e1420; --card:#172033; --line:#2b3850; --text:#dce7f7; --muted:#8fa3c0; --accent:#78b7ff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--text); font:14px/1.55 system-ui, sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin-bottom:18px; }
  .connections { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
  .pill { border:1px solid var(--line); border-radius:999px; padding:3px 10px; color:var(--muted); }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .head { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
  .state { font-size:12px; color:var(--muted); }
  .output { white-space:pre-wrap; overflow-wrap:anywhere; margin:10px 0; }
  .muted { color:var(--muted); }
  .tools { margin:8px 0; padding-left:18px; color:var(--muted); }
  .attachments { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
  .attachment { border:1px solid var(--line); border-radius:8px; padding:8px; max-width:100%; }
  .attachment img { max-width:100%; height:auto; display:block; border-radius:4px; }
  .attachment a { color:var(--accent); }
  .error { color:#ff9a9a; }
  .approval { border:1px solid #6b5a2a; background:#2a2415; border-radius:8px; padding:10px; margin-bottom:12px; }
  .empty { color:var(--muted); padding:20px 0; }
</style>
</head>
<body>
<h1>Unified Workspace</h1>
<div class="sub">只读本地视图 · 每秒刷新 · 不能提交或审批</div>
<div id="connections" class="connections"></div>
<div id="approvals"></div>
<div id="errors"></div>
<div id="executions" class="grid"></div>
<script>
'use strict';
const executions = document.getElementById('executions');
const connections = document.getElementById('connections');
const approvals = document.getElementById('approvals');
const errors = document.getElementById('errors');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(state) {
  connections.replaceChildren(...state.connections.map((c) => el('span', 'pill', c.name + ' · ' + c.status)));
  approvals.replaceChildren(...state.approvals.map((a) => {
    const box = el('div', 'approval');
    box.append(el('strong', '', '审批等待（只读） '), el('span', '', a.connection + ' · ' + a.summary));
    return box;
  }));
  errors.replaceChildren(...state.errors.map((message) => el('div', 'error', message)));
  if (state.executions.length === 0) {
    executions.replaceChildren(el('div', 'empty', '还没有执行记录。'));
    return;
  }
  executions.replaceChildren(...state.executions.map((execution) => {
    const card = el('div', 'card');
    const head = el('div', 'head');
    head.append(el('strong', '', execution.connection), el('span', 'state', execution.state));
    card.append(head);
    const output = el('div', 'output', execution.output || '（暂无文本输出）');
    card.append(output);
    if (execution.tools.length > 0) {
      const list = el('ul', 'tools');
      for (const tool of execution.tools) list.append(el('li', '', tool.title + ' · ' + tool.status));
      card.append(list);
    }
    if (execution.attachments.length > 0) {
      const box = el('div', 'attachments');
      for (const attachment of execution.attachments) {
        const item = el('div', 'attachment');
        if ('unavailable' in attachment) {
          item.append(el('div', 'muted', attachment.name + ' 不可用：' + attachment.unavailable));
        } else if (attachment.kind === 'image') {
          const img = document.createElement('img');
          img.src = attachment.url;
          img.alt = attachment.name;
          img.loading = 'lazy';
          item.append(img, el('div', 'muted', attachment.name));
        } else {
          const link = document.createElement('a');
          link.href = attachment.url;
          link.download = attachment.name;
          link.textContent = attachment.name;
          item.append(link);
        }
        box.append(item);
      }
      card.append(box);
    }
    if (execution.error) card.append(el('div', 'error', execution.error));
    return card;
  }));
}

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    render(await response.json());
  } catch (error) {
    errors.replaceChildren(el('div', 'error', '无法读取状态：' + error.message));
  }
  setTimeout(refresh, 1000);
}
refresh();
</script>
</body>
</html>`;
