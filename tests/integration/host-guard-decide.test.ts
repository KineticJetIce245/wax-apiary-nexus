import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { parseComposition } from '../../src/runtime/index.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.DEEPSEEK_API_KEY !== undefined &&
  process.env.DEEPSEEK_API_KEY.trim() !== '';
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli) || !hasKey
      ? 'Real guard test needs DSH_ROOT (built CLI) and DEEPSEEK_API_KEY'
      : false,
  timeout: 180_000,
};

function liveOf(
  definition: Record<string, unknown>,
  bindings: Record<string, unknown>,
) {
  return fromCompositionDefinition(parseComposition(definition), bindings as GraphBindings);
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for native guard');
}

test(
  'real DSH native approval reject through HTTP leaves no marker',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    const adapter = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    await adapter.start();
    const workspace = new Workspace(adapter, { approvalTimeoutMs: 90_000 });
    const project: Project = {
      id: 'project-native-guard-reject',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9d-guard-reject-project-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-guard-reject-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      liveProject: project,
      guardTimeoutMs: 90_000,
    });

    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
      ): Promise<{ readonly status: number; readonly body: Record<string, any> }> => {
        const response = await fetch(`${info.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(150_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, any>,
        };
      };

      const marker = `REJECTED-GUARD-${String(Date.now())}`;
      const loaded = await request('POST', '/lives', {
        live: liveOf({
          schemaVersion: 1,
          id: 'native-guard-reject',
          nodes: {
            only: {
              kind: 'forager',
              config: { connection: 'dsh', prompt: 'run {{input}}' },
            },
          },
          edges: [],
        }, { only: { kind: 'fresh', harness: 'dsh' } }),
        project,
      });
      assert.equal(loaded.status, 200);

      const triggerPromise = request('POST', '/lives/wake', {
        liveId: 'native-guard-reject',
        beeId: 'only',
        input:
            `Use the shell tool to create a file named rejected-guard.txt in the current directory ` +
            `with the exact content ${marker}. Report done. Do not use any other directory.`,
      });

      await waitFor(async () => {
        const guards = await request('GET', '/guards');
        return guards.status === 200 && (guards.body['guards'] as unknown[]).length === 1;
      });
      const listed = await request('GET', '/guards');
      const guard = (listed.body['guards'] as Record<string, unknown>[])[0];
      assert.ok(guard !== undefined);
      assert.equal(typeof guard['requestId'], 'string');
      assert.equal(JSON.stringify(listed.body).includes(marker), false);

      const decided = await request('POST', '/guard/decide', {
        requestId: guard['requestId'],
        decision: 'reject_once',
      });
      assert.equal(decided.status, 200);

      const trigger = await triggerPromise;
      assert.equal(trigger.status, 200);
      assert.equal(trigger.body['result']?.['rest'], true);
      assert.equal(existsSync(join(project.directory, 'rejected-guard.txt')), false);
      assert.equal((await request('GET', '/guards')).body['guards'].length, 0);
      t.diagnostic(
        `observed: real DSH host reject requestId=${String(guard['requestId'])}; ` +
          'rejected-guard.txt absent',
      );
    } finally {
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);

test(
  'real DSH native approval cancel through HTTP leaves no marker',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    const adapter = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    await adapter.start();
    const workspace = new Workspace(adapter, { approvalTimeoutMs: 90_000 });
    const project: Project = {
      id: 'project-native-guard-cancel',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9d-guard-cancel-project-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-guard-cancel-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      guardTimeoutMs: 90_000,
    });

    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
      ): Promise<{ readonly status: number; readonly body: Record<string, any> }> => {
        const response = await fetch(`${info.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(150_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, any>,
        };
      };

      const marker = `CANCELLED-GUARD-${String(Date.now())}`;
      const loaded = await request('POST', '/lives', {
        live: liveOf({
          schemaVersion: 1,
          id: 'native-guard-cancel',
          nodes: {
            only: {
              kind: 'forager',
              config: { connection: 'dsh', prompt: 'run {{input}}' },
            },
          },
          edges: [],
        }, { only: { kind: 'fresh', harness: 'dsh' } }),
        project,
      });
      assert.equal(loaded.status, 200);

      const triggerPromise = request('POST', '/lives/wake', {
        liveId: 'native-guard-cancel',
        beeId: 'only',
        input:
            `Use the shell tool to create a file named cancelled-guard.txt in the current directory ` +
            `with the exact content ${marker}. Report done. Do not use any other directory.`,
      });

      await waitFor(async () => {
        const guards = await request('GET', '/guards');
        return guards.status === 200 && (guards.body['guards'] as unknown[]).length === 1;
      });
      const listed = await request('GET', '/guards');
      const guard = (listed.body['guards'] as Record<string, unknown>[])[0];
      assert.ok(guard !== undefined);
      assert.equal(typeof guard['requestId'], 'string');

      const decided = await request('POST', '/guard/decide', {
        requestId: guard['requestId'],
        decision: 'cancelled',
      });
      assert.equal(decided.status, 200);

      const trigger = await triggerPromise;
      assert.equal(trigger.status, 200);
      assert.equal(trigger.body['result']?.['rest'], true);
      assert.equal(existsSync(join(project.directory, 'cancelled-guard.txt')), false);
      assert.equal((await request('GET', '/guards')).body['guards'].length, 0);
      t.diagnostic(
        `observed: real DSH host cancel requestId=${String(guard['requestId'])}; ` +
          'cancelled-guard.txt absent',
      );
    } finally {
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);

test(
  'real DSH native approval expiry answers 409 guard-expired to a late decision',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    const adapter = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    await adapter.start();
    const workspace = new Workspace(adapter, { approvalTimeoutMs: 90_000 });
    const project: Project = {
      id: 'project-native-guard-expiry',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9d-guard-expiry-project-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-guard-expiry-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      liveProject: project,
      guardTimeoutMs: 4_000,
    });

    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
      ): Promise<{ readonly status: number; readonly body: Record<string, any> }> => {
        const response = await fetch(`${info.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(150_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, any>,
        };
      };

      const marker = `EXPIRED-GUARD-${String(Date.now())}`;
      const loaded = await request('POST', '/lives', {
        live: liveOf({
          schemaVersion: 1,
          id: 'native-guard-expiry',
          nodes: {
            only: {
              kind: 'forager',
              config: { connection: 'dsh', prompt: 'run {{input}}' },
            },
          },
          edges: [],
        }, { only: { kind: 'fresh', harness: 'dsh' } }),
        project,
      });
      assert.equal(loaded.status, 200);

      const triggerPromise = request('POST', '/lives/wake', {
        liveId: 'native-guard-expiry',
        beeId: 'only',
        input:
          `Use the shell tool to create a file named expired-guard.txt in the current directory ` +
          `with the exact content ${marker}. Report done. Do not use any other directory.`,
      });

      await waitFor(async () => {
        const guards = await request('GET', '/guards');
        return guards.status === 200 && (guards.body['guards'] as unknown[]).length === 1;
      });
      const listed = await request('GET', '/guards');
      const guard = (listed.body['guards'] as Record<string, unknown>[])[0];
      assert.ok(guard !== undefined);
      assert.equal(typeof guard['requestId'], 'string');

      const openedAt = Date.now();
      await waitFor(async () => {
        const guards = await request('GET', '/guards');
        const pending = guards.body['guards'] as Record<string, unknown>[];
        return pending.every((item) => item['requestId'] !== guard['requestId']);
      }, 30_000);
      const elapsedMs = Date.now() - openedAt;

      const late = await request('POST', '/guard/decide', {
        requestId: guard['requestId'],
        decision: 'allow_once',
      });
      assert.equal(late.status, 409);
      assert.equal(late.body['code'], 'guard-expired');
      assert.equal(late.body['ok'], false);

      const trigger = await triggerPromise;
      assert.equal(trigger.status, 200);
      assert.equal(trigger.body['result']?.['rest'], true);
      assert.equal(existsSync(join(project.directory, 'expired-guard.txt')), false);
      t.diagnostic(
        `observed: requestId=${String(guard['requestId'])} phase=expired ` +
          `elapsedMs=${String(elapsedMs)} errorClass=${String(late.body['code'])}`,
      );
    } finally {
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);

test(
  'real DSH native approval is parked, listed and allowed once through HTTP',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    const adapter = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    await adapter.start();
    const workspace = new Workspace(adapter, { approvalTimeoutMs: 90_000 });
    const project: Project = {
      id: 'project-native-guard',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9d-guard-project-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-guard-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      guardTimeoutMs: 90_000,
    });

    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
      ): Promise<{ readonly status: number; readonly body: Record<string, any> }> => {
        const response = await fetch(`${info.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(150_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, any>,
        };
      };

      const marker = `APPROVED-GUARD-${String(Date.now())}`;
      const loaded = await request('POST', '/lives', {
        live: liveOf({
          schemaVersion: 1,
          id: 'native-guard',
          nodes: {
            only: {
              kind: 'forager',
              config: { connection: 'dsh', prompt: 'run {{input}}' },
            },
          },
          edges: [],
        }, { only: { kind: 'fresh', harness: 'dsh' } }),
        project,
      });
      assert.equal(loaded.status, 200);

      const triggerPromise = request('POST', '/lives/wake', {
        liveId: 'native-guard',
        beeId: 'only',
        input:
            `Use the shell tool to create a file named approved-guard.txt in the current directory ` +
            `with the exact content ${marker}. Report done. Do not use any other directory.`,
      });

      await waitFor(async () => {
        const guards = await request('GET', '/guards');
        return guards.status === 200 && (guards.body['guards'] as unknown[]).length === 1;
      });
      const listed = await request('GET', '/guards');
      const guard = (listed.body['guards'] as Record<string, unknown>[])[0];
      assert.ok(guard !== undefined);
      assert.equal(typeof guard['requestId'], 'string');
      assert.equal(typeof guard['summary'], 'string');
      assert.equal(
        JSON.stringify(listed.body).includes(marker),
        false,
        'guard listing must not carry the prompt body',
      );

      const decided = await request('POST', '/guard/decide', {
        requestId: guard['requestId'],
        decision: 'allow_once',
      });
      assert.equal(decided.status, 200);

      const trigger = await triggerPromise;
      assert.equal(trigger.status, 200);
      assert.equal(trigger.body['result']?.['rest'], true);
      assert.equal(
        readFileSync(join(project.directory, 'approved-guard.txt'), 'utf8'),
        marker,
      );
      const run = await request('GET', '/lives/native-guard/output');
      assert.equal(run.status, 200);
      assert.equal(run.body['operation'], 'trigger');
      assert.equal(typeof run.body['runId'], 'string');
      t.diagnostic(
        `observed: real DSH approval allowed once; marker written; run=${String(run.body['runId'])}`,
      );
    } finally {
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);
