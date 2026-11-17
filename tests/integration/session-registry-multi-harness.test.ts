// Adapter/session-level test: two real native sessions and a global WAX
// registry, not a graph/daemon cross-harness test. The real cross-harness graph
// path is covered by waxd-mixed-harness.test.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Project } from '../../src/project/kernel.js';
import { DispatchService } from '../../src/b/dispatch-service.js';
import { createDefaultAdapter } from '../../src/cli/cli-shared.js';
import { AdapterPool } from '../../src/session/adapter-pool.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import type { Workspace } from '../../src/session/workspace.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const codexExe = process.env.CODEX_EXE;

const missing: string[] = [];
if (dshRoot === undefined || builtCli === undefined || !existsSync(builtCli)) {
  missing.push('DSH_ROOT with a built apps/cli/lib/bin.js');
}
if (codexExe === undefined || !existsSync(codexExe)) {
  missing.push('CODEX_EXE');
}

const integrationOptions = {
  skip:
    missing.length > 0
      ? `Real multi-harness test needs ${missing.join(' and ')}`
      : false,
  timeout: 480_000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSettled(
  workspace: Workspace,
  executionId: string,
  timeoutMs = 240_000,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const execution = workspace.getExecution(executionId);
    if (execution !== undefined && execution.state !== 'running') {
      return execution;
    }
    await delay(100);
  }
  throw new Error(`execution did not settle within ${timeoutMs}ms: ${executionId}`);
}

test(
  'one global registry routes real Codex and DSH sessions through AdapterPool',
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

    const directory = mkdtempSync(join(tmpdir(), 'wax-m9a-integration-'));
    const project: Project = { id: `project-${String(Date.now())}`, directory };
    let registry: SessionRegistry | undefined;
    const openSessionIds: string[] = [];

    try {
      await pool.start(['codex', 'dsh']);
      assert.deepEqual(pool.harnesses(), ['codex', 'dsh']);

      const workspaces = new Map<string, Workspace>(
        pool.harnesses().map((harness) => [harness, pool.workspaceFor(harness)]),
      );
      registry = new SessionRegistry({ workspaces });

      const codexSession = await registry.create(project, { harness: 'codex' });
      const dshSession = await registry.create(project, { harness: 'dsh' });
      openSessionIds.push(codexSession.sessionId, dshSession.sessionId);

      assert.equal(codexSession.harness, 'codex');
      assert.equal(dshSession.harness, 'dsh');
      const codexWorkspace = registry.workspaceFor(codexSession.harness);
      const dshWorkspace = registry.workspaceFor(dshSession.harness);
      assert.equal(codexWorkspace, pool.workspaceFor('codex'));
      assert.equal(dshWorkspace, pool.workspaceFor('dsh'));
      assert.notEqual(codexWorkspace, dshWorkspace);
      assert.deepEqual(
        registry.list().map((record) => record.harness),
        ['codex', 'dsh'],
      );

      // Unknown-answer prompts: the process only checks the format/range, not a
      // precomputed value. Different ranges make a misroute observable.
      t.diagnostic(
        `constraints: codex 4 digits in 1000..9999, dsh 3 digits in 100..999`,
      );

      const codexExecution = await codexWorkspace.submit(
        codexSession.sessionId,
        'Pick a random integer from 1000 through 9999. ' +
          'Do not use tools. Reply with only the integer.',
      );
      const dshExecution = await dshWorkspace.submit(
        dshSession.sessionId,
        'Pick a random integer from 100 through 999. ' +
          'Do not use tools. Reply with only the integer.',
      );
      const [codexResult, dshResult] = await Promise.all([
        waitForSettled(codexWorkspace, codexExecution.id),
        waitForSettled(dshWorkspace, dshExecution.id),
      ]);

      assert.equal(codexResult.state, 'completed');
      assert.equal(dshResult.state, 'completed');

      const codexOutput = codexResult.output.trim();
      const dshOutput = dshResult.output.trim();
      assert.match(codexOutput, /^\d{4}$/, 'codex output must be exactly four digits');
      assert.match(dshOutput, /^\d{3}$/, 'dsh output must be exactly three digits');
      const codexValue = Number(codexOutput);
      const dshValue = Number(dshOutput);
      assert.ok(codexValue >= 1000 && codexValue <= 9999);
      assert.ok(dshValue >= 100 && dshValue <= 999);

      t.diagnostic(
        `observed: codex=${codexOutput} (1000..9999), dsh=${dshOutput} (100..999)`,
      );

      // M9h real Dispatch smoke: explicitly reuse the real DSH session and
      // check only the unknown answer's format/range, not a fixed value.
      const dispatched = await new DispatchService({
        registry,
        defaultProject: project,
      }).dispatch(
        'Pick a random integer from 100000 through 999999. ' +
          'Do not use tools. Reply with only the integer.',
        { sessionId: dshSession.sessionId, timeoutMs: 120_000 },
      );
      const dispatchedDigits = dispatched.output.trim().replace(/,/g, '');
      assert.match(dispatchedDigits, /^\d{6}$/);
      const dispatchedValue = Number(dispatchedDigits);
      assert.ok(dispatchedValue >= 100000 && dispatchedValue <= 999999);
      assert.equal(dispatched.sessionId, dshSession.sessionId);
      t.diagnostic(`observed dispatch: dsh=${dispatchedDigits} (100000..999999)`);

      await registry.close(codexSession.sessionId);
      await registry.close(dshSession.sessionId);
      openSessionIds.length = 0;
      assert.deepEqual(registry.list(), []);
      assert.deepEqual(pool.harnesses(), ['codex', 'dsh']);
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
