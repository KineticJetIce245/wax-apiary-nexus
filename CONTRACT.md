# WAX Apiary neXus — Composition Contract

> **Status**: target contract. The runtime implements the single-Pheromone core, Stage 3A Fork/Merge/Branch, the Stage 5A optional Merge branches, Stage 5B Merge timeout, Stage 5C structured Value and object/array Merge combine, Stage 5D nested Fork/Merge lineage, Stage 3B Worker/Condition worker, the Stage 3C-1 foreground daemon scheduler, Stage 3C-2 rich manual user input, the Stage 6A answer inbox and scheduled `user` targets, the Stage 4A offline composition editor, the Stage 4C read-only revision audit and orphan-temp inspection, and the Stage 4D DSH harness wiring; the rest of this contract is still target design. The architecture model is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Scope

This document defines:

- The Composition JSON file.
- Node, edge, trigger, Fork, Merge, and Branch semantics.
- The `PheromoneField` runtime state.
- Node consumption/production, terminal nodes, and Rest.
- Hover and Guard.
- Honey (durable data) and log (history).
- Validation and the minimal CLI.

It does not define Harness Adapter protocols, a UI, remote/multi-tenant behavior, or a runtime plugin loader.

## 2. Composition file

```json
{
  "schemaVersion": 1,
  "id": "review-chain",
  "nodes": {
    "plan": {
      "kind": "forager",
      "config": {
        "connection": "codex",
        "prompt": "Write a plan for:\n{{input}}"
      },
      "minIntervalMs": 1000
    },
    "ask": {
      "kind": "user",
      "config": { "modality": "yes-no", "prompt": "Approve this plan?" }
    },
    "check": {
      "kind": "condition",
      "config": { "mode": "boolean" }
    },
    "count": {
      "kind": "counter",
      "config": { "max": 3, "step": 1 }
    },
    "done": {
      "kind": "forager",
      "config": {
        "connection": "codex",
        "prompt": "Summarize:\n{{input}}"
      }
    }
  },
  "edges": [
    { "id": "e1", "from": "plan", "to": "ask" },
    { "id": "e2", "from": "ask", "to": "check" },
    { "id": "e3", "from": "check", "to": "done", "when": "true" },
    { "id": "e4", "from": "check", "to": "count", "when": "false" },
    { "id": "e5", "from": "count", "to": "plan", "when": "continue" },
    { "id": "e6", "from": "count", "to": "done", "when": "done" }
  ],
  "defaults": {
    "minIntervalMs": 1000,
    "queueMax": 1024,
    "queueTtlMs": 604800000
  }
}
```

`done` has no outgoing edge, so it is terminal. There is no special End node.

- `schemaVersion` is `1`.
- `id` is the composition id, unique within an Apiary.
- Node ids are stable; pattern `[a-z0-9][a-z0-9._-]{0,63}`.
- Edge ids are stable and unique within the composition.
- `triggers` is optional; manual triggers are not stored in the file. Stage 3C-1 supports scheduled `at` and `every` triggers (Section 5).
- `defaults` is optional.

## 3. Node types

Every node has `id`, `kind`, `config`, and optional `minIntervalMs`.

### forager

```json
{
  "kind": "forager",
  "config": {
    "connection": "codex",
    "prompt": "Review:\n{{input}}"
  }
}
```

- Harness task node.
- `connection` names an Apiary connection; must be non-empty.
- `prompt` is a template; `{{input}}` is the current Value serialized to text.
- Attachments carried by an incoming `message` or `attachments` Value are forwarded to the adapter as `AttachmentDraft`s: the path is required, only `image`/`file` entries are forwarded, and `mimeType` is inferred from the extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf`, `.txt`, `.json`, `.md`) or defaults to `application/octet-stream`. No file is read or copied.
- If the rendered prompt is empty or whitespace and attachments exist, the Forager bridge submits `See attached input.` so the adapter always receives non-empty text.
- Output is assistant text plus optional attachments.
- Native Guard requests are Hovers at this node.

### worker

```json
{
  "kind": "worker",
  "config": {
    "command": "node",
    "args": ["scripts/check.mjs"],
    "cwd": ".",
    "timeoutMs": 60000
  }
}
```

- Local task node; implemented in Stage 3B.
- `command` is a non-empty string; `args` is an array of strings. The process is spawned with `shell: false`; argv is never joined into a shell string.
- `cwd` defaults to `.` and resolves against the registered project directory. `..` segments are rejected, and the resolved real path (after symlink resolution) must stay inside the project directory.
- `timeoutMs` is a positive integer, default `60000`. Timeout kills the process tree and fails the activation.
- stdout and stderr are each capped at 64 KiB. Exceeding either cap terminates the process tree and fails; output is never buffered without a bound.
- stdout becomes `{ "kind": "text", "text": <stdout> }`. stderr is error metadata, not part of the Value.
- Non-zero exit is a failed activation; there is no automatic retry. A failure on a Fork branch cancels siblings through the existing fork-failure semantics.
- Recovery never replays an active worker: it becomes stuck/needs-attention like another non-Forager active node.

### user

```json
{ "kind": "user", "config": { "modality": "yes-no", "prompt": "Approve?" } }
```

- Human input node.
- `modality`: `text`, `choice`, `yes-no`, `message`, `image`, `file`.
- `choices` is required for `choice` and is rejected on every other modality.
- A `message` answer is `{ "kind": "message", "text": <answer>, "attachments": [] }`. An `image` or `file` answer is exactly one `{ "kind": "attachments", "attachments": [{ "kind": "image" | "file", "path": <absolute path>, "mediaType"?: <type> }] }`; Stage 3C-2 takes one local path per answer.
- The runtime validates the Value shape and modality only; it never reads the filesystem. The interactive CLI expands a leading `~`, requires an existing regular file and stores the absolute path reference; it does not copy, preview or infer `mediaType`.
- Early or late input queues at this node and applies on the next entry. The Stage 6A inbox is stricter: `wax answer` requires a currently open hover, writes only an inbox file, and the daemon never queues an inbox answer for a later hover (an unmatched answer is stale and dropped).
- Scheduled `user` triggers are allowed in Stage 6A: the daemon creates the Pheromone and the user node opens its Hover without a TTY; `wax answer` completes it.
- An answer inbox lives at `<composition honey directory>/answers/`. The daemon creates it (0700), scans `.json` files in name order at startup and after every heartbeat/pump, and processes one file at a time. An `answerId.json` record is `{answerId, compositionId, nodeId, hoverToken, value, at}` and never carries a prompt or output body.
- `wax answer` or a compatible writer creates one answer file through a same-directory temp file plus rename (0600); it never writes `field.json`. The record's `value` is a Value and its `hoverToken` must match the open user hover at `nodeId`. The daemon applies it with `answerHover`, flushes Honey, then deletes the file. A missing hover, a different composition/node/token, or a duplicate after the hover resolved is logged as `answer.stale` and deleted; an unreadable or invalid record, or a Value that does not match the modality, is logged as `answer.malformed` and deleted. Neither case creates a Pheromone or queues an early answer.
- A daemon restart restores the persisted hover before scanning the inbox, so an unprocessed answer still applies. An answer whose hover is gone after restore is stale and dropped.

### Condition

```json
{ "kind": "condition", "config": { "mode": "boolean" } }
```

- Control node; no hover.
- `mode`: `text`, `boolean`, `choice`, `worker`.
- Text mode uses exactly one of `contains` / `equals`.
- Boolean mode reads `Value.value`.
- Choice mode compares the selected choice.
- Worker mode runs the same argv config as a Worker node and branches on the exit code: `0` is `true`, non-zero is `false`. A non-zero exit is not a runtime error. Timeout, spawn failure, cwd rejection and output-cap overflow do fail the activation.
- Exactly one `true` edge and one `false` edge.

### Counter

```json
{ "kind": "counter", "config": { "max": 3, "step": 1 } }
```

- Control node; no hover.
- `max` and `step` are positive integers; `step` defaults to `1`.
- `node.state.count` starts at `0`; each activation adds `step`.
- `done` is true when `count >= max`.
- Exactly one `continue` edge and one `done` edge.
- Counter does not reset automatically.

### Fork

```json
{
  "kind": "fork",
  "config": {
    "branches": [
      { "id": "a", "to": "branch-a" },
      { "id": "b", "to": "branch-b" }
    ]
  }
}
```

- Consumes one Pheromone, emits one per branch.
- Each emitted Pheromone copies the Value. It carries the incoming `lineage` plus a new `{forkId, branchId}` tag; `forkId`/`branchId` stay present and point at the last tag. A top-level Fork's lineage has one tag.
- Branches have unique ids; `to` must exist.
- Fork has no normal default edge.

### Merge

```json
{
  "kind": "merge",
  "config": {
    "required": ["a", "b"],
    "optional": ["c"],
    "combine": "text",
    "timeoutMs": 600000
  }
}
```

- Waits for the required branch Pheromones, grouped by the current top `forkId`.
- All arrivals for one `forkId` must agree on the parent lineage (the incoming lineage without its last tag). A disagreement fails that fork; the enclosing lineage is not cancelled.
- Consumes all required Pheromones atomically and emits one combined Pheromone as soon as the required set is complete; it never waits for an optional branch.
- The output pops the current tag: a nested Merge restores the parent lineage (outer tags), while a top-level Merge emits with no `forkId`/`branchId`/`lineage`.
- `optional` defaults to `[]`. Required and optional branch ids must each be unique and must not overlap.
- `timeoutMs` defaults to `600000` and is a positive integer no larger than `2147483647`. The deadline starts on the first branch arrival for one `forkId` and is persisted as an absolute `deadlineAt`.
- Required branches that arrive before the deadline emit normally; the timeout no longer applies to that join. When the deadline is reached with required branches missing, the fork fails: queue/pending/hover siblings are cancelled, active work is not, nothing is emitted, and `merge.timed-out` / `merge.failed` are logged.
- `combine`: `text` (default), `object`, or `array`. `text` joins the required branches in `required` order, then the optional branches that already arrived in `optional` config order, with newlines. `object` emits `{kind:"structured", value:{[branchId]: Value}}` and `array` emits `{kind:"structured", value: Value[]}`, both in the same required-then-arrived-optional order. Attachment semantics inside `structured` are not defined.
- An optional branch that fails or becomes unknown is logged (`merge.optional-failed`) and dropped; it never fails the required set.
- A completed join is kept as a persisted tombstone with `completedAt`. A timed-out join is kept as a persisted tombstone with an empty `arrived` list and `timedOutAt`. A late optional arrival is dropped and logged as `merge.optional-dropped`; a late required arrival is logged as `merge.failed` / `late-required` and never emits a second Pheromone. Completed and timed-out tombstones do not count as Merge-waiting references or as Rest blockers, and are bounded to one hour and 64 per merge node.
- `failMissingJoins` never fails an incomplete join before its deadline; the field stays non-Rest while the join waits.
- Missing/failed/unknown required branches fail the Merge and cancel siblings.
- Merge has at most one normal outgoing edge; without one it is terminal.

## 4. Edges

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable edge id |
| `from` | yes | Source node id |
| `to` | yes | Target node id |
| `when` | no | `true`, `false`, `continue`, `done` |

- Condition uses `true` / `false`.
- Counter uses `continue` / `done`.
- Other non-Fork/Merge nodes have at most one default edge; no outgoing edge means terminal.
- Cycles are allowed. There is no requirement that every path reaches a special End node.

## 5. Triggers

- Manual: CLI/API; not stored in the file.
- Scheduled: `{ "id", "target", "schedule" }`, implemented in Stage 3C-1.
  - `schedule.kind: "at"` carries an ISO-8601 `at` timestamp with `Z` or an explicit offset. A timezone-less local time is rejected.
  - `schedule.kind: "every"` carries an integer `everyMs >= 1000`.
  - Trigger ids are unique and use the node-id pattern.
  - The target must be a `forager`, `worker`, or `user` node. Control nodes are rejected; a scheduled `user` target opens a Hover without a TTY (Stage 6A).
- A trigger creates a Pheromone at the target node. There is no `start`.
- Node activations are rate-limited by `lastActivatedAt + minInterval`.
- Serialized manual CLI triggers accept `forager`, `worker` and `user` targets.
- The daemon is one composition per process. An occurrence and an `unconfirmed` marker are recorded before the Pheromone is enqueued, and the marker is cleared after the callback returns. Delivery is at-most-once: a crash inside that window reports the occurrence once on the next start (`onUnconfirmed`, logged as `scheduler.unconfirmed`) and never replays it; a changed schedule discards an old marker. A past `at` and a missed `every` fire at most once on start; `every` then reschedules from the start time and never storms skipped intervals.
- The daemon restores Honey before scheduling. A restored active Forager remains unknown, other active nodes (including a Worker) remain stuck, and nothing is replayed.

## 6. Values and templates

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

- `Attachment.kind`: `image`, `file`, `audio`.
- `structured` is JSON-safe only: null, boolean, finite number, string, array, or plain object. Undefined, functions, BigInt, Symbol, cycles and non-finite numbers are rejected; existing Value objects are legal members because they are JSON-safe. `serializeValue` on a structured Value is `JSON.stringify(value)`, and both the Forager prompt and Condition text mode use it. No attachment semantics are defined inside `structured` yet.
- `forager.prompt` supports `{{input}}` only; the Value is serialized to text.
- Attachments are passed to the adapter separately.
- Pheromones are not split into separate value subtypes.

## 7. PheromoneField

```ts
type BranchTag = { forkId: string; branchId: string };

type Pheromone = {
  id: string;
  traceId: string;
  forkId?: string;      // compatibility: last lineage tag
  branchId?: string;    // compatibility: last lineage tag
  lineage?: BranchTag[]; // outer-to-inner, last = current
  value: Value;
  at: string;
};

type PheromoneField = {
  schemaVersion: 1;
  compositionId: string;
  graphRevision: string;
  pheromones: Pheromone[];
  nodes: Map<NodeId, NodeState>;
};

type NodeState = {
  queue: Pheromone[];
  pending?: Pheromone;
  active?: Pheromone;
  lastActivatedAt?: string;
  hover?: HoverSpec;
  state?: Record<string, unknown>;
  joins?: Map<ForkId, JoinState>;
};
```

`JoinState` holds the branch arrivals for one `forkId`: `lineage` (the shared parent lineage, absent at top level), `arrived`, an optional absolute epoch-ms `deadlineAt` for an incomplete join, and an optional `completedAt` or `timedOutAt` when the join is closed. A closed join holds no Pheromones; closed joins are tombstones, not live work, and keep their parent lineage in Honey so a restored tombstone still drops a late branch for that fork. A Pheromone with a lineage always has `forkId`/`branchId` equal to its last tag; a pre-5D flat tag is read as a one-element lineage.

There is no cursor object and no activation count.

Each node has a FIFO queue, one pending slot for a rate-limited input, and at most one active Pheromone. Queue defaults: 1024 entries, seven-day TTL. A full queue rejects new Pheromones instead of silently dropping old ones.

## 8. Runtime

```text
on trigger(nodeId, value):
  create Pheromone at nodeId

on Pheromone at node:
  if node is hovering or active: enqueue
  else if minInterval not elapsed: pending + wake
  else: activate node

on node complete:
  emit Pheromone(s) on outgoing edge(s)
  if no outgoing edge: terminal, emit nothing
  if no Pheromones remain: Rest
```

- A normal node consumes one Pheromone and emits one.
- A Fork consumes one and emits N.
- A Merge consumes the required set and emits one.
- A terminal node emits nothing.
- Rest means no Pheromones; there is no cursor parked at an end.
- Multiple Pheromones may exist on different branches in one PheromoneField.

## 9. Hover and Guard

```ts
type HoverSpec = {
  token: string;
  kind: 'forager' | 'worker' | 'user' | 'guard' | 'timer';
  compositionId: string;
  nodeId: string;
  pheromoneId: string;
  expiresAt?: string;
  meta?: Record<string, unknown>;
};
```

- Only an event matching the hover token completes it.
- A native Guard stays at the Forager node; it is not a separate node.
- A native Guard decision binds `requestId` + `executionId`; a decision for one request is never replayed onto another.
- Guard default timeout is one hour; timeout rejects or cancels, never auto-allows.
- A graph-level review is a `user` node with a yes/no question, followed by a Condition.

## 10. Honey and log

Durable data:

```text
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/field.json
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/scheduler.json
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/answers/<answerId>.json
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/transcripts/<conversationId>.jsonl
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/artifacts/
```

The daemon lock is `<composition directory>/daemon.lock`. It names the owning
PID and is removed on normal shutdown. A dead PID makes the lock stale; an
unreadable, malformed, or uncertain lock is never stolen.

History:

```text
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/log.jsonl
```

- State snapshots and transcripts are Honey; they can be read by a future UI.
- The log fields include `at`, `compositionId`, `graphRevision`, `event`, `nodeId`, `nodeKind`, `pheromoneId`, `traceId`, `forkId`, `branchId`, `program`, `pid`, `executionId`, `requestId`, `queueDepth`, `durationMs`, `outcome`, `error`, and refs.
- The log does not store prompt/output bodies by default. Stage 6A answer events (`answer.applied`, `answer.stale`, `answer.malformed`) carry the `answerId`, node, and an outcome only; the answer Value is never logged.
- The log is not a replay source. Recovery reads Honey; side effects are never auto-replayed.

Offline edits append a revision audit, separate from the runtime log:

```text
<state-dir>/revisions.jsonl
```

Each successful `wax composition replace` appends one JSON line with `at`, `compositionId`, `oldRevision`, `newRevision`, `file`, and `mode: "replace"`. It never stores the composition body. The state dir defaults to `~/.wax`.

`wax composition revisions` reads that file read-only. A missing file is an
empty audit, not an error. Any blank, non-JSON or schema-invalid line is a
`parse` failure (exit 1) instead of a silent skip, and the command never echoes
the line contents. Only the six metadata fields are returned, so unexpected
fields in a hand-edited audit cannot leak a composition body. An optional exact
`compositionId` filter and a `limit` of 1..1000 (default 50) select the newest
matching entries.

`wax composition recover <file>` scans only the file's own directory for
`.<basename>.tmp-*` entries and parses each candidate. It reports the path, a
valid flag, and composition id / graph revision for a valid candidate, or an
error for an invalid one. It never renames, deletes or overwrites any file and
has no `--apply`; manual recovery only.

## 11. Validation

Before running:

- `schemaVersion`, `id`, `nodes`, and `edges` are valid.
- Node/edge/trigger ids are unique and match the pattern.
- There is no End node; any node without an outgoing edge is terminal.
- Normal nodes have at most one default edge; Condition has `true`/`false`; Counter has `continue`/`done`; Fork uses branches; Merge has at most one default edge.
- Edge endpoints exist; `when` only appears on Condition/Counter edges.
- Fork branches are unique and targets exist.
- Merge required/optional branch ids are unique and disjoint; combine is `text`, `object`, or `array`; `timeoutMs` is a positive integer no larger than `2147483647` (default `600000`).
- Trigger targets are task nodes; scheduled triggers accept `forager`, `worker` or `user`.
- `at` carries `Z` or an explicit offset; `everyMs` is an integer >= 1000.
- Forager connection/prompt are non-empty; user modality is valid; Condition mode is valid; Counter max/step are positive.
- Worker `command` is non-empty; `args` is a string array; `cwd` is a non-empty string without `..`; `timeoutMs` is a positive integer. Absolute cwd containment and symlink escapes are enforced at activation, when the project directory is known.
- `minIntervalMs` is at least `1000`.
- `queueMax` / `queueTtlMs` are positive.
- Cycles are allowed; terminal nodes are valid.
- Cross-composition live shared mutable nodes are rejected.

## 12. CLI

```bash
wax run <composition.json> --project <dir> --harness <codex|dsh> [--trigger <node>] [--input <text>] [--resume] [--composition-tools] [--state-dir <dir>] [--apiary <id>] [--codex-exe <path>] [--dsh-root <path>]
wax daemon <composition.json> --project <dir> --harness <codex|dsh> [--composition-tools] [--state-dir <dir>] [--apiary <id>] [--codex-exe <path>] [--dsh-root <path>]
wax answer <composition.json> --project <dir> --node <user> [--token <hover-token>] <--text <text>|--choice <label>|--yes|--no|--image <path>|--file <path>> [--state-dir <dir>] [--apiary <id>]
wax composition validate [--json] <file>
wax composition replace [--json] <file> --with <new-file> [--state-dir <dir>] [--apiary <id>]
wax composition revisions [--json] [--composition <id>] [--limit <n>] [--state-dir <dir>]
wax composition recover [--json] <file>
wax mcp
wax trigger <composition> <node> [--text "..."]
wax status [<composition>] [--json]
wax log <composition> [--tail N] [--json]
wax honey <conversationId> [--json]
```

- No `run start`; a trigger creates a Pheromone.
- `wax run` pumps to Rest. When no user hover is open and the field is not Rest but only timed work remains, it sleeps until the earlier of `PheromoneRuntime.nextWakeAt()` and the next rate-limited pending branch, then pumps again; an expired join fails without emitting. `wax daemon` keeps its existing 500 ms heartbeat and adds no socket or IPC channel.
- `wax answer` is not a runtime writer. It parses the composition, resolves the user node and its modality, reads `<state-dir>/apiaries/<apiary>/compositions/<id>/honey/field.json` read-only, and requires exactly one open user hover unless `--token`. A `--token` must belong to the named node. The answer source flag must match the modality: `--text` for `text`/`message`, `--choice` for `choice`, `--yes`/`--no` for `yes-no`, and `--image`/`--file` for the matching attachment modality. Attachment paths are expanded (`~`), must be existing regular files, and are stored as absolute path references; nothing is copied or previewed. The command writes one `<honey>/answers/<answerId>.json` through a same-directory temp file plus rename and exits `2` on usage/no-field/no-hover and `1` on IO. It never calls `answerHover` or writes the field.
- `--harness dsh` requires `--dsh-root <path>` or the `DSH_ROOT` environment variable; there is no implicit default. `--dsh-root` is rejected with `--harness codex`, and `--codex-exe` is rejected with `--harness dsh`. Both commands construct the existing `DshAcpAdapter` with the resolved root; adapter and daemon semantics are unchanged.
- `wax composition validate` parses and validates only; it does not write runtime state.
- `wax composition replace` parses both files and refuses a different composition id. When `--apiary` resolves a Honey field (the state root defaults to `~/.wax`), any queue, pending, active, hover, or merge-waiting reference refuses the edit. A live or uncertain daemon lock also refuses. The write is a same-directory temp file plus rename, followed by one revision audit line. Stage 4A has no `--force` and never writes `needsAttention`; a stale lock is left in place. Without `--apiary`, replace runs but reports that active references were not checked.
- `wax composition revisions` reads the audit only. It filters by an exact `compositionId`, keeps the newest `limit` entries (1..1000, default 50), and fails on any malformed line. `wax composition recover` only inspects `.<basename>.tmp-*` candidates in the composition's directory; it never renames, deletes, overwrites, or applies one. Both are read-only.
- `wax mcp` serves the composition tool on stdin/stdout as newline-delimited JSON-RPC 2.0 MCP (protocol `2024-11-05`, server `wax-composition` `0.0.0`). Methods: `initialize`, `notifications/initialized` (notification, never answered), `ping`, `tools/list`, `tools/call`. Tools: `composition_validate` (`{file}`) and `composition_replace` (`{file, withFile, stateDir?, apiary?}`). A tool result is exactly one text content item carrying the same JSON object as `--json`, with `isError: true` when `ok` is false; no composition body is returned. Malformed JSON is `-32700`, an unknown method is `-32601`, and invalid tool arguments are `-32602`. stdout carries protocol lines only.
- `--composition-tools` is off by default. When given to `wax run` or `wax daemon`, the selected adapter gets exactly one MCP server named `wax_composition`: `process.execPath` plus the absolute built `dist/src/cli/mcp-server.js`, argv only, with no shell string. Codex declares it as `thread/start.config.mcp_servers.wax_composition = { command, args, env: {} }` (object `env`); DSH declares `session/new.mcpServers = [{ name: 'wax_composition', command, args, env: [] }]` (array `env`). The server presents the same guarded editing service; active-reference, daemon-lock, atomic-write and audit policy is not reimplemented in the MCP layer.
- Composition command exit codes: `0` success, `2` usage/parse/refusal, `1` write or audit IO failure, with one audit-specific exception: a malformed revision audit line is `parse` with exit `1`. In JSON mode an unreadable input file is also `io` with exit `1`; the human CLI keeps its earlier exit `2`. `recover` exits `0` even when no candidates exist, `2` on usage and `1` on IO.
- `--json` makes stdout exactly one JSON object and keeps stderr empty; failures are printed to stdout too. Validate success is `{"ok":true,"command":"validate","compositionId","graphRevision"}`. Replace success is `{"ok":true,"command":"replace","compositionId","oldRevision","newRevision","file","auditPath","activeReferences":{"status":"checked"|"not-checked","reason"?},"staleLockPath"?}`. Revisions success is `{"ok":true,"command":"revisions","entries":[...],"malformed":0}`; recover success is `{"ok":true,"command":"recover","file","candidates":[{"path","valid":true,"compositionId","graphRevision"}|{"path","valid":false,"error"}]}`. Failure is `{"ok":false,"command","code","error"}` where `code` is `usage`, `parse`, `refused`, `io` or `internal`. The JSON layer presents the result of the same guarded editing and read-only audit services: active-reference, daemon-lock, atomic-write, audit-read and recovery-inspection policy is not reimplemented there. Results never include composition bodies, prompts or outputs.
- `wax status --json` reports composition, Pheromones at nodes, node queue/pending/active/hover state, log path, and Honey path. It does not print prompt/output bodies by default.
- `wax honey` reads durable transcripts/artifacts.

## 13. Implementation status

`src/runtime/` implements the single-Pheromone slice plus Stage 3A Fork/Merge/Branch and Stage 3B Worker: composition parse/validation, `PheromoneField` state, `trigger`, consumption/production, terminal/Rest, FIFO queue with pending and `minIntervalMs`, `condition`/`counter`, `user` nodes with `HoverSpec` (answers arriving before the hover are queued, not dropped), Guard hovers for native approvals, and field export/restore. A Fork emits one tagged copy per branch; branch tags survive normal nodes; a Merge groups by `forkId`, waits for its `required` branches, consumes them atomically, and emits one newline-joined text value for `combine: "text"` (Stage 5C adds structured `object`/`array` output). Incomplete joins persist in Honey and count as live references; completed and timed-out tombstones do not. Duplicate, unknown or failed required branches fail the merge and cancel siblings; a missing required branch waits for the merge deadline and then times out. Stage 5C adds the `structured` Value and Merge object/array combine; a structured payload is JSON-safe, serialized as JSON, and persisted/restored in Honey. Guards are bound to a `requestId`, cancelled after one hour, rejected by default, and refused when a decision arrives early, late or for another request. `src/session/forager.ts` bridges a Workspace conversation; `src/storage/honey.ts` writes `honey/field.json` atomically, appends a metadata `log.jsonl`, and keeps per-conversation transcripts that the log only references; both rotate. `wax run --resume` restores a field. An `active` Pheromone cannot be reattached: a Forager becomes unknown, other nodes (including an active Worker) become stuck, and nothing is replayed. `src/composition/revision.ts` refuses edits that orphan live node state. `src/runtime/worker.ts` runs argv-only Workers with project-contained cwd, a default 60s timeout, 64 KiB caps per stream and process-tree kill; the composition log records program/pid/byte counts but not output bodies. Condition `mode: "worker"` branches on the exit code.

Stage 3C-1 adds scheduled composition triggers and `wax daemon`. `parseComposition` accepts unique `at`/`every` triggers targeting `forager` or `worker`; `PheromoneRuntime.trigger` now also accepts a Worker target. `src/daemon/scheduler.ts` records each occurrence in `honey/scheduler.json` before enqueueing it, fires a past `at`/missed `every` once on start, and reschedules `every` from the start time without a missed-interval storm. `src/daemon/daemon-lock.ts` provides the per-composition PID lock. The daemon restores Honey, rejects Guard requests without a TTY, pumps restored queued Pheromones, and stops scheduling on SIGINT/SIGTERM. Stage 3C-2 adds manual `message`, `image` and `file` user answers. `parseComposition` accepts the three modalities and still rejects `choices` outside `choice` mode. `PheromoneRuntime.answerHover` validates the answer against the node modality: a message must carry text and an empty attachment list, and an image/file answer must carry exactly one attachment of the matching kind with a non-empty path and an optional string `mediaType`; the runtime never touches the filesystem. The interactive CLI prompts for a message (empty is rejected) or one local path (leading `~` expanded, missing/non-regular file rejected, absolute path returned), and a non-interactive stdin is still refused. `src/session/forager.ts` forwards attachments from a `message`/`attachments` Value to the adapter as `AttachmentDraft`s with an extension-inferred `mimeType`, and substitutes `See attached input.` when the rendered prompt is empty. Scheduled `user` triggers remain deferred in Stage 3C-2; Stage 6A lifts that deferral with the answer inbox. Stage 4A adds `wax composition validate` and `wax composition replace`: both files are parsed with `parseComposition`; a replace refuses a different composition id, any active reference from the Honey field, and a live or uncertain daemon lock; the write uses a same-directory temp file plus rename and appends one metadata-only `revisions.jsonl` line. Without `--apiary`, the field check is skipped and the CLI says so. There is no `--force` or `needsAttention` write in 4A. Stage 4B-A adds `--json` to both commands: stdout carries exactly one result object, failures use `{ok:false,command,code,error}` with `usage|parse|refused|io|internal`, and exit codes stay 0/2/1. `src/composition/composition-tool.ts` wraps the same `replaceComposition` service, so active-reference, lock and audit policy stays in `src/composition/composition-edit.ts`. Stage 4C adds read-only `wax composition revisions` and `wax composition recover`. `src/composition/composition-audit.ts` reads `<state-dir>/revisions.jsonl` (a missing file is empty), aborts on the first malformed line without echoing it, whitelists the six audit metadata fields, applies an exact composition filter and a newest-entries limit (1..1000, default 50), and inspects same-directory `.<basename>.tmp-*` candidates by parsing them. Recover reports each candidate as valid (with composition id and graph revision) or invalid (with a sanitized error) and has no apply/rename/delete path. `--json` returns `{ok:true,command:"revisions",entries,malformed:0}` or `{ok:true,command:"recover",file,candidates}`; the same `{ok:false,command,code,error}` failure shape is used.

Stage 4D wires the existing DSH ACP adapter into `createDefaultAdapter`, `wax run` and `wax daemon`. Harness selection resolves an explicit dsh root from `--dsh-root` or `DSH_ROOT`, rejects missing roots and cross-harness overrides before loading the composition, and keeps the Codex launch path unchanged. Adapter, runtime and daemon semantics are not modified.

Stage 4B-B adds `src/cli/mcp-server.ts`, a minimal newline-delimited JSON-RPC 2.0 MCP stdio server with no SDK, and `src/composition/composition-mcp.ts`, which builds the exact per-harness `wax_composition` declarations. `wax mcp` and `node dist/src/cli/mcp-server.js` serve `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call` with protocol `2024-11-05`; the two tools call `src/composition/composition-tool.ts` and return its JSON as one text content item. `wax run --composition-tools` and `wax daemon --composition-tools` inject `thread/start.config.mcp_servers.wax_composition` (Codex, object `env`) or `session/new.mcpServers` (DSH ACP, array `env`) through the existing adapter options, using `process.execPath` and the absolute built server path with argv only. The flag defaults off, and the MCP layer only presents the existing guarded service's decisions.

Stage 5A adds optional Merge branches with the existing text combine. `MergeConfig.optional` defaults to `[]`; required and optional ids must be unique and disjoint; the Stage 5C object/array combine arrives later. `arriveAtMerge` treats a branch listed in `optional` as valid, completes the join as soon as every required branch is present, and appends arrived optional values in `optional` order. Optional failures and unknown optional active work are logged as `merge.optional-failed` and never fail the required set; a branch that any Merge requires still uses the existing failFork sibling cancellation. A completed join is retained in `NodeState.joins` as a persisted tombstone (`completedAt`, empty `arrived`) instead of being deleted, so `isFieldResting`, `findActiveReferences` and `failMissingJoins` ignore it while `arriveAtMerge` can drop a late optional with `merge.optional-dropped` or reject a late required with `merge.failed` / `late-required`. Honey stores and parses `completedAt`, and a restored tombstone still drops late optional branches. Tombstones are pruned on restore, on the next arrival and on completion after one hour or above 64 markers per merge node. The parsed config always carries `optional`, so merge compositions receive a new graph revision and a pre-5A field needs a fresh run instead of `--resume`.

Stage 5B adds Merge `timeoutMs` and its persistence/wake plumbing. `MergeConfig.timeoutMs` defaults to `600000` and must be a positive integer no larger than `2147483647`; the parsed config always carries it, so every merge composition gets a new graph revision and a pre-5B merge field needs a fresh run instead of `--resume` (5A completed tombstones still parse and restore). The first branch arrival for a `forkId` records an absolute `deadlineAt`; an arrival that would complete the required set after that instant is timed out instead of emitted. `pump()` calls `expireDueJoins`, which turns a due incomplete join into a persisted tombstone (`timedOutAt`, empty `arrived`, no `deadlineAt`), logs `merge.timed-out`, and fails its fork with `merge.failed` / `timed-out`; queue/pending/hover siblings are cancelled, active siblings are left to finish, and nothing is emitted. `failMissingJoins` skips an incomplete join until its deadline, so a quiet field with no in-flight branch stays non-Rest instead of failing early. `failFork` removes incomplete joins but keeps closed tombstones, so a late active sibling cannot reopen a completed or timed-out join. Completed and timed-out tombstones share the 5A one-hour/64 bound and are ignored by `isFieldResting` and `findActiveReferences`. `PheromoneRuntime.nextWakeAt()` returns the earliest incomplete-join deadline; `wax run` sleeps until it (or an earlier rate-limited pending branch) when no hover is left, while the daemon keeps its 500 ms heartbeat. Restoring an unexpired join resumes with its original deadline; restoring an expired one fails it immediately.

Stage 5C adds the `structured` Value and Merge `combine: "object" | "array"`. `Value` gains `{kind:"structured", value: JsonValue}`, where `JsonValue` is JSON-safe only: null, boolean, finite number, string, array, or plain object. `src/runtime/json-value.ts` rejects undefined, functions, BigInt, Symbol, cycles and non-finite numbers; the runtime applies it to `trigger` and executor output, and `src/storage/honey.ts` revalidates it on load. Existing Value objects are accepted inside a structured payload because they are JSON-safe. `serializeValue` emits `JSON.stringify`, so the Forager prompt, Condition text mode and text Merge combine share one rendering. A Merge with `combine:"object"` emits `{kind:"structured", value:{[branchId]: Value}}`; `"array"` emits `{kind:"structured", value: Value[]}`. Both use required order followed by the optional branches that already arrived in optional config order. `text` is unchanged, required/optional/timeout semantics are unchanged, and attachment semantics inside `structured` are deferred.

Stage 5D adds nested Fork/Merge lineage without changing combine, optional or timeout semantics. `Pheromone` gains `lineage?: BranchTag[]` (`BranchTag = {forkId, branchId}`), outer-to-inner with the last tag as the current fork; `forkId`/`branchId` remain and are kept equal to it. A Fork appends a tag to the incoming lineage, a normal node reproduces it, and a Merge keys `NodeState.joins` by the current top `forkId`. Every arrival for a join must share the same parent lineage (the incoming lineage minus its last tag); a mismatch fails that `forkId` only. `JoinState` and `PersistedJoinState` carry the parent `lineage`, and `finishMerge` emits with it: nested output restores the outer tags, top-level output is untagged. `failFork` continues to match only the current `forkId`, so an inner failure or timeout cannot cancel an outer branch. Completed and timed-out tombstones retain their parent lineage and still block late reopens for their fork, including after restore. `src/storage/honey.ts` parses and validates tag shape, the flat/last-tag agreement, and join-lineage agreement; a pre-5D flat tag is promoted to a one-element lineage. `src/composition/composition-edit.ts` carries join lineage into the active-reference snapshot; no new dependency, node kind or Value kind was introduced.

Stage 6A adds the user answer inbox without changing Hover or the runtime wait model. `src/input/answer-inbox.ts` defines the `{answerId, compositionId, nodeId, hoverToken, value, at}` record, creates `<honey>/answers/` (0700), writes one record atomically through a same-directory temp file plus rename (0600), lists only `.json` files in name order, validates the Value shape with the same helper Honey uses, and deletes processed files. `src/input/user-answer.ts` moves the Stage 3C-2 `parseUserAnswer` out of the interactive CLI so `src/cli/answer-cli.ts` (`wax answer`) and `wax run` share the exact same modality parsing and attachment path checks. `wax answer` reads the composition and persisted field read-only, requires exactly one open user hover unless `--token`, refuses a graph-revision mismatch, and never calls `answerHover` or writes `field.json`. The daemon creates the inbox, scans it after each pump (including startup and every 500 ms heartbeat), and applies an answer only after confirming the current hover's node and token: `answerHover` is then called, Honey is flushed, and only then is the file deleted, so a crash can at worst leave the saved field already resolved and the file stale on restart. A missing composition/node/hover/token or a duplicate after resolution logs `answer.stale`; an unreadable or invalid record, or a Value rejected by the node modality, logs `answer.malformed`. Both delete the file and create no Pheromone or early-input queue. Scheduled triggers now accept a `user` target; the daemon triggers the node, the hover opens without a TTY, and an external `wax answer` completes it. `src/runtime/definition.ts` accepts the target, and the log gains `answer.applied`/`answer.stale`/`answer.malformed` plus an `answerId` field; answer Values are not logged.
