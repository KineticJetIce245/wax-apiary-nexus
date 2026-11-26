/** B object layer: bees, beelines and the two persisted documents. */

export const BEE_KINDS = [
  'forager',
  'worker',
  'condition',
  'spread',
  'gather',
  'user',
] as const;

export type BeeKind = (typeof BEE_KINDS)[number];

export const SESSION_MODES = ['reuse', 'fresh_once', 'always_fresh'] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

/** Parameters used when a forager bee creates a native session. */
export interface SessionParams {
  readonly harness?: string;
  readonly model?: string;
  readonly reasoning?: string;
}

/** One execution position in a LiveHive. The record key is its beeId. */
export interface Bee {
  readonly kind: BeeKind;
  readonly config: Readonly<Record<string, unknown>>;
  /** Beeline ids whose `fromBee` is this bee. */
  readonly outgoing: readonly string[];
  /** Human-readable only; it never participates in routing or binding. */
  readonly roleLabel?: string;
  readonly sessionMode?: SessionMode;
}

/** One directed connection between two bees. The record key is its beelineId. */
export interface Beeline {
  readonly fromBee: string;
  readonly toBee: string;
  /** Spread branch label or condition outcome; optional for ordinary edges. */
  readonly branch?: string;
}

/**
 * One time configuration; it is not an execution identity. A scheduled wake
 * uses the existing empty text input because the B schedule has no input field.
 */
export interface Schedule {
  readonly scheduleId: string;
  readonly targetBee: string;
  /** Exactly one of `at` and `everyMs` is present. */
  readonly at?: string;
  /** Positive integer milliseconds; scheduled wakes use the empty input value. */
  readonly everyMs?: number;
}

/** Structure shared by a saved template and a live hive. */
export interface HiveGraph {
  readonly bees: Readonly<Record<string, Bee>>;
  readonly beelines: Readonly<Record<string, Beeline>>;
}

/**
 * A loaded graph. `live.json` is the only persisted home of the bindings; there
 * is deliberately no second binding document in this layer.
 */
export interface LiveHive extends HiveGraph {
  readonly schemaVersion: 1;
  readonly liveId: string;
  /** beeId -> sessionId; only bees that need a native session appear here. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly schedules?: readonly Schedule[];
}

/** A saved graph plus per-bee default session parameters. */
export interface HiveTemplate {
  readonly schemaVersion: 1;
  readonly templateId: string;
  readonly hive: HiveGraph;
  readonly defaults: Readonly<Record<string, SessionParams>>;
  readonly schedules?: readonly Schedule[];
}

/** One beeId -> sessionId pair. It has no identity of its own. */
export interface BeeBinding {
  readonly beeId: string;
  readonly sessionId: string;
}
