import { readFileSync } from 'node:fs';

/**
 * Deterministic authorization facts for one gateway instance. The policy comes
 * from the operator's configuration; it is never derived from tool arguments,
 * because those are produced by the model that wants the delegation.
 */
export interface DelegationPolicy {
  readonly requester: string;
  /** Only `policy` is implemented; a model-supplied basis is never trusted. */
  readonly basis: 'policy';
  readonly allowedWorkers: readonly string[];
  readonly maxTaskChars: number;
  readonly maxConcurrent: number;
  readonly ttlMs: number;
  readonly policyVersion: string;
}

export class DelegationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationPolicyError';
  }
}

export const DEFAULT_MAX_TASK_CHARS = 20_000;
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_POLICY_VERSION = 'g010-default';

/** Policy used when the caller does not configure one: only the worker it asked for. */
export function defaultDelegationPolicy(
  workerConnection: string,
  maxTaskChars: number = DEFAULT_MAX_TASK_CHARS,
): DelegationPolicy {
  return {
    requester: 'operator',
    basis: 'policy',
    allowedWorkers: [workerConnection],
    maxTaskChars,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    ttlMs: DEFAULT_TTL_MS,
    policyVersion: DEFAULT_POLICY_VERSION,
  };
}

const POLICY_FIELDS = new Set([
  'requester',
  'basis',
  'allowedWorkers',
  'maxTaskChars',
  'maxConcurrent',
  'ttlMs',
  'policyVersion',
]);

/** Validate an operator-supplied policy object; unknown fields are rejected. */
export function parseDelegationPolicy(value: unknown): DelegationPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DelegationPolicyError('policy must be an object');
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !POLICY_FIELDS.has(key));
  if (extra.length > 0) {
    throw new DelegationPolicyError(`Unknown policy fields: ${extra.join(', ')}`);
  }
  const basis = record.basis ?? 'policy';
  if (basis !== 'policy') {
    throw new DelegationPolicyError("policy.basis must be 'policy'");
  }
  return {
    requester: boundedString(record.requester ?? 'operator', 'requester', 128),
    basis: 'policy',
    allowedWorkers: workerList(record.allowedWorkers),
    maxTaskChars: boundedInteger(record.maxTaskChars ?? DEFAULT_MAX_TASK_CHARS, 'maxTaskChars', 1, 1_000_000),
    maxConcurrent: boundedInteger(record.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, 'maxConcurrent', 1, 16),
    ttlMs: boundedInteger(record.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs', 1, 7 * 24 * 60 * 60 * 1000),
    policyVersion: boundedString(record.policyVersion ?? DEFAULT_POLICY_VERSION, 'policyVersion', 64),
  };
}

/** Read and validate a policy JSON file. */
export function loadDelegationPolicy(path: string): DelegationPolicy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new DelegationPolicyError(
      `Cannot read delegation policy ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DelegationPolicyError(`Delegation policy ${path} is not valid JSON`);
  }
  return parseDelegationPolicy(parsed);
}

function workerList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new DelegationPolicyError('policy.allowedWorkers must be an array of 1-16 worker names');
  }
  const seen = new Set<string>();
  const workers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64 || !/^[A-Za-z0-9._-]+$/.test(entry)) {
      throw new DelegationPolicyError('policy.allowedWorkers entries must be 1-64 [A-Za-z0-9._-] characters');
    }
    if (seen.has(entry)) {
      throw new DelegationPolicyError(`policy.allowedWorkers contains a duplicate: ${entry}`);
    }
    seen.add(entry);
    workers.push(entry);
  }
  return workers;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new DelegationPolicyError(`policy.${field} must be a non-empty string of at most ${String(maxLength)} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new DelegationPolicyError(`policy.${field} must not contain control characters`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DelegationPolicyError(`policy.${field} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return value;
}
