# WAX Apiary neXus — Composition Contract

> **Status**: target contract. The runtime implements the single-Pheromone core, Stage 3A Fork/Merge/Branch, Stage 3B Worker/Condition worker, the Stage 3C-1 foreground daemon scheduler, and Stage 3C-2 rich manual user input; scheduled `user` triggers and the rest of this contract are still target design. The architecture model is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

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
- Early or late input queues at this node and applies on the next entry.
- Scheduled `user` triggers remain deferred.

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
- Each emitted Pheromone copies the Value and gets `forkId` + `branchId`.
- Branches have unique ids; `to` must exist.
- Fork has no normal default edge.

### Merge

```json
{
  "kind": "merge",
  "config": {
    "required": ["a", "b"],
    "optional": [],
    "combine": "object",
    "timeoutMs": 600000
  }
}
```

- Waits for the required branch Pheromones, grouped by `forkId`.
- Consumes all required Pheromones atomically and emits one combined Pheromone.
- `combine`: `object`, `array`, `text`.
- Missing/failed required branches fail the Merge and cancel siblings.
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
  - The target must be a `forager` or `worker` node. Control nodes are rejected; scheduled `user` targets are deferred to Stage 3C-2.
- A trigger creates a Pheromone at the target node. There is no `start`.
- Node activations are rate-limited by `lastActivatedAt + minInterval`.
- Serialized manual CLI triggers accept `forager`, `worker` and `user` targets.
- The daemon is one composition per process. Occurrences are recorded before the Pheromone is enqueued, so delivery is at-most-once: an occurrence may be lost in a crash, never duplicated. A past `at` and a missed `every` fire at most once on start; `every` then reschedules from the start time and never storms skipped intervals.
- The daemon restores Honey before scheduling. A restored active Forager remains unknown, other active nodes (including a Worker) remain stuck, and nothing is replayed.

## 6. Values and templates

```ts
type Value =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; choice: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'message'; text?: string; attachments: Attachment[] }
  | { kind: 'attachments'; attachments: Attachment[] };
```

- `Attachment.kind`: `image`, `file`, `audio`.
- `forager.prompt` supports `{{input}}` only; the Value is serialized to text.
- Attachments are passed to the adapter separately.
- Pheromones are not split into separate value subtypes.

## 7. PheromoneField

```ts
type Pheromone = {
  id: string;
  traceId: string;
  forkId?: string;
  branchId?: string;
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
- The log does not store prompt/output bodies by default.
- The log is not a replay source. Recovery reads Honey; side effects are never auto-replayed.

## 11. Validation

Before running:

- `schemaVersion`, `id`, `nodes`, and `edges` are valid.
- Node/edge/trigger ids are unique and match the pattern.
- There is no End node; any node without an outgoing edge is terminal.
- Normal nodes have at most one default edge; Condition has `true`/`false`; Counter has `continue`/`done`; Fork uses branches; Merge has at most one default edge.
- Edge endpoints exist; `when` only appears on Condition/Counter edges.
- Fork branches are unique and targets exist.
- Merge required branches are unique; combine is valid.
- Trigger targets are task nodes; scheduled triggers accept only `forager` or `worker`.
- `at` carries `Z` or an explicit offset; `everyMs` is an integer >= 1000.
- Forager connection/prompt are non-empty; user modality is valid; Condition mode is valid; Counter max/step are positive.
- Worker `command` is non-empty; `args` is a string array; `cwd` is a non-empty string without `..`; `timeoutMs` is a positive integer. Absolute cwd containment and symlink escapes are enforced at activation, when the project directory is known.
- `minIntervalMs` is at least `1000`.
- `queueMax` / `queueTtlMs` are positive.
- Cycles are allowed; terminal nodes are valid.
- Cross-composition live shared mutable nodes are rejected.

## 12. CLI

```bash
wax run <composition.json> --project <dir> --harness codex [--trigger <node>] [--input <text>] [--resume]
wax daemon <composition.json> --project <dir> --harness codex [--state-dir <dir>] [--apiary <id>] [--codex-exe <path>]
wax composition validate <file>
wax trigger <composition> <node> [--text "..."]
wax status [<composition>] [--json]
wax log <composition> [--tail N] [--json]
wax honey <conversationId> [--json]
```

- No `run start`; a trigger creates a Pheromone.
- `wax status --json` reports composition, Pheromones at nodes, node queue/pending/active/hover state, log path, and Honey path. It does not print prompt/output bodies by default.
- `wax honey` reads durable transcripts/artifacts.

## 13. Implementation status

`src/runtime/` implements the single-Pheromone slice plus Stage 3A Fork/Merge/Branch and Stage 3B Worker: composition parse/validation, `PheromoneField` state, `trigger`, consumption/production, terminal/Rest, FIFO queue with pending and `minIntervalMs`, `condition`/`counter`, `user` nodes with `HoverSpec` (answers arriving before the hover are queued, not dropped), Guard hovers for native approvals, and field export/restore. A Fork emits one tagged copy per branch; branch tags survive normal nodes; a Merge groups by `forkId`, waits for its `required` branches, consumes them atomically, and emits one newline-joined text value (`combine: "text"` only in 3A). Joins persist in Honey and count as live references; duplicate, unknown, failed or missing required branches fail the merge and cancel siblings. Optional branches, object/array combine, and merge timeouts are not implemented in 3A and are rejected by validation. Guards are bound to a `requestId`, cancelled after one hour, rejected by default, and refused when a decision arrives early, late or for another request. `src/forager.ts` bridges a Workspace conversation; `src/honey.ts` writes `honey/field.json` atomically, appends a metadata `log.jsonl`, and keeps per-conversation transcripts that the log only references; both rotate. `wax run --resume` restores a field. An `active` Pheromone cannot be reattached: a Forager becomes unknown, other nodes (including an active Worker) become stuck, and nothing is replayed. `src/revision.ts` refuses edits that orphan live node state. `src/runtime/worker.ts` runs argv-only Workers with project-contained cwd, a default 60s timeout, 64 KiB caps per stream and process-tree kill; the composition log records program/pid/byte counts but not output bodies. Condition `mode: "worker"` branches on the exit code.

Stage 3C-1 adds scheduled composition triggers and `wax daemon`. `parseComposition` accepts unique `at`/`every` triggers targeting `forager` or `worker`; `PheromoneRuntime.trigger` now also accepts a Worker target. `src/scheduler.ts` records each occurrence in `honey/scheduler.json` before enqueueing it, fires a past `at`/missed `every` once on start, and reschedules `every` from the start time without a missed-interval storm. `src/daemon-lock.ts` provides the per-composition PID lock. The daemon restores Honey, rejects Guard requests without a TTY, pumps restored queued Pheromones, and stops scheduling on SIGINT/SIGTERM. Stage 3C-2 adds manual `message`, `image` and `file` user answers. `parseComposition` accepts the three modalities and still rejects `choices` outside `choice` mode. `PheromoneRuntime.answerHover` validates the answer against the node modality: a message must carry text and an empty attachment list, and an image/file answer must carry exactly one attachment of the matching kind with a non-empty path and an optional string `mediaType`; the runtime never touches the filesystem. The interactive CLI prompts for a message (empty is rejected) or one local path (leading `~` expanded, missing/non-regular file rejected, absolute path returned), and a non-interactive stdin is still refused. Scheduled `user` triggers remain deferred.
