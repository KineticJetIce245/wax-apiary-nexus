import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Project } from '../../src/project/kernel.js';
import { createDefaultAdapter } from '../../src/cli/cli-shared.js';
import { AdapterPool } from '../../src/session/adapter-pool.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import type { Workspace } from '../../src/session/workspace.js';

const dshRoot = process.env.DSH_ROOT;
const builtDshCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const codexExe = process.env.CODEX_EXE;
const hasKey =
  process.env.DEEPSEEK_API_KEY !== undefined &&
  process.env.DEEPSEEK_API_KEY.trim() !== '';

const missing: string[] = [];
if (!hasKey) {
  missing.push('DEEPSEEK_API_KEY');
}
if (dshRoot === undefined || builtDshCli === undefined || !existsSync(builtDshCli)) {
  missing.push('DSH_ROOT with a built apps/cli/lib/bin.js');
}
if (codexExe === undefined || !existsSync(codexExe)) {
  missing.push('CODEX_EXE');
}

const integrationOptions = {
  skip:
    missing.length > 0
      ? `Real mixed-harness product test needs ${missing.join(', ')}`
      : false,
  timeout: 600_000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSettled(workspace: Workspace, executionId: string) {
  const started = Date.now();
  while (Date.now() - started < 360_000) {
    const execution = workspace.getExecution(executionId);
    if (execution !== undefined && execution.state !== 'running') {
      return execution;
    }
    await delay(100);
  }
  throw new Error(`execution did not settle within 360000ms: ${executionId}`);
}

/** Parse an integer-only answer; never echo the model's output body. */
function parseInteger(output: string, label: string): number {
  const trimmed = output.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} did not return a single integer (shape mismatch)`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} returned a non-safe integer`);
  }
  return value;
}

/** The independent local calculation, not the DSH session's answer. */
function localProduct(a: number, b: number): number {
  return a * b;
}

test(
  'DSH and Codex generate numbers; DSH multiplies them and a local WAX-derived check agrees',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined || codexExe === undefined) {
      throw new Error('integration environment is missing');
    }

    const pool = new AdapterPool({
      createAdapter: (harness) => {
        if (harness === 'codex') {
          return createDefaultAdapter({ harness: 'codex', executable: codexExe });
        }
        if (harness === 'dsh') {
          return createDefaultAdapter({ harness: 'dsh', dshRoot });
        }
        return Promise.reject(new Error(`Unexpected harness: ${harness}`));
      },
    });

    const directory = mkdtempSync(join(tmpdir(), 'wax-m9c-product-'));
    const project: Project = { id: `product-${String(Date.now())}`, directory };
    let registry: SessionRegistry | undefined;
    const openSessionIds: string[] = [];

    try {
      await pool.start(['codex', 'dsh']);
      assert.deepEqual(pool.harnesses(), ['codex', 'dsh']);

      const workspaces = new Map<string, Workspace>(
        pool.harnesses().map((harness) => [harness, pool.workspaceFor(harness)]),
      );
      registry = new SessionRegistry({ workspaces });

      const dshSession = await registry.create(project, { harness: 'dsh' });
      const codexSession = await registry.create(project, { harness: 'codex' });
      openSessionIds.push(dshSession.sessionId, codexSession.sessionId);

      const dshWorkspace = registry.workspaceFor(dshSession.harness);
      const codexWorkspace = registry.workspaceFor(codexSession.harness);
      assert.notEqual(dshWorkspace, codexWorkspace);

      // Both generate concurrently. The answer is unknown: only the range is
      // fixed, and the parser accepts exactly one integer.
      t.diagnostic('constraints: both numbers are integers in 101..999');
      const [dshSeedExecution, codexSeedExecution] = await Promise.all([
        dshWorkspace.submit(
          dshSession.sessionId,
          'Pick a random integer greater than 100 and less than 1000. ' +
            'Do not use tools. Reply with only the integer.',
        ),
        codexWorkspace.submit(
          codexSession.sessionId,
          'Pick a random integer greater than 100 and less than 1000. ' +
            'Do not use tools. Reply with only the integer.',
        ),
      ]);
      const [dshSeed, codexSeed] = await Promise.all([
        waitForSettled(dshWorkspace, dshSeedExecution.id),
        waitForSettled(codexWorkspace, codexSeedExecution.id),
      ]);
      assert.equal(dshSeed.state, 'completed');
      assert.equal(codexSeed.state, 'completed');

      // These two values are obtained through WAX's execution outputs.
      const dshNumber = parseInteger(dshSeed.output, 'DSH seed');
      const codexNumber = parseInteger(codexSeed.output, 'Codex seed');
      assert.ok(dshNumber > 100 && dshNumber < 1000);
      assert.ok(codexNumber > 100 && codexNumber < 1000);
      t.diagnostic(
        `observed seeds: DSH=${String(dshNumber)}, Codex=${String(codexNumber)}`,
      );

      // Codex's number goes back to the original DSH session. Do not repeat
      // DSH's own number: DSH must recall it from its previous turn.
      const dshProductExecution = await dshWorkspace.submit(
        dshSession.sessionId,
        `Multiply your previous number by ${String(codexNumber)}. ` +
          'Reply with only the product, as digits.',
      );
      const dshProduct = await waitForSettled(dshWorkspace, dshProductExecution.id);
      assert.equal(dshProduct.state, 'completed');
      const observedProduct = parseInteger(dshProduct.output, 'DSH product');

      // Independent small calculation from the two WAX-derived numbers.
      const expectedProduct = localProduct(dshNumber, codexNumber);
      t.diagnostic(
        `observed product=${String(observedProduct)}, local product=${String(expectedProduct)}`,
      );
      assert.equal(observedProduct, expectedProduct);

      await registry.close(dshSession.sessionId);
      await registry.close(codexSession.sessionId);
      openSessionIds.length = 0;
    } finally {
      if (registry !== undefined) {
        for (const sessionId of openSessionIds) {
          await registry.close(sessionId).catch(() => undefined);
        }
      }
      await pool.stop().catch(() => undefined);
    }
  },
);
