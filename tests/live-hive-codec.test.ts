import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromCompositionDefinition,
  toCompositionDefinition,
  toGraphBindings,
} from '../src/b/live-hive-codec.js';
import type { LiveHive } from '../src/b/types.js';
import {
  BObjectValidationError,
  parseLiveHive,
} from '../src/b/validation.js';
import {
  conditionLiveHive,
  spreadLiveHive,
  simpleLiveHive,
} from './support/b-object-fixtures.js';

function withBeeConfig(
  live: LiveHive,
  beeId: string,
  config: Readonly<Record<string, unknown>>,
): LiveHive {
  return {
    ...live,
    bees: {
      ...live.bees,
      [beeId]: { ...live.bees[beeId]!, config },
    },
  };
}

function validationError(live: LiveHive): string {
  try {
    parseLiveHive(live);
  } catch (error) {
    assert.ok(error instanceof BObjectValidationError);
    return error.issues.join('\n');
  }
  assert.fail('expected the live object to be rejected');
}

test('LiveHive -> CompositionDefinition preserves ids, kinds, edges and graphRevision', () => {
  const live = simpleLiveHive();
  const composition = toCompositionDefinition(live);

  assert.equal(composition.id, 'demo');
  assert.match(composition.graphRevision, /^[0-9a-f]{12}$/);
  assert.deepEqual([...composition.nodes.keys()], ['draft', 'review', 'done']);
  assert.equal(composition.nodes.get('draft')?.kind, 'forager');
  assert.deepEqual(
    composition.edges.map((edge) => [edge.id, edge.from, edge.to]),
    [
      ['l1', 'draft', 'review'],
      ['l2', 'review', 'done'],
    ],
  );
  assert.deepEqual(composition.triggers, []);
  assert.equal(composition.nodes.get('draft')?.minIntervalMs, 1_000);
  assert.equal(composition.defaults.minIntervalMs, 1_000);
});

test('LiveHive -> CompositionDefinition is deterministic and tracks config changes', () => {
  const first = toCompositionDefinition(simpleLiveHive());
  const second = toCompositionDefinition(simpleLiveHive());
  assert.equal(first.graphRevision, second.graphRevision);

  const changed = simpleLiveHive();
  const draft = changed.bees['draft']!;
  const modified: LiveHive = {
    ...changed,
    bees: {
      ...changed.bees,
      draft: { ...draft, config: { ...draft.config, prompt: 'different' } },
    },
  };
  assert.notEqual(
    toCompositionDefinition(modified).graphRevision,
    first.graphRevision,
  );
});

test('spread targets stay in config and become no normal edges', () => {
  const composition = toCompositionDefinition(spreadLiveHive());
  assert.deepEqual(
    composition.edges.map((edge) => edge.id).sort(),
    ['lm', 'rm', 'to-spread'],
  );
  const spread = composition.nodes.get('spread');
  assert.ok(spread !== undefined && spread.kind === 'spread');
  assert.deepEqual(spread.config, {
    strategy: 'clone',
    targets: ['left', 'right'],
  });
});

test('spread config is never derived from beelines and needs targets', () => {
  const live = spreadLiveHive();
  const spread = live.bees['spread']!;
  const withEdge: LiveHive = {
    ...live,
    bees: { ...live.bees, spread: { ...spread, outgoing: ['smuggled'] } },
    beelines: {
      ...live.beelines,
      smuggled: { fromBee: 'spread', toBee: 'left' },
    },
  };
  assert.match(validationError(withEdge), /has no outgoing beeline/);

  const missingTargets = withBeeConfig(live, 'spread', { strategy: 'clone' });
  assert.match(validationError(missingTargets), /BeeId array or a BeeId map/);

  const oldBranches = withBeeConfig(live, 'spread', {
    branches: [{ id: 'a', to: 'left' }],
  });
  assert.match(validationError(oldBranches), /unknown field 'branches'/);
});

test('spread clone map targets round-trip', () => {
  const live = withBeeConfig(spreadLiveHive(), 'spread', {
    strategy: 'clone',
    targets: { left: true, right: { reason: 'second' } },
  });
  const composition = toCompositionDefinition(live);
  const spread = composition.nodes.get('spread');
  assert.ok(spread !== undefined && spread.kind === 'spread');
  assert.deepEqual(spread.config, {
    strategy: 'clone',
    targets: { left: true, right: { reason: 'second' } },
  });

  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.bees['spread']?.config, spread.config);
  assert.equal(
    toCompositionDefinition(imported).graphRevision,
    composition.graphRevision,
  );
});

test('spread cleave round-trips its BeeId -> dot-path targets', () => {
  const live = withBeeConfig(spreadLiveHive(), 'spread', {
    strategy: 'cleave',
    targets: { left: ['message'], right: ['message', 'meta.score'] },
  });
  const composition = toCompositionDefinition(live);
  const spread = composition.nodes.get('spread');
  assert.ok(spread !== undefined && spread.kind === 'spread');
  assert.deepEqual(spread.config, {
    strategy: 'cleave',
    targets: { left: ['message'], right: ['message', 'meta.score'] },
  });

  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.bees['spread']?.config, spread.config);
  assert.deepEqual(imported.bees['spread']?.outgoing, []);
  assert.equal(
    Object.values(imported.beelines).some((line) => line.fromBee === 'spread'),
    false,
  );
  assert.equal(
    toCompositionDefinition(imported).graphRevision,
    composition.graphRevision,
  );
});

test('gather assemble round-trips types, count, groupBy and typeQueueMax', () => {
  const config = {
    strategy: 'assemble',
    groupBy: 'meta.topic',
    types: {
      left: {
        match: { path: 'side', equals: 'left' },
        count: 1,
        reads: ['message'],
      },
      right: {
        match: { path: 'meta.score', type: 'number' },
        count: 2,
        reads: ['message', 'meta.score'],
      },
    },
    typeQueueMax: 8,
  };
  const live = withBeeConfig(spreadLiveHive(), 'gather', config);
  const composition = toCompositionDefinition(live);
  const gather = composition.nodes.get('gather');
  assert.ok(gather !== undefined && gather.kind === 'gather');
  assert.deepEqual(gather.config, config);

  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.bees['gather']?.config, config);
  assert.equal(
    toCompositionDefinition(imported).graphRevision,
    composition.graphRevision,
  );
});

test('gather defaults to assemble when strategy is omitted', () => {
  const live = withBeeConfig(spreadLiveHive(), 'gather', {
    types: {
      left: {
        match: { path: 'side', equals: 'left' },
        count: 1,
        reads: ['message'],
      },
    },
  });
  const composition = toCompositionDefinition(live);
  const gather = composition.nodes.get('gather');
  assert.ok(gather !== undefined && gather.kind === 'gather');
  assert.equal(gather.config['strategy'], 'assemble');
  assert.equal(gather.config['typeQueueMax'], 256);
});

test('gather batch round-trips a signal and omits count from its types', () => {
  const live = withBeeConfig(spreadLiveHive(), 'gather', {
    strategy: 'batch',
    batch: { signal: { path: 'secrete', equals: true } },
    types: {
      right: {
        match: { path: 'side', equals: 'right' },
        reads: ['message'],
      },
    },
    typeQueueMax: 8,
  });
  const composition = toCompositionDefinition(live);
  const gather = composition.nodes.get('gather');
  assert.ok(gather !== undefined && gather.kind === 'gather');
  assert.deepEqual(gather.config, {
    strategy: 'batch',
    batch: { signal: { path: 'secrete', equals: true } },
    types: {
      right: {
        match: { path: 'side', equals: 'right' },
        count: 1,
        reads: ['message'],
      },
    },
    typeQueueMax: 8,
  });

  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.bees['gather']?.config, {
    strategy: 'batch',
    batch: { signal: { path: 'secrete', equals: true } },
    types: {
      right: {
        match: { path: 'side', equals: 'right' },
        reads: ['message'],
      },
    },
    typeQueueMax: 8,
  });
  assert.equal(
    toCompositionDefinition(imported).graphRevision,
    composition.graphRevision,
  );
});

test('invalid gather configs are rejected by live.json validation', () => {
  const base = spreadLiveHive();
  const assemble = base.bees['gather']!.config;

  assert.match(
    validationError(withBeeConfig(base, 'gather', {
      required: ['left', 'right'],
      combine: 'text',
    })),
    /unknown field 'required'/,
  );
  assert.match(
    validationError(withBeeConfig(base, 'gather', {
      ...assemble,
      strategy: 'batch',
      batch: { signal: { path: 'go', equals: true } },
      types: {
        left: { match: { path: 'side', equals: 'left' }, count: 1, reads: [] },
      },
    })),
    /count: not allowed with strategy 'batch'/,
  );
  assert.match(
    validationError(withBeeConfig(base, 'gather', {
      ...assemble,
      strategy: 'batch',
      groupBy: 'meta.topic',
      batch: { signal: { path: 'go', equals: true } },
      types: {
        left: { match: { path: 'side', equals: 'left' }, reads: [] },
      },
    })),
    /groupBy: not allowed with strategy 'batch'/,
  );
  assert.match(
    validationError(withBeeConfig(base, 'gather', {
      ...assemble,
      types: {
        left: {
          match: { path: 'side', equals: 'left' },
          count: 1,
          reads: ['message'],
        },
      },
      typeQueueMax: 0,
    })),
    /typeQueueMax: expected a positive integer/,
  );
});

test('invalid spread targets and cleave paths are rejected', () => {
  const base = spreadLiveHive();
  assert.match(
    validationError(withBeeConfig(base, 'spread', {
      strategy: 'clone',
      targets: ['missing'],
    })),
    /unknown bee 'missing'/,
  );
  assert.match(
    validationError(withBeeConfig(base, 'spread', {
      strategy: 'cleave',
      targets: { left: 'message' },
    })),
    /non-empty dot-path array/,
  );
  assert.match(
    validationError(withBeeConfig(base, 'spread', {
      strategy: 'clone',
      targets: [],
    })),
    /at least one target BeeId/,
  );
});

test('condition beelines use when, not branch', () => {
  const composition = toCompositionDefinition(conditionLiveHive());
  const conditionEdges = composition.edges.filter((edge) => edge.from === 'condition');
  assert.deepEqual(
    conditionEdges.map((edge) => [edge.id, edge.when, edge.to]),
    [
      ['yes', 'true', 'done'],
      ['no', 'false', 'done'],
    ],
  );

  const live = conditionLiveHive();
  const oldBranch = live.beelines['yes'] as unknown as Record<string, unknown>;
  const broken: LiveHive = {
    ...live,
    beelines: {
      ...live.beelines,
      yes: { ...oldBranch, branch: 'true' } as never,
    },
  };
  assert.match(validationError(broken), /unknown field 'branch'/);

  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.beelines['yes'], {
    fromBee: 'condition',
    toBee: 'done',
    when: 'true',
  });
  assert.deepEqual(imported.beelines['no'], {
    fromBee: 'condition',
    toBee: 'done',
    when: 'false',
  });
});

test('a condition beeline without a true/false outcome is a validation error', () => {
  const live = conditionLiveHive();
  const broken: LiveHive = {
    ...live,
    beelines: {
      ...live.beelines,
      yes: { fromBee: 'condition', toBee: 'done' },
    },
  };
  assert.match(validationError(broken), /expected exactly one 'true'/);
  assert.throws(() => toCompositionDefinition(broken), BObjectValidationError);
});

test('a spread target cannot be smuggled through a beeline', () => {
  const live = conditionLiveHive();
  const broken: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      condition: {
        ...live.bees['condition']!,
        kind: 'spread',
        config: { strategy: 'clone', targets: ['done'] },
      },
    },
  };
  assert.match(validationError(broken), /has no outgoing beeline/);
  assert.throws(() => toCompositionDefinition(broken), BObjectValidationError);
});

test('graphRevision changes with spread targets and gather counts', () => {
  const base = toCompositionDefinition(spreadLiveHive());
  const changedSpread = withBeeConfig(spreadLiveHive(), 'spread', {
    strategy: 'clone',
    targets: ['right', 'left'],
  });
  assert.notEqual(
    toCompositionDefinition(changedSpread).graphRevision,
    base.graphRevision,
  );

  const changedGather = withBeeConfig(spreadLiveHive(), 'gather', {
    ...(spreadLiveHive().bees['gather']!.config as Record<string, unknown>),
    typeQueueMax: 9,
  });
  assert.notEqual(
    toCompositionDefinition(changedGather).graphRevision,
    base.graphRevision,
  );
});

test('toGraphBindings includes only forager bindings', () => {
  const live = simpleLiveHive();
  const withUser: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      done: { kind: 'user', config: { modality: 'text', prompt: 'done' }, outgoing: [] },
    },
    bindings: { ...live.bindings, done: 's3' },
  };
  assert.deepEqual(toGraphBindings(withUser), {
    draft: { kind: 'session', sessionId: 's1' },
    review: { kind: 'session', sessionId: 's2' },
  });
});

test('B schedules map to and from composition triggers', () => {
  const live: LiveHive = {
    ...simpleLiveHive(),
    schedules: [
      { scheduleId: 'once', targetBee: 'draft', at: '2026-01-01T00:00:00Z' },
      { scheduleId: 'tick', targetBee: 'review', everyMs: 1_000 },
    ],
  };
  const composition = toCompositionDefinition(live);
  assert.deepEqual(composition.triggers, [
    {
      id: 'once',
      target: 'draft',
      schedule: { kind: 'at', at: '2026-01-01T00:00:00Z' },
    },
    {
      id: 'tick',
      target: 'review',
      schedule: { kind: 'every', everyMs: 1_000 },
    },
  ]);

  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.schedules, live.schedules);
});

test('codec does not mutate the LiveHive object', () => {
  const live = spreadLiveHive();
  const before = JSON.stringify(live);
  toCompositionDefinition(live);
  toGraphBindings(live);
  assert.equal(JSON.stringify(live), before);
});
