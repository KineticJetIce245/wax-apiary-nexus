# WAX Apiary neXus — LiveHive Contract

Status: **current contract** (M18 closeout, 2026-11-25). The delivery-only control plane is implemented: `trigger`/`answer` hand a Pheromone to the field and answer 202 with no id, `PheromoneField` owns execution state and the per-Bee last output, and `dispatch` accepts a delivery without returning the model output. There is no run tracker, run id, trace id, run store or `runs/` directory. The remaining known gap is the Honey directory layout (A23/C05), a separate persistence slice.

## 1. Scope

This document defines:

- the `live.json` file;
- bee/beeline/binding semantics;
- the `PheromoneField` runtime state;
- session binding and lifecycle;
- save/load/unload persistence;
- the control API and CLI surface.

It does not define Harness Adapter wire protocols, a UI, remote/multi-tenant behavior, or a plugin loader.

## 2. `live.json`

`live.json` is keyed by `beeId`:

```json
{
  "liveId": "demo",
  "bees": {
    "draft": { "kind": "forager", "config": {}, "outgoing": ["l1"] },
    "review": { "kind": "forager", "config": {}, "outgoing": ["l2"] },
    "done": { "kind": "forager", "config": {}, "outgoing": [] }
  },
  "beelines": {
    "l1": { "fromBee": "draft", "toBee": "review" },
    "l2": { "fromBee": "review", "toBee": "done" }
  },
  "bindings": {
    "draft": "s1",
    "review": "s2",
    "done": "s3"
  }
}
```

- `bees` and `bindings` use `beeId` as the key.
- `beelines` use `beelineId` as the key and reference `fromBee`/`toBee`.
- A control bee (condition/fork/merge/user) may have no binding.
- A bee with no outgoing beeline is terminal.
- There is no revision field and no CAS. `save`/`unload` overwrite the file.

## 3. Bee

```text
Bee = {
  beeId,
  kind,          // forager | worker | condition | fork | merge | user
  config,
  outgoing: [beelineId],
  roleLabel?,    // comment only
  sessionMode?   // reuse | fresh_once | always_fresh
}
```

- `beeId` is unique within a LiveHive.
- `forager` requires a session; `worker` runs argv; `condition` selects beelines; `fork`/`merge` are field control; `user` waits on hover.
- `roleLabel` is a comment/label; it does not route and does not bind a session.
- `sessionMode`:
  - `reuse`: a binding must exist;
  - `fresh_once`: create once, then reuse;
  - `always_fresh`: create a new session on every bee activation.

## 4. Beeline

```text
Beeline = {
  beelineId,
  fromBee,
  toBee,
  branch?    // fork/merge use, optional
}
```

- `beelineId` is unique within a LiveHive.
- Conditions choose outgoing beelines; fork/merge use `branch`.
- A beeline is not runtime state; it does not hold a session.

## 5. Session

```text
Session = {
  sessionId,
  harness,
  model?,
  reasoning?,
  params?
}
```

- A session is a native Harness lease; WAX stores routing metadata only.
- One session has at most one active execution. An explicit session is authoritative for harness/model/reasoning; a conflicting creation spec is an error.
- WAX-originated prompts are admitted by the WAX `DshAcpAdapter`, which owns one FIFO per session; DSH source remains untouched and its native one-prompt rule is honored by this adapter. Multiple bees/LiveHives may share a session; WAX is low priority and waits while a user is using it. There is no second WAX session-admission queue.
- An ACP session is the sole owner of its approval channel. Every approval from that session is handled by ACP/WAX; there is no unowned-approval handoff, GUI approval, or pass-through. ACP is automation-only: a DSH/Codex GUI may list or resume the persisted session but cannot receive or answer its live approvals.
- A separate send-message ingress may submit a new message to an ACP session; it cannot decide or cancel approvals and does not share the approval channel.
- `dispatch` creates an ephemeral one-bee graph, delivers the prompt through the same admission/approval path, answers 202, and releases the graph at silent end. It never returns the model output or a session id, is not persisted as a LiveHive, and has no dispatch timeout. A non-queue adapter that cannot admit the temporary bee returns 409 `session-busy`; the ACP adapter FIFO is the busy path.

## 6. `PheromoneField`

- Holds pheromones, one receptor per Bee, pending, active, hover, join/tombstone, counters, and the per-Bee last output.
- A Pheromone is one message/value travelling through the graph. A normal beeline moves the same Pheromone; only `fork` and `merge` change its cardinality. A Pheromone has a field-local `id` and carries no run/wake/trace identity.
- A receptor stores Pheromone objects directly and is FIFO. `pending` is a pacing slot for the head of a receptor; one Pheromone is active per Bee.
- A Bee with no outgoing beeline is terminal; its Pheromone becomes a field output.
- `field.json` is a snapshot, not an event log, and contains no run/trace record and no output cache.
- The per-Bee last output is a memory-only `Value` owned by the field. It is written by output-producing Bees (forager, worker, user, merge) on a successful activation; condition/counter/fork have no single result value and do not write it. It is overwritten by the Bee's next successful activation, is not written to `field.json`, is not a run history, and is released on `unload`.
- A loop is bounded by `counter`/`condition` and receptor overflow (`queueMax`); there is no per-trace hop or duration budget.
- `maxPumps`/`maxWaitMs` are host driver yields, not execution budgets; `queueTtlMs` is a per-receptor waiting TTL from the enqueue instant, not a message lifetime.
- `load` restores receptors/pending/hover/incomplete joins; restored active Pheromones are marked unknown/stuck and are not replayed.

## 7. Save / load / unload

- `load`: read `live.json` + Honey; memory becomes authoritative.
- `save`: flush field/scheduler/log to Honey; overwrite `live.json`. It does not make the output cache durable.
- `unload`: also overwrite `live.json`, then flush and release field/runtime; sessions remain in `SessionRegistry`. The field's last output is released.
- No revision comparison, no CAS, no lease.
- Manual file copy is not a supported fork; WAX does not guarantee consistency for copied files.

## 8. Control API

The API is B-only:

```text
POST /lives                     create a LiveHive
POST /lives/load                load by id, optional path or inline live
POST /lives/instantiate         instantiate a template
POST /lives/trigger             deliver input as a Pheromone
POST /lives/answer              bind a value to a user hover
POST /lives/save                save
POST /lives/unload              unload
POST /lives/migrate             explicit structure change
GET  /lives                     list loaded and unloaded LiveHives
GET  /lives/:id/inspect         status, field outputs and catalog entry
GET  /lives/:id/output          field output (no run id)
GET  /templates                 list templates
POST /templates                 compose a HiveTemplate
POST /dispatch                  ephemeral one-bee delivery
GET  /guards                    pending guard requests
POST /guard/decide              decide one guard request
GET  /sessions                  global sessions
POST /sessions/close            close
POST /sessions/sweep            sweep idle
GET  /health
```

- One endpoint, one token.
- `--harness` filters/validates; it does not select a per-harness daemon.
- `POST /lives/trigger` is delivery-only: it appends one Pheromone to the target Bee's receptor, returns **202** `{ ok:true }` and forgets the request. It does not wait for native execution, creates no run/trace id, and has no result query. Execution state is observed through the LiveHive itself (`inspect`, `output`, logs).
- Receptor overflow follows the configured policy:
  - `reject`: 429 `bee-receptor-full` with `liveId/beeId/pending/limit/policy`; no Pheromone enters the field;
  - `block`: wait outside the state lock, emit `bee-receptor-blocked`, then 429 `bee-receptor-block-timeout` with `waitedMs` if capacity does not arrive.
- `POST /lives/answer` validates the hover token, binds the value to the hovered Pheromone, clears hover, wakes the Bee and returns **202** `{ ok:true }`. It does not wait for the Bee to finish, creates no Pheromone and no second execution chain. If the downstream receptor cannot accept the value, it returns 429 `bee-receptor-full` (or the block timeout) before consuming the hover; the hover remains open.
- `POST /dispatch` creates an ephemeral one-bee graph, delivers the prompt, returns **202** `{ ok:true }`, and never returns the output or a session id. The temporary Bee is released at silent end and never becomes a LiveHive/catalog/Honey entry. A non-queue adapter that cannot admit it returns 409 `session-busy`; there is no dispatch timeout and no queue handle. Unknown/conflict errors keep the 404/409 mapping.
- `GET /lives/:id/output` returns the field-owned last output per Bee. It takes no run identifier and has no history: after `unload` it returns 404 `not-found`. A durable result must be written by a downstream Bee.
- There is no run, wake or trace query route and no per-request status id. There is no per-trace `maxHops`/`maxDuration`; loop safety is the graph plus receptor overflow.
- There is no queue-status route. Adapter admission is in memory only and has no public id; a restart forgets pending prompts and never replays them.
- `GET /guards` and `POST /guard/decide` cover approvals owned by WAX/ACP sessions. ACP owns its session's entire approval channel; there is no unowned-approval or GUI pass-through. A future send-message ingress is separate and cannot decide approvals. A guard decision is single-use: deciding the same request again returns 409 `conflict` (or 409 `guard-expired` for an expired request).
- No fork route. The legacy graph, wake, catalog, queue and run routes are not present and have no aliases.

## 9. CLI

```text
waxd
wax live list|new|load|instantiate|save|unload|inspect|migrate
wax trigger <liveId> <beeId> [--input <text>]
wax answer <liveId> <beeId> [--input <text>] [--token <hv_...>]
wax template compose|list
wax dispatch [--input <text>]
wax guard list|decide <requestId> --decision allow_once|reject_once|cancelled
wax session list|close|sweep
```

- `wax trigger`, `wax answer` and `wax dispatch` report only that the delivery was accepted (human line `accepted`, or `{ok:true}` with `--json`). They never print an output or a run/trace id; read `inspect`/`output` for the field's last output, and compose a graph for a durable result.
- There is no `wax wake`, no `wax live wake|answer` and no run query. Removed commands are usage errors (exit 2); there are no aliases.
- The legacy graph client commands and `wax queue` are not present and have no aliases.

## 10. Invariants

1. One daemon, one ControlServer, one state root.
2. One AdapterPool; one Workspace per harness; global SessionRegistry. The WAX `DshAcpAdapter` owns prompt admission, pending and the ACP approval channel; DSH source is untouched.
3. A LiveHive can mix harnesses; `liveId` is globally unique.
4. One session has one active execution. WAX-originated prompts are one FIFO per session at the adapter; WAX is low priority relative to direct user use.
5. Same LiveHive mutating operations are serialized; different LiveHives may run in parallel. Delivery is short and never holds the lock across native execution.
6. `unload` keeps the catalog/sessions; `inspect`/`output` do not refresh TTL.
7. Load makes memory authoritative; save/unload overwrite disk. The per-Bee output cache is memory-only and is released on unload.
8. The control plane owns no execution state: no run tracker, run/trace id, per-request registry or shadow lifecycle. A delivery ends at handoff. `Dispatch` is an ephemeral graph, not a persistent LiveHive; there is no fork command.
9. No Agent/Revision/Definition/Actor objects.
10. Logs never contain prompt/output/token bodies; output uses explicit routes.
11. Never auto-allow Guard; ACP owns its session's approval channel with no GUI/pass-through; never replay side-effecting work. A restored active Pheromone is unknown and is not replayed.
12. Every LiveHive has a finite `queueMax`; loop safety relies on counters/conditions and receptor overflow, not on a per-trace budget.
13. `Pheromone.id` is a field-local message identity, not a run/execution handle. It may appear in internal logs and fork/merge/join bookkeeping, but no HTTP/CLI route, registry, tracker, persistence key, output/status lookup, wait, or idempotency key may use it. Reusing the same id across normal Bees means one message moved, not one run.
