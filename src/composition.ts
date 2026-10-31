import type { Attachment } from './content.js';
import type { Execution } from './workspace.js';
import type { Workbench } from './workbench.js';

export type StrategyId = 'single-chat' | 'debate';
export type CompositionStatus = 'idle' | 'running' | 'failed' | 'cancelled';

export interface CompositionParticipant {
  readonly connection: string;
}

export interface Composition {
  readonly id: string;
  readonly version: number;
  readonly participants: Readonly<Record<string, CompositionParticipant>>;
  readonly strategyId: StrategyId;
  readonly config?: Readonly<Record<string, string>>;
}

export interface CompositionChange {
  readonly version: number;
  readonly strategyId: StrategyId;
  readonly at: string;
}

export interface CompositionTurn {
  readonly role: string;
  readonly connection: string;
  readonly executionId: string;
  readonly state: Execution['state'];
  readonly output: string;
  readonly attachments: readonly Attachment[];
}

export type CompositionEvent =
  | { readonly type: 'composition/started'; readonly composition: Composition }
  | {
      readonly type: 'composition/changed';
      readonly composition: Composition;
      readonly previousVersion: number;
    }
  | {
      readonly type: 'turn/started';
      readonly role: string;
      readonly connection: string;
      readonly executionId: string;
    }
  | { readonly type: 'turn/completed'; readonly turn: CompositionTurn }
  | { readonly type: 'composition/failed'; readonly error: string }
  | { readonly type: 'composition/cancelled'; readonly reason: string };

export interface CompositionRuntimeOptions {
  readonly pollIntervalMs?: number;
}

export class CompositionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionStateError';
  }
}

export class CompositionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionBusyError';
  }
}

export class CompositionExecutionError extends Error {
  constructor(
    message: string,
    readonly execution: Execution,
  ) {
    super(message);
    this.name = 'CompositionExecutionError';
  }
}

interface ActiveExecution {
  readonly role: string;
  readonly connection: string;
}

interface StrategyContext {
  readonly roles: readonly string[];
  readonly config: Readonly<Record<string, string>>;
  sendTo(role: string, text: string): Promise<CompositionTurn>;
}

/** Browser/Node-neutral strategy contract; built-ins are single-chat and debate. */
export interface CollaborationStrategy {
  readonly id: StrategyId;
  handleUserMessage(text: string): Promise<void>;
}

/**
 * Minimal Composition runtime: a composition is structure (participants and
 * strategy identity), a strategy is behavior. Switching strategy creates a new
 * composition version but never creates a native Conversation; submissions go
 * through the existing Workbench connections.
 */
export class CompositionRuntime {
  private readonly workbench: Workbench;
  private readonly pollIntervalMs: number;
  private compositionValue: Composition;
  private readonly historyValue: CompositionChange[] = [];
  private readonly turnsValue: CompositionTurn[] = [];
  private readonly active = new Map<string, ActiveExecution>();
  private readonly listeners = new Set<(event: CompositionEvent) => void>();
  private statusValue: CompositionStatus = 'idle';
  private started = false;
  private cancelRequested = false;
  private strategy: CollaborationStrategy | undefined;
  private lastError: Error | undefined;

  constructor(
    workbench: Workbench,
    composition: Composition,
    options: CompositionRuntimeOptions = {},
  ) {
    this.workbench = workbench;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.compositionValue = normalizeComposition(composition);
    this.historyValue.push({
      version: this.compositionValue.version,
      strategyId: this.compositionValue.strategyId,
      at: new Date().toISOString(),
    });
  }

  get composition(): Composition {
    return cloneComposition(this.compositionValue);
  }

  get version(): number {
    return this.compositionValue.version;
  }

  get strategyId(): StrategyId {
    return this.compositionValue.strategyId;
  }

  get status(): CompositionStatus {
    return this.statusValue;
  }

  get turns(): readonly CompositionTurn[] {
    return this.turnsValue.map(cloneTurn);
  }

  get history(): readonly CompositionChange[] {
    return this.historyValue.map((change) => ({ ...change }));
  }

  get error(): Error | undefined {
    return this.lastError;
  }

  onEvent(handler: (event: CompositionEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new CompositionStateError('Composition runtime has already started');
    }
    this.assertConnections(this.compositionValue);
    this.strategy = this.createStrategy(this.compositionValue);
    this.started = true;
    this.statusValue = 'idle';
    this.emit({ type: 'composition/started', composition: this.composition });
  }

  async send(text: string): Promise<void> {
    if (!this.started || this.strategy === undefined) {
      throw new CompositionStateError('Composition runtime is not started');
    }
    if (text.trim() === '') {
      throw new CompositionStateError('Message text must not be empty');
    }
    if (this.statusValue === 'running') {
      throw new CompositionBusyError('Composition already has a running turn');
    }
    this.statusValue = 'running';
    this.cancelRequested = false;
    this.lastError = undefined;
    try {
      await this.strategy.handleUserMessage(text);
      this.statusValue = this.cancelRequested ? 'cancelled' : 'idle';
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      this.statusValue = this.cancelRequested ? 'cancelled' : 'failed';
      this.emit({ type: 'composition/failed', error: this.lastError.message });
      throw error;
    }
  }

  /**
   * Switch behavior while keeping the same participant bindings and native
   * conversations. Only allowed between turns; in-flight work must be
   * cancelled or completed first.
   */
  switchStrategy(strategyId: StrategyId, config?: Readonly<Record<string, string>>): Composition {
    if (!this.started) {
      throw new CompositionStateError('Composition runtime is not started');
    }
    if (this.statusValue === 'running') {
      throw new CompositionBusyError('Cannot switch composition while a turn is running');
    }
    if (strategyId !== 'single-chat' && strategyId !== 'debate') {
      throw new CompositionStateError(`Unknown strategy: ${String(strategyId)}`);
    }
    const previousVersion = this.compositionValue.version;
    const next = normalizeComposition({
      ...this.compositionValue,
      version: previousVersion + 1,
      strategyId,
      ...(config === undefined ? {} : { config }),
    });
    this.assertConnections(next);
    const strategy = this.createStrategy(next);
    this.compositionValue = next;
    this.strategy = strategy;
    this.statusValue = 'idle';
    this.lastError = undefined;
    this.historyValue.push({
      version: next.version,
      strategyId: next.strategyId,
      at: new Date().toISOString(),
    });
    this.emit({ type: 'composition/changed', composition: this.composition, previousVersion });
    return this.composition;
  }

  async cancel(reason = 'Composition cancelled'): Promise<void> {
    this.cancelRequested = true;
    if (this.statusValue !== 'running') {
      return;
    }
    for (const [executionId, entry] of this.active) {
      try {
        await this.workbench.cancel(entry.connection, executionId);
      } catch {
        // Best effort; the execution settles through its own events.
      }
    }
    this.emit({ type: 'composition/cancelled', reason });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.cancelRequested = true;
    for (const [executionId, entry] of this.active) {
      try {
        await this.workbench.cancel(entry.connection, executionId);
      } catch {
        // Best effort.
      }
    }
    this.started = false;
    this.strategy = undefined;
    this.statusValue = 'idle';
  }

  private createStrategy(composition: Composition): CollaborationStrategy {
    const roles = Object.keys(composition.participants);
    if (roles.length === 0) {
      throw new CompositionStateError('Composition must have at least one participant');
    }
    const context: StrategyContext = {
      roles,
      config: composition.config ?? {},
      sendTo: (role, text) => this.sendTo(role, text),
    };
    if (composition.strategyId === 'single-chat') {
      return {
        id: 'single-chat',
        handleUserMessage: async (text) => {
          const role = context.config.participant ?? roles[0];
          if (role === undefined || !(role in composition.participants)) {
            throw new CompositionStateError(`Unknown single-chat participant: ${String(role)}`);
          }
          await context.sendTo(role, text);
        },
      };
    }

    const first = context.config.first ?? roles[0];
    const second = context.config.second ?? roles[1];
    if (first === undefined || second === undefined || first === second) {
      throw new CompositionStateError('Debate needs two distinct participants');
    }
    if (!(first in composition.participants) || !(second in composition.participants)) {
      throw new CompositionStateError('Debate names an unknown participant');
    }
    if (
      composition.participants[first]?.connection === composition.participants[second]?.connection
    ) {
      throw new CompositionStateError('Debate participants must use different connections');
    }
    return {
      id: 'debate',
      handleUserMessage: async (text) => {
        const firstTurn = await context.sendTo(
          first,
          `Debate topic:\n${text}\n\nGive your position briefly.`,
        );
        await context.sendTo(
          second,
          `Debate topic:\n${text}\n\n${first} said:\n${firstTurn.output}\n\nReply with a brief rebuttal.`,
        );
      },
    };
  }

  private async sendTo(role: string, text: string): Promise<CompositionTurn> {
    if (this.cancelRequested) {
      throw new CompositionStateError('Composition was cancelled before the turn started');
    }
    const participant = this.compositionValue.participants[role];
    if (participant === undefined) {
      throw new CompositionStateError(`Unknown participant: ${role}`);
    }
    const submitted = await this.workbench.submit(text, participant.connection);
    const executionId = submitted.execution.id;
    this.active.set(executionId, { role, connection: participant.connection });
    this.emit({
      type: 'turn/started',
      role,
      connection: participant.connection,
      executionId,
    });
    if (this.cancelRequested) {
      try {
        await this.workbench.cancel(participant.connection, executionId);
      } catch {
        // Best effort; the active execution may already have settled.
      }
    }

    let terminal: Execution;
    try {
      terminal = await this.waitForTerminal(participant.connection, executionId);
    } finally {
      this.active.delete(executionId);
    }
    const turn: CompositionTurn = {
      role,
      connection: participant.connection,
      executionId,
      state: terminal.state,
      output: terminal.output,
      attachments: terminal.attachments.map((attachment) => ({ ...attachment })),
    };
    this.turnsValue.push(turn);
    this.emit({ type: 'turn/completed', turn: cloneTurn(turn) });
    if (terminal.state !== 'completed') {
      throw new CompositionExecutionError(
        `Turn ${executionId} on ${participant.connection} ended as ${terminal.state}`,
        terminal,
      );
    }
    return turn;
  }

  private async waitForTerminal(connection: string, executionId: string): Promise<Execution> {
    while (true) {
      const found = this.workbench.getExecution(connection, executionId);
      if (found !== undefined && found.execution.state !== 'running') {
        return found.execution;
      }
      await delay(this.pollIntervalMs);
    }
  }

  private assertConnections(composition: Composition): void {
    for (const [role, participant] of Object.entries(composition.participants)) {
      if (this.workbench.getConnection(participant.connection)?.status !== 'ready') {
        throw new CompositionStateError(
          `Participant ${role} uses unavailable connection ${participant.connection}`,
        );
      }
    }
  }

  private emit(event: CompositionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Presentation listeners must not break composition transitions.
      }
    }
  }
}

function normalizeComposition(composition: Composition): Composition {
  if (composition.id.trim() === '') {
    throw new CompositionStateError('Composition id must not be empty');
  }
  if (!Number.isInteger(composition.version) || composition.version < 1) {
    throw new CompositionStateError('Composition version must be a positive integer');
  }
  if (composition.strategyId !== 'single-chat' && composition.strategyId !== 'debate') {
    throw new CompositionStateError(`Unknown strategy: ${String(composition.strategyId)}`);
  }
  const participants: Record<string, CompositionParticipant> = {};
  for (const [role, participant] of Object.entries(composition.participants)) {
    if (role.trim() === '' || participant.connection.trim() === '') {
      throw new CompositionStateError('Participant role and connection must not be empty');
    }
    participants[role] = { connection: participant.connection };
  }
  if (Object.keys(participants).length === 0) {
    throw new CompositionStateError('Composition must have at least one participant');
  }
  return {
    id: composition.id,
    version: composition.version,
    participants,
    strategyId: composition.strategyId,
    ...(composition.config === undefined ? {} : { config: { ...composition.config } }),
  };
}

function cloneComposition(composition: Composition): Composition {
  return {
    id: composition.id,
    version: composition.version,
    participants: Object.fromEntries(
      Object.entries(composition.participants).map(([role, participant]) => [
        role,
        { connection: participant.connection },
      ]),
    ),
    strategyId: composition.strategyId,
    ...(composition.config === undefined ? {} : { config: { ...composition.config } }),
  };
}

function cloneTurn(turn: CompositionTurn): CompositionTurn {
  return {
    ...turn,
    attachments: turn.attachments.map((attachment) => ({ ...attachment })),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
