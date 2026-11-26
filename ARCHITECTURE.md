# WAX Apiary neXus — Architecture

Status: **target architecture**. The code is a B-core prototype; the target terms below are the source of truth for new work. M17j4 dispatch graph, ACP approval ownership and the adapter-owned prompt FIFO are implemented. M18 phase 3 mailbox snapshots/overflow are aligned with this target. The M18 phase 2/4 run tracker, run/wake/trace ids and per-trace limits are **legacy and must be removed**; see §8.

## 1. One sentence

A **LiveHive** is a loaded graph of **bees** connected by **beelines**; the **PheromoneField** owns all execution state, and the control plane only delivers messages into that field.

## 2. Layers

```text
L4  Control / CLI        ControlServer / ControlClient / wax (delivery only)
L3  LiveHive host        LiveHiveService / LiveHiveHost / LiveHiveCatalog / LiveHiveLock
L2  Session              SessionRegistry / AdapterPool / Workspace
L1  Adapter              CodexAdapter / DshAcpAdapter + adapter-owned prompt admission
L0  Native harness       Codex app-server / DSH ACP server
```

Dependency direction is upward only: L3 may call L2/L1; L2 does not know the control layer; L1 does not know LiveHive.

The control plane has no execution registry. It validates a request, hands it to a Bee/field, returns a delivery acknowledgement, and forgets it.

## 3. Core objects

| Object | Meaning |
| --- | --- |
| `LiveHive` | First-class runtime object: `bees`, `beelines`, `beeId -> sessionId` bindings, `PheromoneField`, scheduler/log, lifecycle |
| `Bee` | Execution slot and execution owner: `beeId`, kind, config, outgoing beelines, optional RoleLabel, sessionMode |
| `Beeline` | Directed connection between bees: `beelineId`, `fromBee`, `toBee`, optional branch |
| `BeeBinding` | `{ beeId, sessionId }` for bees that need a native session |
| `Session` | Native session record: `sessionId`, harness, model, reasoning, params |
| `HiveTemplate` | Optional saved graph + per-bee default session params; not required to create a LiveHive |
| `RoleLabel` | Comment/label on a bee; not an instance, not a route |
| `PheromoneField` | The single owner of runtime state: pheromones, queues/mailboxes, pending, active, hover, joins/tombstones, outputs |
| `Dispatch` | A temporary Bee started for one prompt; it lives until the tool returns, then either flows to its next Bee or silently ends |

There is no Agent object, no Revision/Definition object, no Actor object, and no control-plane Run/Wake/Trace object.

## 4. Execution and ownership

1. `load` reads `live.json` (bees/beelines/bindings) and Honey (`field.json`); after load, memory is authoritative.
2. `wake(liveId, beeId, input)` is **delivery**, not execution tracking:
   - validate the live, bee and input;
   - place a Pheromone in the target Bee's mailbox;
   - return `202 { ok: true }`;
   - the wake operation is now finished and has no id, no lifecycle, no record and no later query.
   The Bee/field drains the Pheromone outside the HTTP request.
3. `answer(liveId, beeId, input, token)` is also delivery:
   - validate that the Bee is hovering with this token;
   - deliver the value to that hover;
   - return `202 { ok: true }`;
   - do not create a run, return a result, or keep an answer handle.
4. `dispatch` starts a **temporary Bee** with one prompt:
   - return `202 { ok: true }` after delivery;
   - the Bee lives until the tool returns;
   - if the returned output has a next Bee/beeline, it flows there;
   - if there is no next Bee, it **silently ends** and is released.
   `dispatch` never returns the output. A caller that needs the result must compose a more complex graph that routes the result to the next Bee.
5. A forager bee uses its bound session (or creates one per sessionMode); a worker bee runs argv; condition/fork/merge are control bees; user waits on hover; guard waits on approval.
6. Outputs follow outgoing beelines; a bee with no outgoing beeline is terminal. The field is at Rest when no active/pending/queued/hover/join remains.
7. `save` and `unload` write `live.json` and flush field/scheduler/log to Honey; `unload` then releases field/runtime but keeps sessions.
8. There is no revision or CAS. `field.json` is a snapshot, not an event log; active pheromones restore as unknown/stuck and are not replayed.

### 4.1 Ownership rule

```text
control plane  -> may deliver; must not own execution state
Bee/field      -> own execution state
Honey          -> owns durable snapshots of field state
```

Consequences:

- No `RunTracker`, `WakeTracker`, `TraceTracker`, per-request registry or shadow lifecycle.
- No `runId`, `wakeId`, `traceId`, span or per-request status.
- No `GET /lives/:id/runs/:id`; there is nothing to query after delivery.
- No `runs/` records on disk.
- The only observable execution state is the LiveHive/field: `inspect`, output, mailbox/pending/active/hover/join and logs.
- If a caller wants a result, the result is an edge to another Bee, not a control-plane return value.

### 4.2 Prompt admission and approval ownership

The WAX `DshAcpAdapter` owns a per-session FIFO queue for WAX-originated
prompts; the DSH source is untouched and its native one-prompt rule is honored
by this adapter queue:

```text
Bee wants prompt -> WAX DshAcpAdapter admission -> native session
                    (pending / active / terminal)
```

- One native session has at most one WAX execution at a time; different sessions
  may run in parallel. WAX is low priority: if a user is already using the
  session, the WAX request waits.
- Pending is adapter admission state, not a Bee hover and not a Pheromone queue.
- The adapter registers the execution context (WAX executionId, liveId, beeId,
  sessionId, nativeSessionId) before sending and keeps it until terminal. That
  executionId is adapter-local correlation, not a public run/wake identity.
- The ACP session is the sole owner of its approval channel. Every approval
  produced by an ACP session is handled by the ACP client/WAX; there is no
  unowned-approval handoff and no pass-through to a GUI/native handler.
- ACP is automation-only. A DSH/Codex GUI may list or resume a persisted
  session, but it is a different live owner: it does not receive the ACP
  session's pending approvals and cannot answer them.
- A separate **send-message ingress** may exist for submitting a new message to
  an ACP session. It only enqueues/sends a message; it is not an approval
  channel and cannot decide or cancel approvals.
- Direct Web/TUI prompts bypass the adapter. Admission priority is best-effort:
  WAX does not start while the session is visibly busy; once a WAX turn is
  running, user steer/preemption needs the reserved steer path.
- `wax answer` is a graph/user-hover delivery, not an admission queue. `wax
  guard` covers ACP/WAX-owned approvals.
- `dispatch` uses the same admission/approval path for its temporary Bee; it
  does not write directly to a session and does not persist as a LiveHive.

## 5. Persistence

```text
<stateRoot>/
  waxd/
    sessions.json
    live-catalog.json
    graph-bindings.json
  templates/<templateId>.json
  lives/<liveId>/
    live.json
    honey/field.json
    honey/scheduler.json
```

- `live.json` is keyed by `beeId` for `bees` and `bindings`; `beelines` are keyed by `beelineId`.
- `honey/field.json` is the durable field snapshot, including awake mailboxes and active/pending/hover markers.
- `sessions.json` is global; each session record carries its harness.
- There is no `runs/` directory and no per-wake/per-run record.
- Adapter prompt admission/pending is memory-only; no replay after restart. A dispatch Bee is temporary and is not persisted as a LiveHive.
- No revision file; a content hash may be added later for audit only.

## 6. Concurrency and failure

- One `waxd` process, one state root, one ControlServer.
- One AdapterPool; each harness has one Workspace. A failed harness is marked `unavailable` and does not block the daemon.
- `LiveHiveLock` covers mutating host operations per LiveHive; delivery is short and must not hold the lock across native execution. Different LiveHives may run in parallel.
- Each Bee has one mailbox and one active Pheromone; same-Bee work is FIFO/serial, different Bees may overlap. `queueMax` overflow is `reject` (429 `bee-mailbox-full`) or `block` (429 `bee-mailbox-block-timeout` after the configured wait); block waits outside the state lock.
- One session has at most one active execution. Sharing a session across LiveHives is serialized by the WAX `DshAcpAdapter` FIFO; an explicit busy path may return `session-busy`, never a silent second execution.
- WAX-originated prompts are low priority. The adapter does not preempt a running user turn; steering is a reserved future path, not part of M17j.
- Approval ownership is session-scoped: the ACP session owns its approval channel. There is no cross-process GUI handoff and no approval pass-through.
- `SessionOwnership` is refcounted ownership bookkeeping, not a mutex: it records which loaded LiveHives hold an explicit session. It never blocks or rejects sharing; prompt serialization is the adapter FIFO (`DshAcpAdapter.SessionPromptQueue`).
- Loop safety is graph-level and Bee-level: counter/condition nodes, `queueMax` and mailbox overflow prevent unbounded handoff. There is no per-wake hop/duration budget, because there is no wake object to budget.
- No automatic replay of side-effecting work; Guard never auto-allows.

### 6.1 Implemented vs target

- **Aligned:** per-Bee mailbox and on-demand drain; short delivery; mailbox snapshot and overflow (`reject|block`); adapter session FIFO; ACP approval ownership.
- **Legacy, to remove:** `RunTracker`, `runId`/`traceId`, `GET /lives/:id/runs/:runId`, `RunStore` wake records, `TraceLimitError`, per-trace `maxHops`/`maxDuration`.

## 7. Public names and API

The public object layer is B: `LiveHive`, `Bee`, `Beeline`, `BeeBinding`, `HiveTemplate`, `Schedule` and `Dispatch`. The control API and CLI expose `/lives`, `/templates`, `/dispatch`, `/guards`, `/sessions`, `wax live`, `wax wake`, `wax answer`, `wax template`, `wax dispatch`, `wax guard` and `wax session`.

```text
POST /lives/wake        deliver one input; 202 { ok: true }
POST /lives/answer      deliver one hover answer; 202 { ok: true }
POST /dispatch          start a temporary Bee; 202 { ok: true }
POST /lives/save|unload|migrate
GET  /lives             list loaded/unloaded LiveHives
GET  /lives/:id/inspect status + durable outputs + catalog entry
GET  /lives/:id/output  field output (no run id)
GET  /templates | POST /templates
GET  /guards | POST /guard/decide
GET  /sessions | POST /sessions/close|sweep
GET  /health
```

There is no run/wake/trace query route and no per-request status id.

`LiveHiveHost`, `LiveHiveStatus`, `LiveHiveId` and `CompositionDefinition` remain internal execution-engine names. They are not a second object model and are not exposed by the HTTP or CLI surface. `CompositionDefinition` is unchanged.

The legacy graph control surface and its client commands were removed in M10c; there are no aliases.

## 8. Current implementation gap

The current code still contains the M18 phase 2/4 control-plane tracker:
`RunTracker`, `runId`/`traceId`, `/lives/:id/runs/:runId`, RunStore wake records and
per-trace hop/duration limits. They are **not** part of this target and must be
removed in the next slice. Until that removal lands, the code is not conformant
to this document; do not treat the presence of those fields as approval to keep
them.
