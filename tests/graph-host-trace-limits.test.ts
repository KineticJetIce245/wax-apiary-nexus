import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LiveHiveHost,
  type LiveHiveRunView,
} from '../src/daemon/graph-host.js';
import { TraceLimitError } from '../src/runtime/index.js';
import {
  FakeClock,
  allFresh,
  fastDefinition,
  forager,
  makeEnv,
  text,
  waitUntil,
} from './support/graph-host-fixtures.js';

function outputText(run: LiveHiveRunView): string {
  const value = run.outputs[0]?.value;
  assert.ok(value !== undefined, 'run has no output');
  const typed = value as { kind?: unknown; text?: unknown };
  assert.equal(typed.kind, 'text');
  assert.equal(typeof typed.text, 'string');
  return typed.text as string;
}

function hostGraph(): ReturnType<typeof fastDefinition> {
  return fastDefinition(
    'host-trace-limits',
    {
      start: forager('start {{input}}'),
      a: forager('a {{input}}'),
      b: forager('b {{input}}'),
      other: forager('other {{input}}'),
    },
    [
      { id: 'e1', from: 'start', to: 'a' },
      { id: 'e2', from: 'a', to: 'b' },
      { id: 'e3', from: 'b', to: 'a' },
    ],
  );
}

async function setupHost(): Promise<{ env: ReturnType<typeof makeEnv>; host: LiveHiveHost }> {
  const env = makeEnv();
  const clock = new FakeClock(1_000);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: clock.now,
    maxHopsPerTrace: 4,
  });
  const definition = hostGraph();
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });
  return { env, host };
}

function assertCycleRun(host: LiveHiveHost, run: LiveHiveRunView, runId: string): void {
  assert.equal(run.state, 'cancelled');
  assert.equal(run.error, 'trace-limit');
  const reason = host.runs.failureOf(runId);
  assert.ok(reason instanceof TraceLimitError);
  assert.equal(reason.reason, 'trace-limit');
  assert.equal(reason.limit, 'hops');
  assert.equal(reason.max, 4);
}

test('host hop limit cancels only its trace; another wake still completes', async (t) => {
  const { env, host } = await setupHost();
  t.after(async () => {
    await host.dispose();
    await env.workspace.stop();
  });

  const cycle = await host.trigger('host-trace-limits', 'start', text('cycle'));
  const independent = await host.trigger('host-trace-limits', 'other', text('independent'));
  const cycleRun = await host.runs.wait(cycle.runId);
  const independentRun = await host.runs.wait(independent.runId);
  await host.runs.waitSettled(cycle.runId);

  assertCycleRun(host, cycleRun, cycle.runId);
  assert.equal(independentRun.state, 'completed');
  assert.equal(independentRun.outputs.length, 1);
  assert.equal(independentRun.outputs[0]?.nodeId, 'other');
  assert.match(outputText(independentRun), /independent/);

  await waitUntil(
    () => host.statusOf('host-trace-limits')?.rest === true,
    'the hive to return to Rest after both traces end',
  );

  // The cancellation must not turn into a hive-wide failure: the same graph
  // still accepts a fresh, unrelated wake.
  const after = await host.trigger('host-trace-limits', 'other', text('after'));
  const afterRun = await host.runs.wait(after.runId);
  assert.equal(afterRun.state, 'completed');
  assert.match(outputText(afterRun), /after/);
  assert.equal(host.runs.get('host-trace-limits', cycle.runId)?.state, 'cancelled');
  assert.ok(env.adapter.allPrompts.length > 0);
});
