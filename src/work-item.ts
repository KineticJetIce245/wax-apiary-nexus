import type { LedgerEntry } from './delegation-ledger.js';

/** Work-item states are derived from the ledger; nothing else stores them. */
export type WorkItemState = 'created' | 'in-flight' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface WorkItemView {
  readonly id: string;
  readonly mandateId: string;
  readonly requester: string;
  readonly basis: string;
  readonly policyVersion: string;
  readonly worker: string;
  readonly taskLength: number;
  readonly taskDigest: string;
  readonly idempotencyKey?: string;
  readonly state: WorkItemState;
  readonly executionId?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MutableItem {
  id: string;
  mandateId: string;
  requester: string;
  basis: string;
  policyVersion: string;
  worker: string;
  taskLength: number;
  taskDigest: string;
  idempotencyKey: string | undefined;
  state: WorkItemState;
  executionId: string | undefined;
  error: string | undefined;
  createdAt: string;
  updatedAt: string;
}

/** Fold the append-only ledger into current work-item views. */
export function projectWorkItems(entries: readonly LedgerEntry[]): WorkItemView[] {
  const items = new Map<string, MutableItem>();
  for (const entry of entries) {
    const id = asString(entry.data.id);
    if (id === undefined) {
      continue;
    }
    switch (entry.type) {
      case 'work-item/created': {
        items.set(id, {
          id,
          mandateId: asString(entry.data.mandateId) ?? '',
          requester: asString(entry.data.requester) ?? '',
          basis: asString(entry.data.basis) ?? '',
          policyVersion: asString(entry.data.policyVersion) ?? '',
          worker: asString(entry.data.worker) ?? '',
          taskLength: asNumber(entry.data.taskLength) ?? 0,
          taskDigest: asString(entry.data.taskDigest) ?? '',
          idempotencyKey: asString(entry.data.idempotencyKey),
          state: 'created',
          executionId: undefined,
          error: undefined,
          createdAt: entry.at,
          updatedAt: entry.at,
        });
        break;
      }
      case 'delivery/intent': {
        const item = items.get(id);
        if (item !== undefined) {
          item.state = 'in-flight';
          item.updatedAt = entry.at;
        }
        break;
      }
      case 'delivery/submitted': {
        const item = items.get(id);
        if (item !== undefined) {
          item.state = 'in-flight';
          item.executionId = asString(entry.data.executionId);
          item.updatedAt = entry.at;
        }
        break;
      }
      case 'delivery/settled': {
        const item = items.get(id);
        if (item !== undefined) {
          item.state = asSettledState(entry.data.state);
          const error = asString(entry.data.error);
          if (error !== undefined) {
            item.error = error;
          }
          item.updatedAt = entry.at;
        }
        break;
      }
      case 'gate/rejected': {
        break;
      }
    }
  }
  return [...items.values()].map((item) => ({
    id: item.id,
    mandateId: item.mandateId,
    requester: item.requester,
    basis: item.basis,
    policyVersion: item.policyVersion,
    worker: item.worker,
    taskLength: item.taskLength,
    taskDigest: item.taskDigest,
    ...(item.idempotencyKey === undefined ? {} : { idempotencyKey: item.idempotencyKey }),
    state: item.state,
    ...(item.executionId === undefined ? {} : { executionId: item.executionId }),
    ...(item.error === undefined ? {} : { error: item.error }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

/** Items that never reached a settled state: candidates for manual recovery. */
export function unsettledWorkItems(items: readonly WorkItemView[]): WorkItemView[] {
  return items.filter((item) => item.state === 'created' || item.state === 'in-flight');
}

/**
 * Human-readable recovery hint. It never instructs an automatic replay: the
 * operator or agent must inspect the project first.
 */
export function buildRecoveryNote(items: readonly WorkItemView[]): string {
  if (items.length === 0) {
    return '';
  }
  const lines = [
    `Collaboration ledger has ${String(items.length)} unsettled work item(s).`,
    'Before repeating any work, check the Project files, git history and the worker native session.',
    'Do not replay a delegation automatically; settle each item by hand after inspecting it.',
  ];
  for (const item of items) {
    lines.push(
      `- ${item.id} worker=${item.worker} state=${item.state}` +
        (item.executionId === undefined ? '' : ` execution=${item.executionId}`),
    );
  }
  return lines.join('\n');
}

function asSettledState(value: unknown): WorkItemState {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
