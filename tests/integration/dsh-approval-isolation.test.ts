import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import {
  admissionRunId,
  autoDecideGuards,
  bLoad,
  bRun,
  bUnload,
  bWake,
  getJson,
  postJson,
  waitForRunTerminal,
} from '../support/control-server-http.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.DEEPSEEK_API_KEY !== undefined &&
  process.env.DEEPSEEK_API_KEY.trim() !== '';
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli) || !hasKey
      ? 'Real DSH approval-isolation test needs DSH_ROOT (built CLI) and DEEPSEEK_API_KEY'
      : false,
  timeout: 240_000,
};

const GUARD_TIMEOUT_MS = 120_000;

function liveDefinition(liveId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: liveId,
    nodes: {
      only: { kind: 'forager', config: { connection: 'dsh', prompt: 'run {{input}}' } },
    },
    edges: [],
  };
}

async function waitForGuard(
  url: string,
  token: string,
  liveId: string,
  timeoutMs: number,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await getJson(url, token, '/guards');
    assert.equal(listed.status, 200, listed.text);
    const guards = listed.body?.['guards'];
    if (Array.isArray(guards)) {
      const found = guards.find(
        (guard: Record<string, any>) => guard['liveId'] === liveId,
      );
      if (found !== undefined) {
        return found as Record<string, any>;
      }
    }
    await delay(100);
  }
  assert.fail(`no guard attributed to live '${liveId}' within ${String(timeoutMs)}ms`);
}

/**
 * Two loaded real DSH lives on two fresh sessions. The idle live's forager
 * executor subscribes to the same Workspace, so without execution ownership it
 * would decide the running live's real ACP permission request with
 * `defaultDecision` (reject_once) instead of parking it for the runtime guard.
 */
test(
  'real DSH: an idle co-loaded live never decides the running live approval',
  integrationOptions,
  async (t) => {
    assert.ok(dshRoot !== undefined, 'DSH_ROOT is missing');
    const suffix = String(Date.now());
    const liveA = `m16e-iso-a-${suffix}`;
    const liveB = `m16e-iso-b-${suffix}`;
    const marker = `M16E-ISO-MARKER-${suffix}`;
    const fileName = `m16e-iso-${suffix}.txt`;
    const adapter = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    await adapter.start();
    const workspace = new Workspace(adapter);
    const project: Project = {
      id: `m16e-iso-${suffix}`,
      directory: mkdtempSync(join(tmpdir(), 'wax-m16e-iso-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m16e-iso-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      liveProject: project,
      guardTimeoutMs: GUARD_TIMEOUT_MS,
    });
    let autoDecider: ReturnType<typeof autoDecideGuards> | undefined;
    t.after(async () => {
      await autoDecider?.stop().catch(() => undefined);
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    });
    const info = await server.start();
    const token = readFileSync(info.tokenPath, 'utf8').trim();
    // Two different sessions, one live each: the fan-out is not about sharing
    // a conversation; any two loaded live foragers collide.
    for (const liveId of [liveA, liveB]) {
      const loaded = await bLoad(info.url, token, {
        definition: liveDefinition(liveId),
        bindings: { only: { kind: 'fresh', harness: 'dsh' } },
        project,
      });
      assert.equal(loaded.status, 200, loaded.text);
    }
    const loadedA = await getJson(info.url, token, '/lives');
    assert.equal(loadedA.status, 200, loadedA.text);
    const liveIds = (loadedA.body?.['lives'] as Record<string, any>[] | undefined)?.map(
      (live) => live['liveId'],
    );
    assert.deepEqual([...(liveIds ?? [])].sort(), [liveA, liveB].sort());

    const wakeA = await bWake(
      info.url,
      token,
      liveA,
      'only',
      `Use the shell tool to create a file named ${fileName} in the current directory ` +
        `with the exact content ${marker}. Report done. Do not use any other directory.`,
    );
    assert.equal(wakeA.status, 202, wakeA.text);
    const runIdA = admissionRunId(wakeA.body);
    const guardA = await waitForGuard(info.url, token, liveA, GUARD_TIMEOUT_MS / 2);
    // Admission has already returned; the run must still be non-terminal while
    // its approval is parked, proving the guard was not auto-answered.
    const midA = await bRun(info.url, token, liveA, runIdA);
    assert.equal(midA.status, 200, midA.text);
    const midState = midA.body?.['run']?.['state'];
    assert.ok(
      ['accepted', 'running'].includes(String(midState)),
      `run settled while its approval was parked: ${String(midState)}`,
    );
    const stillListed = await getJson(info.url, token, '/guards');
    assert.equal(stillListed.status, 200, stillListed.text);
    const guards = (stillListed.body?.['guards'] as Record<string, any>[]) ?? [];
    assert.ok(
      guards.some(
        (guard) => guard['liveId'] === liveA && guard['requestId'] === guardA['requestId'],
      ),
      'the running live approval is no longer parked',
    );
    assert.equal(
      guards.some((guard) => guard['liveId'] === liveB),
      false,
      'the idle co-loaded live parked a guard of its own',
    );

    // DSH may ask again after an allow (for example an escalation retry); keep
    // any later request deterministic without touching the one asserted above.
    autoDecider = autoDecideGuards(info.url, token, [String(guardA['requestId'])], () => 'allow_once');

    const allowed = await postJson(info.url, token, '/guard/decide', {
      requestId: guardA['requestId'],
      decision: 'allow_once',
    });
    assert.equal(allowed.status, 200, allowed.text);
    const doneA = await waitForRunTerminal(info.url, token, liveA, runIdA, 180_000);
    assert.equal(doneA.status, 200, doneA.text);
    assert.equal(doneA.body?.['run']?.['state'], 'completed');
    const written = existsSync(join(project.directory, fileName))
      ? readFileSync(join(project.directory, fileName), 'utf8')
      : undefined;
    assert.equal(written, marker, 'the allowed write did not happen');

    // The co-loaded idle live still works after the fix; it never interfered.
    const admissionB = await bWake(info.url, token, liveB, 'only', 'Reply with just OK.');
    assert.equal(admissionB.status, 202, admissionB.text);
    const doneB = await waitForRunTerminal(
      info.url,
      token,
      liveB,
      admissionRunId(admissionB.body),
      180_000,
    );
    assert.equal(doneB.body?.['run']?.['state'], 'completed');

    for (const liveId of [liveA, liveB]) {
      const unloaded = await bUnload(info.url, token, liveId);
      assert.equal(unloaded.status, 200, unloaded.text);
    }
    t.diagnostic(
      `liveA=${liveA} liveB=${liveB} guardLive=${String(guardA['liveId'])} ` +
        `guardOptions=${JSON.stringify(guardA['options'])} ` +
        `runState=${String(doneA.body?.['run']?.['state'])} fileWritten=true`,
    );
  },
);
