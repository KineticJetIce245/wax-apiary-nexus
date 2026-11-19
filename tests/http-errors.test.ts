import assert from 'node:assert/strict';
import test from 'node:test';

import { toHttpError } from '../src/control/http-errors.js';
import { ForagerExecutionError } from '../src/session/forager.js';
import type { ExecutionCancelReason } from '../src/session/workspace.js';

interface Scenario {
  readonly label: string;
  readonly state: 'failed' | 'cancelled' | 'unknown';
  readonly cancelReason?: ExecutionCancelReason;
  readonly status: number;
  readonly code: string;
}

/**
 * Only a Workspace-attributed approval timer is `approval-timeout`; every
 * other cancelled execution stays `execution-cancelled`, and failed/unknown
 * executions remain internal 500.
 */
const SCENARIOS: readonly Scenario[] = [
  { label: 'failed', state: 'failed', status: 500, code: 'internal' },
  { label: 'unknown', state: 'unknown', status: 500, code: 'internal' },
  {
    label: 'cancelled without provenance',
    state: 'cancelled',
    status: 409,
    code: 'execution-cancelled',
  },
  {
    label: 'approval timeout',
    state: 'cancelled',
    cancelReason: 'approval-timeout',
    status: 409,
    code: 'approval-timeout',
  },
  {
    label: 'explicit cancel',
    state: 'cancelled',
    cancelReason: 'explicit-cancel',
    status: 409,
    code: 'execution-cancelled',
  },
  {
    label: 'replace cancel',
    state: 'cancelled',
    cancelReason: 'replace',
    status: 409,
    code: 'execution-cancelled',
  },
  {
    label: 'close cancel',
    state: 'cancelled',
    cancelReason: 'close',
    status: 409,
    code: 'execution-cancelled',
  },
];

for (const scenario of SCENARIOS) {
  test(`maps ${scenario.label} to ${String(scenario.status)} ${scenario.code}`, () => {
    const error = new ForagerExecutionError('node', scenario.state, 'native-detail', {
      ...(scenario.cancelReason === undefined
        ? {}
        : { cancelReason: scenario.cancelReason }),
    });

    const http = toHttpError(error);
    assert.equal(http.status, scenario.status);
    assert.equal(http.code, scenario.code);
    assert.equal(http.message.includes('native-detail'), false);
  });
}
