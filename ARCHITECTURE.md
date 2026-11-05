# WAX Apiary neXus — Architecture

> **Status**: target design. The PheromoneField runtime is not implemented yet; `src/` is an earlier prototype. This document and [`CONTRACT.md`](CONTRACT.md) are the current design references.

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
| Merge | Waits for required branches, consumes all, emits 1 |
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
type Value =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; choice: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'message'; text?: string; attachments: Attachment[] }
  | { kind: 'attachments'; attachments: Attachment[] };
```

- `Attachment.kind`: `image | file | audio`.
- `user` nodes declare a modality: text, choice, yes/no, message, image, or file.
- A normal prompt can be a message: text plus optional files/images/audio.
- A review is a yes/no `user` node; a Condition can branch directly on the boolean.
- The Pheromone itself is not split into “nectar” and “pollen” subtypes; it carries the Value.

## 5. Runtime

A trigger creates a Pheromone at a task node. A node consumes a Pheromone, runs, and emits new Pheromones on its outgoing edges.

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

Guard decisions are bound to `requestId` and `executionId`. A decision for one request is never replayed onto another. Guard has a timeout (default one hour); timeout rejects or cancels, never auto-allows.

## 7. Fork, Merge, Branch

- A **Fork** node has `branches: [{id, to}]`. It consumes one Pheromone, copies the Value to N Pheromones, and tags them with `forkId` and `branchId`.
- A **Merge** node has `required: [branchId]`. It groups arrivals by `forkId`; when all required branches have arrived, it consumes them atomically and emits one Pheromone.
- A required branch that fails or becomes unknown fails the Merge; siblings are cancelled. Optional branches follow explicit policy.
- A Merge with no outgoing edge is terminal.
- Fork/Merge/Branch are parallel-runtime features; the first runtime slice is single-Pheromone.

## 8. Live editing

- Every edit produces a GraphRevision.
- Node and edge IDs are stable.
- A node with queued, pending, active, hovering, or merge-waiting Pheromones is an active reference: delete/rename is rejected by default.
- A forced edit marks the affected node or Pheromone as stuck/needs attention; it never silently reroutes work.
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

The target runtime is not implemented. The repository's `src/` is an earlier prototype and serves as adapter/protocol evidence. The next implementation slice is a single-Pheromone core: trigger, node consumption/production, terminal/Rest, queue, pending, minimum interval, log, and tests. See [`CONTRACT.md`](CONTRACT.md).
