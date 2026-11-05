# WAX Apiary neXus — Architecture

> **Status**: target design. The PheromoneField single-Pheromone slice, Stage 3A Fork/Merge/Branch, the Stage 5A optional Merge branches, Stage 5B Merge timeout, Stage 5C structured Value and object/array Merge combine, Stage 3B Worker/Condition worker, the Stage 3C-1 foreground daemon scheduler, the Stage 3C-2 rich manual user input, the Stage 4A offline composition editor, the Stage 4B-A JSON CLI contract for that editor, the Stage 4C read-only revision audit and orphan-temp inspection, and the Stage 4D DSH harness wiring are implemented; scheduled `user` triggers are still open. This document and [`CONTRACT.md`](CONTRACT.md) are the current design references.

## 1. One sentence

An **Apiary** holds **Compositions**; a Composition is a live graph; its runtime state is a **PheromoneField** — short-lived **Pheromones** moving through nodes, plus node queues and waits — with **no cursor object, no Run, and no child composition**.

## 2. Core decisions

- **No persistent cursor**: a Pheromone is consumed by a node; the node produces new Pheromones.
- **No Run**: a Composition has one running PheromoneField, not execution instances.
- **No child composition**: Fork/Merge/Branch are explicit nodes in one graph.
- **Composition owns its nodes**: no live shared mutable node across Compositions; reuse by copy or immutable template.
- **No End node**: any node without an outgoing edge is terminal. No Pheromones = **Rest**.
- **Fork, Merge, Branch are explicit**: a normal node does not fan out implicitly.
- **Merge is the continuation point**: it consumes the required Pheromones and emits one new Pheromone. No Pheromone “wins”.
- **One big daemon**: it owns adapters and the event loop. No per-agent daemon.
- **Honey vs log**: Honey is durable data; log is append-only operational history and does not store prompt/output bodies by default.

## 3. Objects

| Object | Meaning |
| --- | --- |
| Apiary | A project/workspace: directory + manifest + composition files |
| Composition | A graph: nodes + edges + triggers; owns its nodes |
| Graph | The structure of a composition |
| Node | Execution or wait unit; task or control |
| Edge | Directed path for Pheromones; stateless |
| Pheromone | Short-lived value: `{id, traceId, forkId?, branchId?, value}` |
| PheromoneField | `pheromones + nodeStates`; the running state |
| NodeState | queue, pending, active, hover, state, joins, lastActivatedAt |
| Branch | One branch created by a Fork |
| Fork | Consumes 1 Pheromone, emits N |
| Merge | Waits for required branches (optional best effort), consumes all, emits 1 |
| Trigger | Manual/scheduled entry; creates a Pheromone at a task node |
| Hover | A node waiting for something |
| Guard | Native tool approval or graph-level human review |
| Forager | Harness task node |
| Worker | Local task node |
| Bee | Task-node category: Forager or Worker |
| user | Human input node |
| Condition | Branch control node |
| Counter | Counting/loop-limit control node |
| Honey | Durable data: state snapshots, transcripts, artifacts |
| log | Append-only operational history |

There is no `End` node, no cursor instance, and no `Run`.

## 4. Value and human input

A Pheromone carries a `Value`:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type Value =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; choice: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'message'; text?: string; attachments: Attachment[] }
  | { kind: 'attachments'; attachments: Attachment[] }
  | { kind: 'structured'; value: JsonValue };
```

- `Attachment.kind`: `image | file | audio`.
- `structured` is JSON-safe only: null, boolean, finite number, string, array and plain object. Undefined, functions, BigInt, Symbol, cycles and non-finite numbers are rejected; existing Value objects are legal members because they are JSON-safe. `serializeValue` emits `JSON.stringify`, so the Forager prompt and Condition text mode share one rendering. No attachment semantics are defined inside `structured` yet.
- `user` nodes declare a modality: text, choice, yes/no, message, image, or file.
- A normal prompt can be a message: text plus optional files/images/audio.
- A review is a yes/no `user` node; a Condition can branch directly on the boolean.
- The Pheromone itself is not split into “nectar” and “pollen” subtypes; it carries the Value.

## 5. Runtime

A trigger — manual or scheduled — creates a Pheromone at a task node. A node consumes a Pheromone, runs, and emits new Pheromones on its outgoing edges. Stage 3C-1 adds a single-composition foreground daemon that schedules `at`/`every` triggers; it records an occurrence before enqueueing it, so recovery is at-most-once.

- A normal node emits one Pheromone.
- **Fork** consumes one and emits N, one per branch.
- **Merge** waits for required branch Pheromones, consumes them atomically, and emits one combined Pheromone.
- A node with no outgoing edge is terminal: it consumes the Pheromone and emits nothing.
- When no Pheromones remain, the composition is at **Rest**.
- Each node has a FIFO queue, a pending slot, and a node-level minimum interval between activations.
- `lastActivatedAt + minInterval` is a rate limit, not a loop limit. A Counter/Condition expresses loop limits.
- Node state is shared by Pheromones visiting that node; branch-local state uses distinct nodes.

## 6. Hover and Guard

A node can enter a **Hover**, represented by a `HoverSpec`:

- `forager` — waiting for a harness turn
- `worker` — waiting for a local process
- `user` — waiting for human input
- `guard` — waiting for a native tool approval
- `timer` — waiting for a delay

Only an event matching the hover token can complete it. A native Guard stays at the Forager node and is displayed as a virtual card; it does not move the Pheromone. A graph-level review is a `user` node with a yes/no question, followed by a Condition.

Stage 3B does not open a `worker` hover: a Worker is an awaited child process with a timeout, so there is no durable cross-process wait to represent. The `worker` hover kind remains reserved rather than used speculatively.

Guard decisions are bound to `requestId` and `executionId`. A decision for one request is never replayed onto another. Guard has a timeout (default one hour); timeout rejects or cancels, never auto-allows. The Stage 3C-1 daemon has no interactive TTY and rejects Guard requests by default; there is no Guard inbox.

## 7. Fork, Merge, Branch

- A **Fork** node has `branches: [{id, to}]`. It consumes one Pheromone, copies the Value to N Pheromones, and tags them with `forkId` and `branchId`.
- A **Merge** node has `required: [branchId]` and `optional: [branchId]`. It groups arrivals by `forkId`; when all required branches have arrived, it consumes them atomically and emits one Pheromone. Optional branches that already arrived contribute in `optional` config order; missing optional branches never block the join.
- A required branch that fails or becomes unknown fails the Merge; siblings are cancelled. An optional-only branch that fails or becomes unknown is logged and dropped without failing the required set.
- A Merge with no outgoing edge is terminal.
- Stage 3A implements required branches, text combine, and sibling cancellation. Stage 5A adds optional branches with a persisted completed-join tombstone: a late optional is dropped and logged, a late required is a logged protocol error with no second emit, and the tombstone is bounded to one hour / 64 per merge node. Stage 5B adds `timeoutMs`: the deadline starts on the first branch arrival for a forkId and is persisted as an absolute `deadlineAt`. Required branches that arrive before the deadline emit and disable the timeout; a deadline reached with required branches missing fails the fork, cancels queue/pending/hover siblings, emits nothing, and leaves a persisted timed-out tombstone (`timedOutAt`) so a late branch is dropped instead of reopening the join. An incomplete join is never failed before its deadline, and the runtime exposes `nextWakeAt()` so a caller can sleep until the earliest deadline. Stage 5C adds `combine: "object" | "array"`: `object` emits a `structured` Value keyed by branchId, `array` emits the ordered branch Values, and both use required order followed by the optional branches that already arrived in optional config order. `text` remains the newline join. The Merge output still drops `forkId`/`branchId`; nested lineage is deferred.

## 8. Live editing

- Every edit produces a GraphRevision.
- Node and edge IDs are stable.
- A node with queued, pending, active, hovering, or merge-waiting Pheromones is an active reference: delete/rename is rejected by default.
- A forced edit marks the affected node or Pheromone as stuck/needs attention; it never silently reroutes work.
- Stage 4A implements the deterministic offline editor: `wax composition validate` only parses, and `wax composition replace` refuses a different composition id, any live reference, and a live or uncertain daemon lock. It has no force mode, writes through a same-directory temp file plus rename, and appends a revision audit line without the composition body.
- Stage 4B-A exposes that editor as a stable CLI/JSON tool. `--json` makes stdout exactly one result object, moves structured failures to stdout (`usage`, `parse`, `refused`, `io`, `internal`), and keeps exit codes 0/2/1. The JSON layer is presentation only; active-reference, lock and audit policy stays in the editing service so an MCP transport can wrap the same result contract later.
- Stage 4B-B wraps that result contract in a local MCP stdio server (`wax mcp` / `node dist/src/mcp-server.js`). It advertises protocol `2024-11-05` and two tools, `composition_validate` and `composition_replace`; each returns one text content item with the 4B-A JSON object and sets `isError` for `ok:false`. `wax run`/`wax daemon --composition-tools` opt the selected harness into a single `wax_composition` server launched as `process.execPath <absolute mcp-server.js>` with argv only. The server is transport-only: it calls the same guarded editing service and never reimplements active-reference, lock or audit policy.
- Stage 4C adds read-only inspection: `wax composition revisions` reads the global revision audit with an optional composition filter and a bounded newest-first selection, and fails on any malformed line; `wax composition recover <file>` parses same-directory `.<basename>.tmp-*` candidates and reports each one without renaming, deleting or overwriting anything. There is no `--apply` and no automatic recovery.
- Node execution uses a start snapshot. Queued Pheromones use the current graph when activated.
- A composition owns its nodes. Reuse across compositions is by copy or immutable template, not live shared mutation.

## 9. Honey and log

Honey is the durable layer:

```text
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/field.json
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/transcripts/<conversationId>.jsonl
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/artifacts/
```

The composition log is separate:

```text
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/log.jsonl
```

- State snapshots and transcripts are Honey; they can be read by a future UI.
- The log records time, node, event, Pheromone/fork/branch IDs, `program`, `pid`, `executionId`, `requestId`, duration, outcome, and errors.
- The log does **not** store prompt/output bodies by default.
- The log is not a replay source. Recovery reads the Honey state; side effects are never auto-replayed.

## 10. Non-goals

- No general-purpose workflow platform.
- No runtime plugin loader or hot-plug.
- No UI in this repository; a web client is a separate concern.
- No remote/multi-user/multi-tenant runtime.
- No automatic replay of side-effecting operations.
- No simulated native harness behavior presented as verified.

## 11. Implementation status

The single-Pheromone core, the Stage 3A parallel slice, Stage 3B Worker, and the Stage 3C-1 foreground daemon scheduler are implemented: trigger, node consumption/production, terminal/Rest, queue, pending, minimum interval, log, Fork/Merge/Branch, persisted joins and merge-waiting edit references, argv-only Worker with bounded output and process-tree kill, Condition worker mode, scheduled `at`/`every` triggers, durable occurrence state, and a per-composition daemon lock. Stage 3C-2 adds manual `message`, `image` and `file` user answers: the parser accepts the three modalities, the runtime validates the Value shape and modality without filesystem access, and the interactive CLI prompts for a message or one local attachment path (expanded `~`, existing regular file, absolute path, no copy or preview). The Forager bridge forwards image/file attachments to the adapter as `AttachmentDraft`s with an extension-inferred `mimeType` and uses a non-empty `See attached input.` fallback. Stage 4A adds an offline composition editor: validate only reads and parses; replace checks both definitions, refuses active references and a live or uncertain daemon lock, writes atomically through a same-directory temp file plus rename, and appends one non-body revision audit line. There is no force mode and no `needsAttention` write in 4A. Stage 4B-A adds a `--json` mode to both commands: one result object on stdout, failures printed to stdout as `{ok:false,command,code,error}`, exit codes 0/2/1, and no composition body in results. The typed result layer in `src/composition-tool.ts` wraps the same editing service without moving policy out of it. Stage 4C adds the read-only audit surface: `src/composition-audit.ts` reads `<state-dir>/revisions.jsonl` (missing file means an empty audit), rejects malformed lines instead of skipping them, whitelists the six metadata fields, and reports same-directory `.<basename>.tmp-*` candidates as valid or invalid without mutating anything. `revisions` returns the newest matching entries; `recover` has no `--apply`. Stage 4D wires the existing DSH ACP adapter into the one-shot and daemon CLI: `--harness dsh` requires an explicit `--dsh-root` or `DSH_ROOT`, each per-harness override is rejected on the other harness, and the Codex launch path is unchanged. Scheduled `user` triggers, optional branches (including object/array combine) and merge timeouts are still open. See [`CONTRACT.md`](CONTRACT.md).

Stage 4B-B adds the local MCP surface for the same editor. `src/mcp-server.ts` implements a minimal newline-delimited JSON-RPC 2.0 server on stdio (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`) without an SDK; `wax mcp` and `node dist/src/mcp-server.js` both serve it. The two tools, `composition_validate` and `composition_replace`, call `src/composition-tool.ts` and return its existing JSON as one text content item, with `isError` set for failures. `src/composition-mcp.ts` builds the exact per-harness declarations, and `wax run`/`wax daemon --composition-tools` inject one `wax_composition` server launched with `process.execPath` and the absolute built `mcp-server.js`, argv only. The flag is off by default; the server holds no editing policy of its own.

Stage 5A adds optional Merge branches while keeping the Stage 3A control flow. `MergeConfig.optional` defaults to an empty array; required and optional branch ids are unique and disjoint; 5C later adds the object/array combine. A Merge completes as soon as every required branch has arrived, combining the required text in `required` order followed by the optional arrivals in `optional` config order. An optional branch that fails or becomes unknown on restore is logged as `merge.optional-failed` and dropped, and its node error is contained so the required set still completes; only a branch that no Merge treats as optional keeps the Stage 3A failFork behaviour. After completion the join stays in `NodeState.joins` as a tombstone with `completedAt` and no Pheromones. That tombstone is persisted in Honey (`completedAt` on the persisted join), is restored so a late optional is still dropped as `merge.optional-dropped`, and never blocks Rest or counts as a merge-waiting edit reference. The tombstones are bounded to one hour and 64 per merge node, pruned on restore, on the next arrival and on completion. A late required branch is logged as `merge.failed` / `late-required` and never emits a second Pheromone. Because the parsed merge config now always carries `optional`, merge compositions get a new graph revision, so a pre-5A Honey field needs a fresh run rather than `--resume`.

Stage 5B adds `MergeConfig.timeoutMs` (default 600000, positive integer up to 2147483647) and the wake/persistence plumbing around it. The first branch arrival for a forkId records an absolute `deadlineAt = now + timeoutMs` on the join; persisting and restoring that instant keeps the deadline stable across a restart. `arriveAtMerge` completes and emits while the required set is complete before the deadline; after expiry it refuses to emit. When the deadline is reached with required branches missing, `expireDueJoins` writes a persisted timed-out tombstone (empty `arrived`, `timedOutAt`, no `deadlineAt`), logs `merge.timed-out`, and fails the fork: queue/pending/hover siblings are cancelled, active siblings are left alone, and no Pheromone is emitted. `failMissingJoins` skips any join with time left, so an idle field with no in-flight branch stays non-Rest until the deadline. A late required or optional branch that reaches a closed tombstone is logged and dropped; `failFork` keeps closed tombstones so a late active sibling cannot reopen a join and emit a second time. Completed and timed-out tombstones share the 5A one-hour/64 cleanup bound and never block Rest or an edit. `PheromoneRuntime.nextWakeAt()` returns the earliest incomplete-join deadline; `pump()` expires due joins, `wax run` sleeps until `nextWakeAt()` (or an earlier rate-limited pending branch) when no hover is left and the field is not Rest, and the daemon keeps its existing 500 ms heartbeat instead of adding a socket or IPC channel. Restoring an expired join fails it immediately; restoring an unexpired one continues with its original deadline. Because the parsed merge config now always carries `timeoutMs`, 5B changes every merge graph revision again, so a pre-5B merge Honey field needs a fresh run rather than `--resume`.

Stage 5C adds the `structured` Value and Merge `combine: "object" | "array"`. `Value` gains `{kind:"structured", value: JsonValue}`, where `JsonValue` is JSON-safe only (null, boolean, finite number, string, array, plain object). `src/runtime/json-value.ts` rejects undefined, functions, BigInt, Symbol, cycles and non-finite numbers at the runtime trigger/executor boundary, and `src/honey.ts` revalidates the payload on load. `serializeValue` emits `JSON.stringify`, so the Forager prompt, Condition text mode and text Merge combine share one rendering; a Honey round trip restores the payload unchanged. A Merge with `combine:"object"` emits `{kind:"structured", value:{[branchId]: Value}}` and `"array"` emits `{kind:"structured", value: Value[]}`, each in required order followed by the optional branches that already arrived in optional config order. `text` is unchanged, the Merge output still drops the fork/branch tags, nested lineage is deferred, and no attachment semantics are defined inside `structured`.
