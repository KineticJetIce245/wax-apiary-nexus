import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { runGuardCli } from '../../src/cli/guard-cli.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { parseComposition } from '../../src/runtime/index.js';
import {
  autoDecideGuards,
  settleWakeWith,
  type GuardAutoDecider,
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
      ? 'Real guard CLI test needs DSH_ROOT (built CLI) and DEEPSEEK_API_KEY'
      : false,
  timeout: 180_000,
};

interface Invocation {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

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
  throw new Error('timed out waiting for native guard state');
}

async function invokeGuard(
  argv: readonly string[],
  daemonDir: string,
): Promise<Invocation> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runGuardCli([...argv, '--daemon-dir', daemonDir], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: {},
  });
  return { code, stdout, stderr };
}

async function listGuards(daemonDir: string): Promise<{
  readonly invocation: Invocation;
  readonly guards: Record<string, unknown>[];
}> {
  const invocation = await invokeGuard(['guard', 'list', '--json'], daemonDir);
  assert.equal(invocation.code, 0, invocation.stderr.join(' | '));
  assert.equal(invocation.stdout.length, 1, 'guard list --json must print one line');
  const body = JSON.parse(invocation.stdout[0] as string) as Record<string, unknown>;
  const guards = body['guards'];
  assert.equal(Array.isArray(guards), true);
  return { invocation, guards: guards as Record<string, unknown>[] };
}

test(
  'real DSH guard is listed and allowed once through the wax guard CLI',
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
      id: 'project-native-guard-cli',
      directory: mkdtempSync(join(tmpdir(), 'wax-m14-guard-cli-project-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m14-guard-cli-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir,
      guardTimeoutMs: 90_000,
    });

    let autoDecider: GuardAutoDecider | undefined;
    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
      ): Promise<{ readonly status: number; readonly body: Record<string, any>; readonly text: string }> => {
        const response = await fetch(`${info.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(150_000),
        });
        const text = await response.text();
        return {
          status: response.status,
          body: JSON.parse(text) as Record<string, any>,
          text,
        };
      };

      const marker = `CLI-APPROVED-GUARD-${String(Date.now())}`;
      const loaded = await request('POST', '/lives', {
        live: liveOf({
          schemaVersion: 1,
          id: 'native-guard-cli',
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
      assert.equal(loaded.status, 200, loaded.text);

      const prompt =
        `Use the shell tool to create a file named cli-guard.txt in the current directory ` +
        `with the exact content ${marker}. Report done. Do not use any other directory.`;
      const triggerPromise = request('POST', '/lives/wake', {
        liveId: 'native-guard-cli',
        beeId: 'only',
        input: prompt,
      });
      // The wake is awaited after the decision. Keep a cleanup-time reset from
      // surfacing as an unhandled rejection that would hide the real failure.
      triggerPromise.catch(() => undefined);

      await waitFor(async () => {
        const pending = await request('GET', '/guards');
        return (pending.body['guards'] as unknown[]).length === 1;
      });

      const listed = await listGuards(daemonDir);
      const guard = listed.guards[0];
      assert.ok(guard !== undefined);
      assert.equal(typeof guard['requestId'], 'string');
      assert.equal(typeof guard['executionId'], 'string');
      assert.equal(typeof guard['summary'], 'string');
      assert.deepEqual(Object.keys(guard).sort(), [
        'beeId',
        'createdAt',
        'executionId',
        'liveId',
        'options',
        'requestId',
        'sessionId',
        'summary',
      ]);
      const sessions = await request('GET', '/sessions');
      assert.equal(sessions.status, 200, sessions.text);
      const boundSessions = sessions.body['sessions'] as
        | { sessionId: string; harness: string }[]
        | undefined;
      assert.equal(boundSessions?.length, 1);
      const sessionId = String(guard['sessionId']);
      assert.equal(guard['liveId'], 'native-guard-cli');
      assert.equal(guard['beeId'], 'only');
      assert.equal(sessionId.length > 0, true);
      assert.equal(boundSessions?.[0]?.sessionId, sessionId);
      assert.equal(boundSessions?.[0]?.harness, 'dsh');
      assert.equal(listed.invocation.stdout[0]?.includes(marker), false);
      assert.equal(listed.invocation.stdout[0]?.includes(prompt), false);
      assert.equal(listed.invocation.stdout[0]?.includes(token), false);

      const requestId = String(guard['requestId']);
      const human = await invokeGuard(['guard', 'list'], daemonDir);
      assert.equal(human.code, 0, human.stderr.join(' | '));
      assert.equal(human.stdout.length, 1);
      assert.equal((human.stdout[0] as string).includes(requestId), true);
      assert.equal(
        (human.stdout[0] as string).includes(
          `live=native-guard-cli bee=only session=${sessionId}`,
        ),
        true,
      );
      assert.equal((human.stdout[0] as string).includes(marker), false);
      assert.equal((human.stdout[0] as string).includes(token), false);

      autoDecider = autoDecideGuards(
        info.url,
        token,
        [requestId],
        () => 'allow_once',
        (extraRequestId, decision) =>
          t.diagnostic(`extra guard decided requestId=${extraRequestId} decision=${decision}`),
      );

      const decided = await invokeGuard(
        ['guard', 'decide', requestId, '--decision', 'allow_once', '--json'],
        daemonDir,
      );
      assert.equal(decided.code, 0, decided.stderr.join(' | '));
      assert.deepEqual(JSON.parse(decided.stdout[0] as string), {
        requestId,
        decision: 'allow_once',
      });
      assert.equal((decided.stdout[0] as string).includes(token), false);

      const trigger = await settleWakeWith(request, 'native-guard-cli', triggerPromise);
      assert.equal(trigger['state'], 'completed');
      assert.equal(
        readFileSync(join(project.directory, 'cli-guard.txt'), 'utf8'),
        marker,
      );
      await waitFor(async () => (await listGuards(daemonDir)).guards.length === 0);
      t.diagnostic(
        `observed: real DSH guard listed and allowed once through the CLI; ` +
          `requestId=${requestId}; cli-guard.txt content matched`,
      );
    } finally {
      await autoDecider?.stop();
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);
