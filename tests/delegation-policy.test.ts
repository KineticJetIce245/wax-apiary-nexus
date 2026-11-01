import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DelegationPolicyError,
  defaultDelegationPolicy,
  loadDelegationPolicy,
  parseDelegationPolicy,
} from '../src/delegation-policy.js';

const VALID = {
  requester: 'kji',
  allowedWorkers: ['dsh'],
  maxTaskChars: 1000,
  maxConcurrent: 2,
  ttlMs: 60_000,
  policyVersion: 'v1',
};

test('accepts a complete policy and fills the fixed basis', () => {
  const policy = parseDelegationPolicy(VALID);
  assert.equal(policy.requester, 'kji');
  assert.equal(policy.basis, 'policy');
  assert.deepEqual(policy.allowedWorkers, ['dsh']);
  assert.equal(policy.maxConcurrent, 2);
});

test('rejects unknown policy fields instead of ignoring them', () => {
  assert.throws(() => parseDelegationPolicy({ ...VALID, basisFromModel: 'explicit' }), DelegationPolicyError);
  assert.throws(() => parseDelegationPolicy({ ...VALID, basis: 'explicit' }), /basis/);
});

test('rejects worker lists that are empty, duplicated or unbounded', () => {
  assert.throws(() => parseDelegationPolicy({ ...VALID, allowedWorkers: [] }), /allowedWorkers/);
  assert.throws(() => parseDelegationPolicy({ ...VALID, allowedWorkers: ['dsh', 'dsh'] }), /duplicate/);
  assert.throws(() => parseDelegationPolicy({ ...VALID, allowedWorkers: ['a'.repeat(65)] }), /allowedWorkers/);
  assert.throws(() => parseDelegationPolicy({ ...VALID, allowedWorkers: ['../escape'] }), /allowedWorkers/);
});

test('rejects out-of-range numeric limits', () => {
  assert.throws(() => parseDelegationPolicy({ ...VALID, maxTaskChars: 0 }), /maxTaskChars/);
  assert.throws(() => parseDelegationPolicy({ ...VALID, maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => parseDelegationPolicy({ ...VALID, ttlMs: 0 }), /ttlMs/);
  assert.throws(() => parseDelegationPolicy({ ...VALID, maxConcurrent: 1.5 }), /maxConcurrent/);
});

test('defaults tie the allowed worker set to the configured connection', () => {
  const policy = defaultDelegationPolicy('codex', 500);
  assert.deepEqual(policy.allowedWorkers, ['codex']);
  assert.equal(policy.maxTaskChars, 500);
  assert.equal(policy.maxConcurrent, 1);
});

test('loads a policy file and rejects invalid JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uw-g010-policy-'));
  const path = join(directory, 'policy.json');
  writeFileSync(path, JSON.stringify(VALID), 'utf8');
  assert.equal(loadDelegationPolicy(path).policyVersion, 'v1');
  writeFileSync(path, '{', 'utf8');
  assert.throws(() => loadDelegationPolicy(path), DelegationPolicyError);
});
