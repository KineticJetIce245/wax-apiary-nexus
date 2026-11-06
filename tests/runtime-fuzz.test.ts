import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  QueueFullError,
  serializeValue,
  type CompositionDefinition,
  type NodeExecutor,
  type PersistedField,
  type PheromoneFieldSnapshot,
  type Value,
} from '../src/runtime/index.js';
import { HoneyStore } from '../src/storage/honey.js';

/**
 * Deterministic seeded fuzz over the runtime state machine.
 *
 * Every seed replays the same script: a small PRNG picks trigger / answer /
 * clock / pump / empty-pump operations, and several checkpoints save the field
 * to Honey, load it back and restore a fresh runtime from it. The assertions
 * below are the invariants the runtime promises; nothing here perturbs the
 * runtime itself.
 */

const START = Date.parse('2026-09-01T00:00:00.000Z');
const SEEDS = [1, 2, 3, 4, 5] as const;
const STEPS = 200;
const CHECKPOINT_EVERY = 30;
const CLOCK_DELTAS = [0, 500, 1000, 2000, 10_000] as const;

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function padStep(step: number): string {
  return String(step).padStart(3, '0');
}

/** Root trigger values are fixed-width so one token can never be a prefix of another. */
function triggerToken(seed: number, step: number): string {
  return `s${seed}-${padStep(step)}`;
}

function warmupToken(seed: number): string {
  return `w${seed}-warm`;
}

function answerToken(seed: number, step: number): string {
  return `a${seed}-${padStep(step)}`;
}

/** mulberry32: tiny deterministic PRNG, no dependency. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const index = Math.floor(random() * values.length);
  const value = values[index];
  if (value === undefined) {
    throw new Error('pick() needs a non-empty list');
  }
  return value;
}

interface FuzzGraph {
  readonly name: string;
  readonly definition: CompositionDefinition;
  /** The only node this fuzz triggers directly. */
  readonly entry: string;
}

function foragerNode(): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'fake', prompt: 'run {{input}}' } };
}

function userNode(): Record<string, unknown> {
  return { kind: 'user', config: { modality: 'text', prompt: 'answer?' } };
}

/** start -> done, with a tiny queue/TTL so expiry and backpressure are reachable. */
function linearGraph(): FuzzGraph {
  return {
    name: 'linear',
    entry: 'start',
    definition: parseComposition({
      schemaVersion: 1,
      id: 'fuzz-linear',
      defaults: { minIntervalMs: 1000, queueMax: 2, queueTtlMs: 1500 },
      nodes: {
        start: foragerNode(),
        done: foragerNode(),
      },
      edges: [{ id: 'e1', from: 'start', to: 'done' }],
    }),
  };
}

/** start -> fan (a, b required; c late/optional) -> merge -> done. */
function forkMergeGraph(): FuzzGraph {
  return {
    name: 'fork-merge',
    entry: 'start',
    definition: parseComposition({
      schemaVersion: 1,
      id: 'fuzz-fork-merge',
      defaults: { minIntervalMs: 1000, queueMax: 6, queueTtlMs: 30_000 },
      nodes: {
        start: foragerNode(),
        fan: {
          kind: 'fork',
          config: {
            branches: [
              { id: 'a', to: 'work-a' },
              { id: 'b', to: 'work-b' },
              { id: 'c', to: 'work-c' },
            ],
          },
        },
        'work-a': foragerNode(),
        'work-b': foragerNode(),
        'work-c': foragerNode(),
        merge: {
          kind: 'merge',
          config: {
            required: ['b', 'a'],
            optional: ['c'],
            combine: 'object',
            timeoutMs: 12_000,
          },
        },
        done: foragerNode(),
      },
      edges: [
        { id: 'e1', from: 'start', to: 'fan' },
        { id: 'e2', from: 'work-a', to: 'merge' },
        { id: 'e3', from: 'work-b', to: 'merge' },
        { id: 'e4', from: 'work-c', to: 'merge' },
        { id: 'e5', from: 'merge', to: 'done' },
      ],
    }),
  };
}

/**
 * start -> outer-fork
 *   o-left  -> mid-fork
 *              m-left -> inner-fork (i-a, i-b -> inner-merge) -> mid-merge
 *              m-right -> mid-merge
 *   o-right -> ask-outer -> outer-merge
 * inner-merge -> mid-merge -> outer-merge -> done
 */
function nestedHoverGraph(): FuzzGraph {
  return {
    name: 'nested-hover',
    entry: 'start',
    definition: parseComposition({
      schemaVersion: 1,
      id: 'fuzz-nested-hover',
      defaults: { minIntervalMs: 1000, queueMax: 8, queueTtlMs: 30_000 },
      nodes: {
        start: foragerNode(),
        'outer-fork': {
          kind: 'fork',
          config: {
            branches: [
              { id: 'o-left', to: 'mid-fork' },
              { id: 'o-right', to: 'ask-outer' },
            ],
          },
        },
        'mid-fork': {
          kind: 'fork',
          config: {
            branches: [
              { id: 'm-left', to: 'inner-fork' },
              { id: 'm-right', to: 'mid-merge' },
            ],
          },
        },
        'inner-fork': {
          kind: 'fork',
          config: {
            branches: [
              { id: 'i-a', to: 'inner-merge' },
              { id: 'i-b', to: 'inner-merge' },
            ],
          },
        },
        'inner-merge': {
          kind: 'merge',
          config: { required: ['i-a', 'i-b'], combine: 'text' },
        },
        'mid-merge': {
          kind: 'merge',
          config: { required: ['m-left', 'm-right'], combine: 'text' },
        },
        'outer-merge': {
          kind: 'merge',
          config: { required: ['o-left', 'o-right'], combine: 'text' },
        },
        'ask-outer': userNode(),
        done: foragerNode(),
      },
      edges: [
        { id: 'e1', from: 'start', to: 'outer-fork' },
        { id: 'e2', from: 'inner-merge', to: 'mid-merge' },
        { id: 'e3', from: 'mid-merge', to: 'outer-merge' },
        { id: 'e4', from: 'ask-outer', to: 'outer-merge' },
        { id: 'e5', from: 'outer-merge', to: 'done' },
      ],
    }),
  };
}

interface ExecutedCall {
  readonly nodeId: string;
  readonly text: string;
  readonly step: number;
}

interface OpenHover {
  readonly nodeId: string;
  readonly token: string;
}

function openHovers(snapshot: PheromoneFieldSnapshot): OpenHover[] {
  const hovers: OpenHover[] = [];
  for (const [nodeId, node] of Object.entries(snapshot.nodes)) {
    if (node.hover !== undefined) {
      hovers.push({ nodeId, token: node.hover.token });
    }
  }
  return hovers;
}

/** Rest derived from the snapshot alone, without trusting `snapshot.rest`. */
function deriveRest(snapshot: PheromoneFieldSnapshot): boolean {
  for (const node of Object.values(snapshot.nodes)) {
    if (
      node.queue.length > 0 ||
      node.pending !== undefined ||
      node.active !== undefined ||
      node.hover !== undefined
    ) {
      return false;
    }
    for (const join of Object.values(node.joins ?? {})) {
      if (join.completedAt === undefined && join.timedOutAt === undefined) {
        return false;
      }
    }
  }
  return true;
}

interface FieldShape {
  readonly node: string;
  readonly queue: readonly string[];
  readonly pending: string | null;
  readonly hover: string | null;
  readonly joins: readonly string[];
  readonly openJoins: readonly string[];
}

/** Compact per-node counts used to compare a field before and after restore. */
function describeField(field: PersistedField): FieldShape[] {
  return Object.keys(field.nodes)
    .sort()
    .map((nodeId) => {
      const node = field.nodes[nodeId];
      if (node === undefined) {
        throw new Error(`describeField: missing node '${nodeId}'`);
      }
      const joins = Object.entries(node.joins ?? {})
        .map(([forkId, join]) => ({ forkId, join }))
        .sort((left, right) => left.forkId.localeCompare(right.forkId));
      return {
        node: nodeId,
        queue: node.queue.map((pheromone) => pheromone.id),
        pending: node.pending?.id ?? null,
        hover: node.hover?.token ?? null,
        joins: joins.map((entry) => entry.forkId),
        openJoins: joins
          .filter(
            (entry) =>
              entry.join.completedAt === undefined && entry.join.timedOutAt === undefined,
          )
          .map((entry) => entry.forkId),
      };
    });
}

type Action = 'clock' | 'trigger' | 'answer' | 'pump' | 'empty-pump';

const ACTIONS: readonly Action[] = [
  'trigger',
  'trigger',
  'clock',
  'clock',
  'clock',
  'clock',
  'answer',
  'answer',
  'pump',
  'pump',
  'pump',
  'empty-pump',
];

const tempRoot = mkdtempSync(join(tmpdir(), 'wax-runtime-fuzz-'));

function newStore(graph: FuzzGraph, seed: number): HoneyStore {
  const root = mkdtempSync(join(tempRoot, `${graph.name}-${String(seed)}-`));
  return HoneyStore.forComposition(root, 'fuzz', graph.definition.id);
}

async function runSeed(graph: FuzzGraph, seed: number): Promise<void> {
  const store = newStore(graph, seed);
  const random = mulberry32(seed);
  const log = createMemoryLog();
  const definition = graph.definition;
  const queueMax = definition.defaults.queueMax;
  const queueTtlMs = definition.defaults.queueTtlMs;

  let clock = START;
  let currentStep = -1;
  const calls: ExecutedCall[] = [];
  const seenCalls = new Map<string, ExecutedCall>();
  const acceptedRoots: string[] = [];
  const closedJoins = new Set<string>();
  let scannedLogEntries = 0;

  const where = (step: number): string => `graph=${graph.name} seed=${String(seed)} step=${String(step)}`;

  const executor: NodeExecutor = {
    async execute(node, input) {
      const serialized = serializeValue(input);
      const key = `${node.id}\u0000${serialized}`;
      const previous = seenCalls.get(key);
      if (previous !== undefined) {
        throw new Error(
          `${where(currentStep)}: node '${node.id}' executed twice with the same input '${serialized}' (steps ${String(previous.step)} and ${String(currentStep)})`,
        );
      }
      const call: ExecutedCall = { nodeId: node.id, text: serialized, step: currentStep };
      seenCalls.set(key, call);
      calls.push(call);
      return { kind: 'text', text: `${node.id}>${serialized}` };
    },
  };

  let runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => clock,
    onLog: log.sink,
  });

  function scanLog(step: number): void {
    for (; scannedLogEntries < log.entries.length; scannedLogEntries += 1) {
      const entry = log.entries[scannedLogEntries];
      if (entry?.event === 'node.failed') {
        throw new Error(
          `${where(step)}: unexpected node.failed event: ${JSON.stringify(entry)}`,
        );
      }
    }
  }

  function checkFifoAndCapacity(step: number, snapshot: PheromoneFieldSnapshot): void {
    for (const [nodeId, node] of Object.entries(snapshot.nodes)) {
      let previousAt = Number.NEGATIVE_INFINITY;
      for (const pheromone of node.queue) {
        const at = Date.parse(pheromone.at);
        assert.ok(
          Number.isFinite(at),
          `${where(step)}: node '${nodeId}' queued a Pheromone with an unparseable at '${pheromone.at}'`,
        );
        assert.ok(
          at >= previousAt,
          `${where(step)}: node '${nodeId}' queue is not FIFO: at '${pheromone.at}' follows a later timestamp`,
        );
        previousAt = at;
      }
      assert.ok(
        node.queue.length <= queueMax,
        `${where(step)}: node '${nodeId}' queue length ${String(node.queue.length)} exceeds queueMax ${String(queueMax)}`,
      );
    }
  }

  function checkClosedJoins(step: number, snapshot: PheromoneFieldSnapshot): void {
    for (const [nodeId, node] of Object.entries(snapshot.nodes)) {
      for (const [forkId, join] of Object.entries(node.joins ?? {})) {
        const key = `${nodeId}\u0000${forkId}`;
        const completed = join.completedAt !== undefined;
        const timedOut = join.timedOutAt !== undefined;
        if (!completed && !timedOut) {
          assert.ok(
            !closedJoins.has(key),
            `${where(step)}: closed join '${forkId}' on '${nodeId}' reopened`,
          );
          continue;
        }
        assert.ok(
          !(completed && timedOut),
          `${where(step)}: join '${forkId}' on '${nodeId}' is both completed and timed out`,
        );
        assert.equal(
          join.arrived.length,
          0,
          `${where(step)}: closed join '${forkId}' on '${nodeId}' still holds arrived branches`,
        );
        closedJoins.add(key);
      }
    }
  }

  function checkWaitSlotsFresh(step: number, snapshot: PheromoneFieldSnapshot): void {
    for (const [nodeId, node] of Object.entries(snapshot.nodes)) {
      const waiting: [string, { readonly at: string }][] = [
        ...node.queue.map((pheromone): [string, { readonly at: string }] => [
          'queue',
          pheromone,
        ]),
      ];
      if (node.pending !== undefined) {
        waiting.push(['pending', node.pending]);
      }
      for (const [slot, pheromone] of waiting) {
        const at = Date.parse(pheromone.at);
        assert.ok(
          Number.isFinite(at),
          `${where(step)}: node '${nodeId}' ${slot} Pheromone has an unparseable at '${pheromone.at}'`,
        );
        assert.ok(
          clock - at < queueTtlMs,
          `${where(step)}: node '${nodeId}' ${slot} entry is older than queueTtlMs after pump (age=${String(clock - at)}ms, ttl=${String(queueTtlMs)}ms)`,
        );
      }
    }
  }

  function checkInvariants(step: number, afterPump: boolean): void {
    scanLog(step);
    const snapshot = runtime.snapshot();
    checkFifoAndCapacity(step, snapshot);
    checkClosedJoins(step, snapshot);

    const derived = deriveRest(snapshot);
    assert.equal(
      snapshot.rest,
      derived,
      `${where(step)}: snapshot.rest=${String(snapshot.rest)} disagrees with independently derived Rest=${String(derived)}`,
    );

    if (afterPump) {
      checkWaitSlotsFresh(step, snapshot);
    }
  }

  async function pump(step: number): Promise<void> {
    await runtime.pump();
    checkInvariants(step, true);
  }

  async function checkpoint(step: number): Promise<void> {
    // Pump first: a checkpoint must not be failed merely because a queued entry
    // was already older than queueTtlMs before the restore-time sweep runs.
    await pump(step);

    const exported = runtime.exportField();
    store.save(exported);
    const loaded = store.load();
    if (loaded === undefined) {
      throw new Error(`${where(step)}: HoneyStore.load() returned undefined after save`);
    }
    assert.deepEqual(
      loaded,
      exported,
      `${where(step)}: Honey save/load round-trip changed the field`,
    );

    const beforeShape = describeField(exported);
    const openHoversBefore = openHovers(runtime.snapshot());
    const callsBeforeRestore = calls.length;
    const { runtime: restored, report } = PheromoneRuntime.restore(definition, loaded, {
      executeForager: executor,
      now: () => clock,
      onLog: log.sink,
    });
    assert.equal(
      calls.length,
      callsBeforeRestore,
      `${where(step)}: restore executed a node`,
    );
    assert.deepEqual(
      report.unknownActive,
      [],
      `${where(step)}: restore lost an active forager`,
    );
    assert.deepEqual(
      report.stuckActive,
      [],
      `${where(step)}: restore found a stuck active node`,
    );
    assert.equal(
      report.resumedHovers.length,
      openHoversBefore.length,
      `${where(step)}: restore resumed ${String(report.resumedHovers.length)} hovers, expected ${String(openHoversBefore.length)}`,
    );

    const restoredField = restored.exportField();
    assert.deepEqual(
      describeField(restoredField),
      beforeShape,
      `${where(step)}: restore changed queue/pending/hover/join counts`,
    );
    assert.deepEqual(
      restoredField,
      exported,
      `${where(step)}: restored field differs from the field saved at the same clock`,
    );

    runtime = restored;
    checkInvariants(step, true);

    // A restored field at Rest is empty: pumping it must not call any executor.
    if (restoredField.rest) {
      const callsAtRest = calls.length;
      await runtime.pump();
      assert.equal(
        calls.length,
        callsAtRest,
        `${where(step)}: an empty pump after restore called the executor`,
      );
      checkInvariants(step, true);
    }
  }

  // Deterministic warm-up: one root trigger and one pump make every graph
  // active, so the first checkpoint has something to persist (a waiting join
  // and, on the hover graph, an open user hover).
  currentStep = -1;
  const warm = warmupToken(seed);
  runtime.trigger(graph.entry, text(warm));
  acceptedRoots.push(warm);
  await checkpoint(-1);

  for (let step = 0; step < STEPS; step += 1) {
    currentStep = step;
    const action = pick(random, ACTIONS);
    let pumped = false;

    if (action === 'clock') {
      clock += pick(random, CLOCK_DELTAS);
    } else if (action === 'trigger') {
      const token = triggerToken(seed, step);
      try {
        runtime.trigger(graph.entry, text(token));
        acceptedRoots.push(token);
      } catch (error) {
        // queueMax backpressure is a documented outcome, not a fuzz failure.
        if (!(error instanceof QueueFullError)) {
          throw error;
        }
      }
    } else if (action === 'answer') {
      const hovers = openHovers(runtime.snapshot());
      if (hovers.length > 0) {
        const hover = pick(random, hovers);
        try {
          runtime.answerHover(hover.nodeId, text(answerToken(seed, step)), hover.token);
        } catch (error) {
          if (!(error instanceof QueueFullError)) {
            throw error;
          }
        }
      }
    } else if (action === 'pump') {
      await pump(step);
      pumped = true;
    } else {
      const snapshot = runtime.snapshot();
      if (snapshot.rest) {
        const before = runtime.exportField();
        const callsBefore = calls.length;
        await runtime.pump();
        assert.deepEqual(
          runtime.exportField(),
          before,
          `${where(step)}: an empty pump changed the field`,
        );
        assert.equal(
          calls.length,
          callsBefore,
          `${where(step)}: an empty pump executed a node`,
        );
        checkInvariants(step, true);
        pumped = true;
      }
    }

    if (!pumped) {
      checkInvariants(step, false);
    }

    if ((step + 1) % CHECKPOINT_EVERY === 0) {
      currentStep = step;
      await checkpoint(step);
    }
  }

  currentStep = STEPS;
  await pump(STEPS);
  await checkpoint(STEPS);

  // Every accepted root carries a unique value that every executor prepends to,
  // so a terminal executed twice would show up as a repeated terminal input.
  const doneCalls = calls.filter((call) => call.nodeId === 'done');
  assert.ok(
    doneCalls.length <= acceptedRoots.length,
    `${where(STEPS)}: done ran ${String(doneCalls.length)} times for ${String(acceptedRoots.length)} accepted root triggers`,
  );

  const doneInputs = new Set<string>();
  const donePerRoot = new Map<string, number>();
  for (const call of doneCalls) {
    assert.ok(
      !doneInputs.has(call.text),
      `${where(call.step)}: terminal 'done' executed the same input twice: '${call.text}'`,
    );
    doneInputs.add(call.text);

    const roots = acceptedRoots.filter((token) => call.text.includes(token));
    assert.equal(
      roots.length,
      1,
      `${where(call.step)}: terminal input '${call.text}' does not map to exactly one root trigger`,
    );
    const root = roots[0];
    if (root === undefined) {
      throw new Error(`${where(call.step)}: terminal input lost its root trigger`);
    }
    const previous = donePerRoot.get(root) ?? 0;
    assert.equal(
      previous,
      0,
      `${where(call.step)}: root '${root}' reached terminal 'done' more than once`,
    );
    donePerRoot.set(root, previous + 1);
  }
}

test('seeded fuzz: linear start -> done keeps FIFO, queueMax, TTL, Rest and terminal uniqueness', async () => {
  const graph = linearGraph();
  for (const seed of SEEDS) {
    await runSeed(graph, seed);
  }
});

test('seeded fuzz: fork/optional/timeout merge keeps joins closed and terminal unique', async () => {
  const graph = forkMergeGraph();
  for (const seed of SEEDS) {
    await runSeed(graph, seed);
  }
});

test('seeded fuzz: three-level nested fork/merge with user hover survives Honey restore', async () => {
  const graph = nestedHoverGraph();
  for (const seed of SEEDS) {
    await runSeed(graph, seed);
  }
});
