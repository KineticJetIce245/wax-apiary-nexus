import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { isAbsolute, join, relative } from 'node:path';

import {
  DelegationLedger,
  defaultDelegationStateDirectory,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerReadResult,
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
  /** Upper bound for a background (async) delegation; default 30 minutes. */
  readonly asyncTimeoutMs?: number;
  /** Cap for the stored async result file; default 256 KiB. */
  readonly resultMaxBytes?: number;
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
  private readonly asyncTimeoutMs: number;
  private readonly resultMaxBytes: number;
  private readonly token = randomUUID();
  private readonly host = '127.0.0.1' as const;
  private readonly sockets = new Set<Socket>();
  /** Work items started by this process and not settled yet. */
  private readonly active = new Set<string>();
  private readonly idempotency = new Map<string, string>();
  /** Background delegations owned by this process, keyed by work item id. */
  private readonly background = new Map<
    string,
    { readonly worker: string; readonly executionId: string; readonly controller: AbortController }
  >();
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
    this.asyncTimeoutMs = options.asyncTimeoutMs ?? 30 * 60 * 1000;
    this.resultMaxBytes = options.resultMaxBytes ?? 256 * 1024;
    if (!Number.isInteger(this.asyncTimeoutMs) || this.asyncTimeoutMs < 1) {
      throw new Error('asyncTimeoutMs must be a positive integer');
    }
    if (!Number.isInteger(this.resultMaxBytes) || this.resultMaxBytes < 1) {
      throw new Error('resultMaxBytes must be a positive integer');
    }
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
    // Stop background delegations instead of leaving workers running with no
    // gateway to report them: abort the wait, cancel best-effort, and record
    // the attempt as unknown before the ledger closes.
    const pending = [...this.background.entries()];
    this.background.clear();
    for (const [, entry] of pending) {
      entry.controller.abort();
    }
    for (const [workItemId, entry] of pending) {
      try {
        await this.workbench.cancel(entry.worker, entry.executionId);
      } catch {
        // Best effort: the ledger still records that the outcome is unknown.
      }
      this.settleSafely(
        workItemId,
        'unknown',
        'gateway stopped before the delegation settled',
        entry.executionId,
      );
      this.active.delete(workItemId);
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
    let read: LedgerReadResult;
    try {
      read = ledger.refresh();
    } catch {
      // Reopening the repaired path failed; stay degraded instead of writing
      // through a descriptor that may point at a removed file.
      return;
    }
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
    const method = request.method ?? 'GET';
    const url = request.url ?? '';
    const statusMatch = /^\/delegations\/([^/]+)$/.exec(url);
    if (method !== 'POST' && method !== 'GET') {
      response.setHeader('Allow', 'POST, GET');
      throw new CollaborationGatewayError('Method not allowed', 405);
    }
    const isSync = method === 'POST' && url === '/delegate';
    const isAsync = method === 'POST' && url === '/delegations';
    const isStatus = method === 'GET' && statusMatch !== null;
    if (!isSync && !isAsync && !isStatus) {
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
    if (isStatus) {
      let workItemId: string;
      try {
        workItemId = decodeURIComponent(statusMatch?.[1] ?? '');
      } catch {
        throw new CollaborationGatewayError('Invalid work item id', 400);
      }
      this.sendDelegationStatus(response, workItemId);
      return;
    }
    const prepared = await this.readDelegationRequest(request, mandate);
    if (isAsync) {
      await this.startAsyncDelegation(response, prepared);
      return;
    }
    await this.runSyncDelegation(response, prepared);
  }

  /** Parse and gate one delegation request; shared by the sync and async paths. */
  private async readDelegationRequest(
    request: IncomingMessage,
    mandate: DelegationMandate,
  ): Promise<PreparedDelegation> {
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
    return { task, worker, idempotencyKey, mandate };
  }

  private createWorkItem(prepared: PreparedDelegation): string {
    const { task, worker, idempotencyKey, mandate } = prepared;
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
    return workItemId;
  }

  private submitFailure(workItemId: string, error: unknown): CollaborationGatewayError {
    // A definite rejection did not start work; an unknown outcome may have.
    // Never collapse the two into one "failed" record.
    if (error instanceof SubmitOutcomeUnknownError) {
      this.settle(workItemId, 'unknown', messageOf(error), error.executionId);
      return new CollaborationGatewayError(`Worker submit outcome is unknown: ${messageOf(error)}`, 503);
    }
    if (error instanceof SubmitFailedError) {
      this.settle(workItemId, 'failed', messageOf(error), error.executionId);
      return new CollaborationGatewayError(`Worker failed to accept the task: ${messageOf(error)}`, 502);
    }
    this.settle(workItemId, 'failed', messageOf(error));
    return new CollaborationGatewayError(`Worker submission rejected: ${messageOf(error)}`, 409);
  }

  private async runSyncDelegation(
    response: ServerResponse,
    prepared: PreparedDelegation,
  ): Promise<void> {
    const { task, worker, mandate } = prepared;
    const workItemId = this.createWorkItem(prepared);

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
        throw this.submitFailure(workItemId, error);
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

  /**
   * Accept the delegation, answer 202, and settle it in the background. The
   * HTTP connection ending no longer means the work should stop.
   */
  private async startAsyncDelegation(
    response: ServerResponse,
    prepared: PreparedDelegation,
  ): Promise<void> {
    const { task, worker } = prepared;
    const workItemId = this.createWorkItem(prepared);
    try {
      this.appendEntry('delivery/intent', { id: workItemId });
      let submitted;
      try {
        submitted = await this.workbench.submit(task, worker);
      } catch (error) {
        throw this.submitFailure(workItemId, error);
      }
      const executionId = submitted.execution.id;
      this.appendEntry('delivery/submitted', { id: workItemId, executionId });
      this.sendJson(response, 202, {
        workItemId,
        executionId,
        state: 'accepted',
        mandateId: prepared.mandate.id,
      });
      void this.runAsyncDelegation(workItemId, worker, executionId);
    } catch (error) {
      // A failed async accept must release the concurrency slot it took.
      this.active.delete(workItemId);
      throw error;
    }
  }

  private async runAsyncDelegation(
    workItemId: string,
    worker: string,
    executionId: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.background.set(workItemId, { worker, executionId, controller });
    let finished = false;
    const finish = (state: string, error: string | undefined, result?: StoredResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      this.settleSafely(workItemId, state, error, executionId, result);
      this.active.delete(workItemId);
    };
    const timer = setTimeout(() => {
      // The deadline settles the work item by itself: a cancel that fails or a
      // worker that never reports a terminal event must not leave it in-flight.
      finish('failed', 'background delegation timed out');
      void this.workbench.cancel(worker, executionId).catch(() => undefined);
      controller.abort();
    }, this.asyncTimeoutMs);
    timer.unref();
    try {
      const execution = await this.waitForTerminal(worker, executionId, controller.signal);
      if (finished) {
        return;
      }
      const state = settleState(execution.state);
      if (state === 'completed') {
        const stored = this.storeResult(workItemId, execution.output);
        finish(state, undefined, stored);
      } else {
        finish(state, execution.error);
      }
    } catch (error) {
      // A stop() aborts the wait after settling the item itself.
      if (!finished && !controller.signal.aborted) {
        finish('unknown', messageOf(error));
      }
    } finally {
      clearTimeout(timer);
      this.background.delete(workItemId);
      this.active.delete(workItemId);
    }
  }

  private settleSafely(
    workItemId: string,
    state: string,
    error: string | undefined,
    executionId?: string,
    result?: StoredResult,
  ): void {
    try {
      this.settle(workItemId, state, error, executionId, result);
    } catch {
      // The gateway may be shutting down; the unsettled record stays visible.
    }
  }

  private storeResult(workItemId: string, output: string): StoredResult {
    const ledger = this.ledger;
    if (ledger === undefined) {
      throw new Error('Delegation ledger is not open');
    }
    const directory = join(ledger.stateDirectory, 'results');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Truncate on a code-point boundary: slicing raw bytes can split a
    // multi-byte character and make the stored file invalid UTF-8.
    const capped = truncateUtf8(output, this.resultMaxBytes);
    const name = `${workItemId}.txt`;
    writeFileSync(join(directory, name), Buffer.from(capped.text, 'utf8'), {
      flag: 'w',
      mode: 0o600,
    });
    return {
      file: `results/${name}`,
      bytes: Buffer.byteLength(capped.text, 'utf8'),
      truncated: capped.truncated,
    };
  }

  private sendDelegationStatus(response: ServerResponse, workItemId: string): void {
    if (!UUID_PATTERN.test(workItemId)) {
      throw new CollaborationGatewayError('Invalid work item id', 400);
    }
    const item = this.items.find((entry) => entry.id === workItemId);
    if (item === undefined) {
      throw new CollaborationGatewayError(`Unknown work item: ${workItemId}`, 404);
    }
    let output: string | undefined;
    let truncated: boolean | undefined;
    if (item.state === 'completed') {
      const settled = this.entries.find(
        (entry) => entry.type === 'delivery/settled' && entry.data.id === workItemId,
      );
      const resultFile = asStringValue(settled?.data.resultFile);
      const stored = resultFile === undefined ? undefined : this.readStoredResult(resultFile);
      if (stored !== undefined) {
        output = stored;
        truncated = settled?.data.resultTruncated === true;
      }
    }
    this.sendJson(response, 200, {
      workItemId: item.id,
      state: item.state,
      ...(item.executionId === undefined ? {} : { executionId: item.executionId }),
      ...(item.error === undefined ? {} : { error: item.error }),
      ...(output === undefined ? {} : { output }),
      ...(truncated === undefined ? {} : { truncated }),
    });
  }

  private readStoredResult(resultFile: string): string | undefined {
    const ledger = this.ledger;
    if (ledger === undefined) {
      return undefined;
    }
    // Only our own result layout may be read, and only inside the state
    // directory. A forged ledger entry must not reach sibling paths.
    if (!/^results[\\/][0-9a-f-]{36}\.txt$/i.test(resultFile)) {
      return undefined;
    }
    const base = ledger.stateDirectory;
    const target = join(base, resultFile);
    const rest = relative(base, target);
    if (rest === '' || rest.startsWith('..') || isAbsolute(rest)) {
      return undefined;
    }
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return undefined;
    }
  }

  private settle(
    workItemId: string,
    state: string,
    error: string | undefined,
    executionId?: string,
    result?: StoredResult,
  ): void {
    this.appendEntry('delivery/settled', {
      id: workItemId,
      state,
      ...(error === undefined ? {} : { error: capText(error, MAX_ERROR_CHARS) }),
      ...(executionId === undefined ? {} : { executionId }),
      ...(result === undefined
        ? {}
        : {
            resultFile: result.file,
            resultBytes: result.bytes,
            resultTruncated: result.truncated,
          }),
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

  private async waitForTerminal(
    connection: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<Execution> {
    while (true) {
      if (signal?.aborted === true) {
        throw new Error('background delegation stopped');
      }
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

function asStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface PreparedDelegation {
  readonly task: string;
  readonly worker: string;
  readonly idempotencyKey: string | undefined;
  readonly mandate: DelegationMandate;
}

interface StoredResult {
  readonly file: string;
  readonly bytes: number;
  readonly truncated: boolean;
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Truncate on a UTF-8 code-point boundary so the stored text stays valid. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

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
