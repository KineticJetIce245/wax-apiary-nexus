# WAX Apiary neXus — Architecture

> **Status**: target design. The PheromoneField single-Pheromone slice, Stage 3A Fork/Merge/Branch, Stage 3B Worker/Condition worker, the Stage 3C-1 foreground daemon scheduler, the Stage 3C-2 rich manual user input, the Stage 4A offline composition editor, the Stage 4B-A JSON CLI contract for that editor, the Stage 4C read-only revision audit and orphan-temp inspection, and the Stage 4D DSH harness wiring are implemented; scheduled `user` triggers, optional branches and merge timeouts are still open. This document and [`CONTRACT.md`](CONTRACT.md) are the current design references.

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
- A **Merge** node has `required: [branchId]`. It groups arrivals by `forkId`; when all required branches have arrived, it consumes them atomically and emits one Pheromone.
- A required branch that fails or becomes unknown fails the Merge; siblings are cancelled. Optional branches follow explicit policy.
- A Merge with no outgoing edge is terminal.
- Stage 3A implements required branches, text combine, and sibling cancellation. Optional branches, object/array combine, and merge timeouts remain open.

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
