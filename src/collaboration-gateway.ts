import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import {
  DelegationLedger,
  defaultDelegationStateDirectory,
  type LedgerEntry,
  type LedgerEntryType,
} from './delegation-ledger.js';
import {
  defaultDelegationPolicy,
  parseDelegationPolicy,
  type DelegationPolicy,
} from './delegation-policy.js';
import { SubmitOutcomeUnknownError } from './adapters/harness.js';
import { buildRecoveryNote, projectWorkItems, unsettledWorkItems, type WorkItemView } from './work-item.js';
import { SubmitFailedError, type Execution } from './workspace.js';
import type { Workbench } from './workbench.js';

export interface CollaborationGatewayOptions {
  readonly workerConnection?: string;
  readonly port?: number;
  readonly pollIntervalMs?: number;
  readonly maxTaskChars?: number;
  /** Operator policy. Defaults to allowing only the configured worker. */
  readonly policy?: DelegationPolicy;
  /** State directory for the append-only ledger. Defaults to the user state root. */
  readonly stateDirectory?: string;
  /** Allow taking over a lock whose owning process is gone. */
  readonly allowStaleLedgerLock?: boolean;
}

/** Facts that authorize this gateway instance; never derived from tool arguments. */
export interface DelegationMandate {
  readonly id: string;
  readonly requester: string;
  readonly basis: 'policy';
  readonly policyVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly allowedWorkers: readonly string[];
}

export interface CollaborationGatewayInfo {
  readonly url: string;
  readonly token: string;
  readonly workerConnection: string;
  readonly mandate: DelegationMandate;
}

export interface CollaborationRecoveryReport {
  readonly note: string;
  readonly items: readonly WorkItemView[];
  readonly tornTail: boolean;
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
 * Local HTTP surface called by the MCP delegate bridge. It performs one worker
 * submission per request and records every delegation in an append-only
 * ledger. Authorization comes from a deterministic policy and a per-instance
 * mandate; loopback binding and a bearer token identify the bridge, not the
 * authority to delegate.
 */
export class CollaborationGateway {
  private readonly workbench: Workbench;
  private readonly workerConnection: string;
  private readonly port: number;
  private readonly pollIntervalMs: number;
  private readonly policy: DelegationPolicy;
  private readonly stateDirectoryOption: string | undefined;
  private readonly allowStaleLedgerLock: boolean;
  private readonly token = randomUUID();
  private readonly host = '127.0.0.1' as const;
  private readonly sockets = new Set<Socket>();
  /** Work items started by this process and not settled yet. */
  private readonly active = new Set<string>();
  private readonly idempotency = new Map<string, string>();
  private entries: LedgerEntry[] = [];
  private items: WorkItemView[] = [];
  private tornTail = false;
  private degradedReason: string | undefined;
  private ledger: DelegationLedger | undefined;
  private mandate: DelegationMandate | undefined;
  private server: Server | undefined;
  private info: CollaborationGatewayInfo | undefined;

  constructor(workbench: Workbench, options: CollaborationGatewayOptions = {}) {
    this.workbench = workbench;
    this.workerConnection = options.workerConnection ?? 'dsh';
    this.port = options.port ?? 0;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.stateDirectoryOption = options.stateDirectory;
    this.allowStaleLedgerLock = options.allowStaleLedgerLock === true;
    this.policy = parseDelegationPolicy(
      options.policy === undefined
        ? defaultDelegationPolicy(this.workerConnection, options.maxTaskChars)
        : options.policy,
    );
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error(`port must be an integer between 0 and 65535: ${String(options.port)}`);
    }
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  get stateDirectory(): string | undefined {
    return this.ledger?.stateDirectory;
  }

  get mandateInfo(): DelegationMandate | undefined {
    return this.mandate;
  }

  /** Ledger-derived views; mutations of the returned array do not affect the gateway. */
  get workItems(): readonly WorkItemView[] {
    return this.items.map((item) => ({ ...item }));
  }

  async start(): Promise<CollaborationGatewayInfo> {
    if (this.server !== undefined) {
      throw new Error('Collaboration gateway is already running');
    }
    const stateDirectory = this.stateDirectoryOption ?? defaultDelegationStateDirectory(this.workbench.getProject().id);
    const ledger = DelegationLedger.open({
      directory: stateDirectory,
      ...(this.allowStaleLedgerLock ? { allowStaleLock: true } : {}),
    });
    try {
      this.loadLedger(ledger);
    } catch (error) {
      ledger.close();
      throw error;
    }
    // A fragment that cannot be terminated makes every append impossible; keep
    // the recovery report available and refuse new delegations with a clear
    // status instead of failing each request with an internal error.
    this.degradedReason = ledger.tornTailBlocksAppend ? 'ledger has an incomplete record' : undefined;
    const issuedAt = Date.now();
    this.mandate = {
      id: randomUUID(),
      requester: this.policy.requester,
      basis: 'policy',
      policyVersion: this.policy.policyVersion,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + this.policy.ttlMs).toISOString(),
      allowedWorkers: this.policy.allowedWorkers,
    };
    this.ledger = ledger;

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
      this.info = undefined;
      this.ledger = undefined;
      this.mandate = undefined;
      this.entries = [];
      this.items = [];
      this.active.clear();
      this.idempotency.clear();
      this.degradedReason = undefined;
      ledger.close();
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();
      try {
        server.close();
      } catch {
        // The server never reached listening state.
      }
      throw error;
    }
    const address = server.address() as AddressInfo;
    this.info = {
      url: `http://${this.host}:${String(address.port)}/delegate`,
      token: this.token,
      workerConnection: this.workerConnection,
      mandate: this.mandate,
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
    const ledger = this.ledger;
    this.ledger = undefined;
    // Unsettled work items stay unsettled in the ledger on purpose: a stop in
    // the middle of a delegation must remain visible for manual recovery.
    ledger?.close();
  }

  /** Work items that still need manual settlement, plus the guidance for it. */
  getRecoveryReport(): CollaborationRecoveryReport {
    const items = unsettledWorkItems(this.items);
    const tornTail = this.ledger?.readAll().tornTail ?? this.tornTail;
    return { note: buildRecoveryNote(items), items, tornTail };
  }

  /**
   * A manually repaired tail should not require a restart: while degraded,
   * re-read the ledger and resync derived state once the tail is appendable.
   */
  private refreshDegraded(): void {
    if (this.degradedReason === undefined) {
      return;
    }
    const ledger = this.ledger;
    if (ledger === undefined || this.active.size > 0) {
      return;
    }
    const read = ledger.refresh();
    if (read.tornTail && !read.tornTailAppendable) {
      return;
    }
    this.loadLedger(ledger);
    this.degradedReason = undefined;
  }

  private loadLedger(ledger: DelegationLedger): void {
    const read = ledger.readAll();
    this.entries = [...read.entries];
    this.tornTail = read.tornTail;
    this.items = projectWorkItems(this.entries);
    this.active.clear();
    this.idempotency.clear();
    // Historical unsettled items are recovery candidates, not running work:
    // they must never consume the concurrency slot of this process.
    for (const item of this.items) {
      if (item.idempotencyKey !== undefined) {
        this.idempotency.set(item.idempotencyKey, item.id);
      }
    }
  }

  private appendEntry(type: LedgerEntryType, data: Readonly<Record<string, unknown>>): void {
    const ledger = this.ledger;
    if (ledger === undefined) {
      throw new CollaborationGatewayError('Delegation ledger is not open', 500);
    }
    const entry = ledger.append(type, data);
    this.entries.push(entry);
    this.items = projectWorkItems(this.entries);
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
    if (!this.authorized(authorization)) {
      throw new CollaborationGatewayError('Unauthorized', 401);
    }
    const mandate = this.mandate;
    if (mandate === undefined) {
      throw new CollaborationGatewayError('Delegation gateway is not running', 503);
    }
    this.refreshDegraded();
    if (this.degradedReason !== undefined) {
      throw new CollaborationGatewayError(
        `Delegation ledger needs manual repair: ${this.degradedReason}`,
        503,
      );
    }

    const body = await readBody(request, this.policy.maxTaskChars * 4 + 1024);
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
      // Authorization claims are rejected here: only the operator policy decides.
      throw new CollaborationGatewayError(`Unknown fields: ${extra.join(', ')}`, 400);
    }
    const requestedWorker = record.worker;
    if (requestedWorker !== undefined && (typeof requestedWorker !== 'string' || requestedWorker.length > 64)) {
      throw new CollaborationGatewayError('worker must be a bounded string', 400);
    }
    const worker =
      typeof requestedWorker === 'string' && requestedWorker.trim() !== ''
        ? requestedWorker
        : this.workerConnection;

    // Contract order: worker allowlist first, so an unauthorized worker cannot
    // probe task bounds or receive a more permissive error.
    if (!this.policy.allowedWorkers.includes(worker)) {
      this.recordRejection('worker-not-allowed', worker);
      throw new CollaborationGatewayError(`Worker is not allowed by policy: ${worker}`, 403);
    }
    const task = record.task;
    if (typeof task !== 'string' || task.trim() === '' || task.length > this.policy.maxTaskChars) {
      throw new CollaborationGatewayError('task must be a non-empty bounded string', 400);
    }
    if (Date.parse(mandate.expiresAt) <= Date.now()) {
      this.recordRejection('mandate-expired', mandate.policyVersion);
      throw new CollaborationGatewayError('Delegation mandate has expired', 403);
    }
    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey !== undefined) {
      const existing = this.idempotency.get(idempotencyKey);
      if (existing !== undefined) {
        const item = this.items.find((entry) => entry.id === existing);
        throw new CollaborationGatewayError(
          `Duplicate delegation key ${idempotencyKey} for work item ${existing} (state: ${item?.state ?? 'unknown'})`,
          409,
        );
      }
    }
    if (this.active.size >= this.policy.maxConcurrent) {
      throw new CollaborationGatewayError(
        `Delegation concurrency limit reached (${String(this.policy.maxConcurrent)})`,
        409,
      );
    }
    if (this.workbench.getConnection(worker)?.status !== 'ready') {
      throw new CollaborationGatewayError(`Worker connection is not available: ${worker}`, 409);
    }

    const workItemId = randomUUID();
    this.appendEntry('work-item/created', {
      id: workItemId,
      mandateId: mandate.id,
      requester: mandate.requester,
      basis: mandate.basis,
      policyVersion: mandate.policyVersion,
      worker,
      taskLength: task.length,
      taskDigest: createHash('sha256').update(task).digest('hex'),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    this.active.add(workItemId);
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, workItemId);
    }

    let clientGone = false;
    let executionId: string | undefined;
    let cancelFailure: string | undefined;
    const tryCancel = async (): Promise<void> => {
      if (executionId === undefined) {
        return;
      }
      try {
        await this.workbench.cancel(worker, executionId);
      } catch (error) {
        cancelFailure = messageOf(error);
      }
    };
    const onClose = (): void => {
      if (response.writableEnded) {
        return;
      }
      clientGone = true;
      void tryCancel();
    };
    // Installed before submit: a disconnect during submission must not be lost.
    response.once('close', onClose);
    try {
      this.appendEntry('delivery/intent', { id: workItemId });
      let submitted;
      try {
        submitted = await this.workbench.submit(task, worker);
      } catch (error) {
        // A definite rejection did not start work; an unknown outcome may have.
        // Never collapse the two into one "failed" record.
        if (error instanceof SubmitOutcomeUnknownError) {
          this.settle(workItemId, 'unknown', messageOf(error), error.executionId);
          throw new CollaborationGatewayError(`Worker submit outcome is unknown: ${messageOf(error)}`, 503);
        }
        if (error instanceof SubmitFailedError) {
          this.settle(workItemId, 'failed', messageOf(error), error.executionId);
          throw new CollaborationGatewayError(`Worker failed to accept the task: ${messageOf(error)}`, 502);
        }
        this.settle(workItemId, 'failed', messageOf(error));
        throw new CollaborationGatewayError(`Worker submission rejected: ${messageOf(error)}`, 409);
      }
      executionId = submitted.execution.id;
      if (response.destroyed) {
        clientGone = true;
      }
      // Record the execution before handling the disconnect: if a worker may
      // have started, the ledger must be able to name it.
      this.appendEntry('delivery/submitted', { id: workItemId, executionId });
      if (clientGone) {
        await tryCancel();
        this.settle(
          workItemId,
          cancelFailure === undefined ? 'cancelled' : 'unknown',
          cancelFailure === undefined
            ? 'client disconnected; worker cancelled'
            : `client disconnected; cancel failed: ${cancelFailure}`,
          executionId,
        );
        throw new CollaborationGatewayError('Client disconnected', 499);
      }

      let execution: Execution;
      try {
        execution = await this.waitForTerminal(worker, executionId);
      } catch (error) {
        this.settle(workItemId, 'unknown', messageOf(error), executionId);
        throw new CollaborationGatewayError(
          `Worker execution is no longer available: ${messageOf(error)}`,
          502,
        );
      }
      if (clientGone) {
        this.settle(
          workItemId,
          cancelFailure === undefined ? settleState(execution.state) : 'unknown',
          cancelFailure === undefined
            ? 'client disconnected'
            : `client disconnected; cancel failed: ${cancelFailure}`,
          executionId,
        );
        throw new CollaborationGatewayError('Client disconnected', 499);
      }
      this.settle(workItemId, settleState(execution.state), execution.error, executionId);
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
        workItemId,
        mandateId: mandate.id,
      });
    } finally {
      response.off('close', onClose);
      this.active.delete(workItemId);
    }
  }

  private settle(
    workItemId: string,
    state: string,
    error: string | undefined,
    executionId?: string,
  ): void {
    this.appendEntry('delivery/settled', {
      id: workItemId,
      state,
      ...(error === undefined ? {} : { error: capText(error, MAX_ERROR_CHARS) }),
      ...(executionId === undefined ? {} : { executionId }),
    });
  }

  /** Rejections after authentication are auditable; unauthenticated spam is not. */
  private recordRejection(code: string, detail: string): void {
    try {
      this.appendEntry('gate/rejected', { code, detail: capText(detail, MAX_DETAIL_CHARS) });
    } catch {
      // The rejection still stands even if the audit record cannot be written.
    }
  }

  private authorized(header: string | undefined): boolean {
    if (header === undefined) {
      return false;
    }
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async waitForTerminal(connection: string, executionId: string): Promise<Execution> {
    while (true) {
      const found = this.workbench.getExecution(connection, executionId);
      if (found === undefined) {
        throw new Error('Worker execution is no longer available');
      }
      if (found.execution.state !== 'running') {
        return found.execution;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent || response.destroyed || response.writableEnded) {
      return;
    }
    const body = JSON.stringify(value);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 413 ? { Connection: 'close' } : {}),
    });
    response.end(body);
  }
}

function settleState(state: Execution['state']): 'completed' | 'failed' | 'cancelled' | 'unknown' {
  switch (state) {
    case 'completed':
    case 'failed':
    case 'cancelled':
      return state;
    default:
      return 'unknown';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ledger entries stay bounded: worker text is model-controlled. */
function capText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  // Reserve room for the ellipsis so the stored string never exceeds `limit`.
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

const MAX_ERROR_CHARS = 2000;
const MAX_DETAIL_CHARS = 64;

function readIdempotencyKey(request: IncomingMessage): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new CollaborationGatewayError('Idempotency-Key must be 1-128 of [A-Za-z0-9._:-]', 400);
  }
  return value;
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      if (failed) {
        return;
      }
      size += chunk.byteLength;
      if (size > limit) {
        failed = true;
        request.removeListener('data', onData);
        // Keep draining after writing the response. Destroying the socket here
        // would make the 413 unreachable for the client.
        request.resume();
        reject(new CollaborationGatewayError('Request body too large', 413));
        return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.on('end', () => {
      if (!failed) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', reject);
  });
}
