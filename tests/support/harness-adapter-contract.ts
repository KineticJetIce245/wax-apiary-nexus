import assert from 'node:assert/strict';

import type { HarnessAdapter, HarnessEvent } from '../../src/adapters/harness.js';
import type { Project } from '../../src/kernel.js';

export interface HarnessAdapterContractFixture {
  readonly adapter: HarnessAdapter;
  readonly project: Project;
  readonly secondProject: Project;
  readonly startTimeoutMs?: number;
}

/**
 * Machine-checkable subset of contract/README.md. It intentionally covers
 * only invariants that do not depend on one protocol's scripted turn shape:
 * capability shape, identity distinctness, first-event delivery, overlapping
 * submit rejection, unsubscribe, unknown-id rejection and post-stop behavior.
 *
 * Approvals, cancellation, close and process loss need a protocol double and
 * stay in each adapter's own test file.
 */
export async function assertHarnessAdapterContract(fixture: HarnessAdapterContractFixture): Promise<void> {
  const { adapter, project, secondProject } = fixture;
  const timeoutMs = fixture.startTimeoutMs ?? 5_000;

  assertCapabilities(adapter);
  await adapter.start();
  await adapter.start();

  const events: HarnessEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => {
    events.push(event);
  });

  try {
    const first = await adapter.createConversation(project);
    const second = await adapter.createConversation(secondProject);
    assert.notEqual(first.trim(), '');
    assert.notEqual(second.trim(), '');
    assert.notEqual(first, second, 'each conversation must have its own native identity');

    await adapter.submit(first, 'contract-exec-1', 'hold this turn open');
    await waitFor(
      () => events.some((event) => event.type === 'execution/started' && event.executionId === 'contract-exec-1'),
      timeoutMs,
      'adapter did not emit execution/started for the submitted execution',
    );

    await assert.rejects(
      adapter.submit(first, 'contract-exec-2', 'overlap'),
      /active execution|already/i,
      'adapter accepted a second overlapping submit',
    );

    unsubscribe();
    const observed = events.length;
    await adapter.submit(second, 'contract-exec-3', 'no listener remains');
    await delay(200);
    assert.equal(events.length, observed, 'unsubscribed listener still received events');

    await assert.rejects(
      adapter.submit('contract-missing-native', 'contract-exec-4', 'unknown'),
      /unknown|not found/i,
      'adapter accepted a submit for an unknown native id',
    );
    await assert.rejects(
      adapter.respondToApproval({ requestId: 'contract-missing-approval', kind: 'allow_once' }),
      /unknown/i,
      'adapter accepted an unknown approval decision',
    );

    await adapter.stop();
    await assert.rejects(
      adapter.submit(first, 'contract-exec-5', 'after stop'),
      /not started|closed|disposed/i,
      'adapter accepted work after stop',
    );
  } finally {
    unsubscribe();
    await adapter.stop().catch(() => undefined);
  }
}

function assertCapabilities(adapter: HarnessAdapter): void {
  const capabilities = adapter.capabilities;
  assert.ok(
    capabilities.approval === 'interactive' ||
      capabilities.approval === 'policy-only' ||
      capabilities.approval === 'none',
    `invalid approval capability: ${String(capabilities.approval)}`,
  );
  for (const key of ['cancel', 'streaming', 'resume'] as const) {
    assert.equal(typeof capabilities[key], 'boolean', `${key} capability must be a boolean`);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
