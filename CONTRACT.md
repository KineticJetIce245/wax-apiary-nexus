# WAX Apiary neXus — Composition Contract

> **Status**: target contract. The runtime described here is not implemented yet. The architecture model is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

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
- `triggers` is optional; manual triggers are not stored in the file; schedule triggers are a later feature.
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

- Local task node; planned after the single-Pheromone core.
- argv only; no shell string; bounded output; sandbox policy separate.

### user

```json
{ "kind": "user", "config": { "modality": "yes-no", "prompt": "Approve?" } }
```

- Human input node.
- `modality`: `text`, `choice`, `yes-no`, `message`, `image`, `file`.
- `choices` is required for `choice`.
- Early or late input queues at this node and applies on the next entry.

### Condition

```json
{ "kind": "condition", "config": { "mode": "boolean" } }
```

- Control node; no hover.
- `mode`: `text`, `boolean`, `choice`, `worker`.
- Text mode uses exactly one of `contains` / `equals`.
- Boolean mode reads `Value.value`.
- Choice mode compares the selected choice.
- Worker mode runs argv and branches on the exit code; planned after the core.
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
- Scheduled: `id`, `target`, and schedule config; planned later.
- Target must be `forager`, `worker`, or `user`; not Condition/Counter/Fork/Merge.
- A trigger creates a Pheromone at the target node. There is no `start`.
- Node activations are rate-limited by `lastActivatedAt + minInterval`.

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
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/transcripts/<conversationId>.jsonl
~/.wax/apiaries/<apiaryId>/compositions/<compositionId>/honey/artifacts/
```

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
- Trigger targets are task nodes.
- Forager connection/prompt are non-empty; user modality is valid; Condition mode is valid; Counter max/step are positive.
- `minIntervalMs` is at least `1000`.
- `queueMax` / `queueTtlMs` are positive.
- Cycles are allowed; terminal nodes are valid.
- Cross-composition live shared mutable nodes are rejected.

## 12. CLI

```bash
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

`src/runtime/` implements the single-Pheromone slice plus Stage 3A Fork/Merge/Branch: composition parse/validation, `PheromoneField` state, `trigger`, consumption/production, terminal/Rest, FIFO queue with pending and `minIntervalMs`, `condition`/`counter`, `user` nodes with `HoverSpec` (answers arriving before the hover are queued, not dropped), Guard hovers for native approvals, and field export/restore. A Fork emits one tagged copy per branch; branch tags survive normal nodes; a Merge groups by `forkId`, waits for its `required` branches, consumes them atomically, and emits one newline-joined text value (`combine: "text"` only in 3A). Joins persist in Honey and count as live references; duplicate, unknown, failed or missing required branches fail the merge and cancel siblings. Optional branches, object/array combine, and merge timeouts are not implemented in 3A and are rejected by validation. Guards are bound to a `requestId`, cancelled after one hour, rejected by default, and refused when a decision arrives early, late or for another request. `src/forager.ts` bridges a Workspace conversation; `src/honey.ts` writes `honey/field.json` atomically, appends a metadata `log.jsonl`, and keeps per-conversation transcripts that the log only references; both rotate. `wax run --resume` restores a field. An `active` Pheromone cannot be reattached: a Forager becomes unknown, other nodes become stuck, and nothing is replayed. `src/revision.ts` refuses edits that orphan live node state. Worker, schedules and richer value modalities are still open.
