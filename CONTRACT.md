# WAX Apiary neXus — LiveHive Contract

Status: **target contract**. The code is a B-core prototype; this contract defines the target object/API shape for new work. M17j4 dispatch graph is implemented; ACP is the sole approval owner (M17j3a approval pass-through was superseded and reverted); M17j3 moved prompt admission into the WAX `DshAcpAdapter` (DSH source untouched) and removed the legacy WAX session queue.

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
- `dispatch` creates an ephemeral one-bee LiveHive graph, runs it through the same admission/approval path, and disposes it. It does not submit directly to a session and does not persist as a LiveHive. If the target session is busy, it waits in adapter admission up to the dispatch timeout and then returns 409 `dispatch-timeout`; it never returns an admission queue handle and never starts a second execution.

## 6. `PheromoneField`

- Holds pheromones, bee queues, pending, active, hover, join/tombstone, counters.
- A pheromone is short-lived; the field is the container.
- `field.json` is a snapshot, not an event log.
- `load` restores queues/pending/hover/incomplete joins; restored active pheromones are marked unknown/stuck and are not replayed.

## 7. Save / load / unload

- `load`: read `live.json` + Honey; memory becomes authoritative.
- `save`: flush field/scheduler/log to Honey; overwrite `live.json`.
- `unload`: also overwrite `live.json`, then flush and release field/runtime; sessions remain in `SessionRegistry`.
- No revision comparison, no CAS, no lease.
- Manual file copy is not a supported fork; WAX does not guarantee consistency for copied files.

## 8. Control API

The API is B-only:

```text
POST /lives                     create a LiveHive
POST /lives/load                load by id, optional path or inline live
POST /lives/instantiate         instantiate a template
POST /lives/wake                wake a bee
POST /lives/answer              answer a user hover
POST /lives/save                save
POST /lives/unload              unload
POST /lives/migrate             explicit structure change
GET  /lives                     list loaded and unloaded LiveHives
GET  /lives/:id/inspect         status, durable outputs and catalog entry
GET  /lives/:id/output          latest or runId-keyed output
GET  /lives/:id/runs/:runId     admitted run state/output
GET  /templates                 list templates
POST /templates                 compose a HiveTemplate
POST /dispatch                  ephemeral one-bee graph
GET  /guards                    pending guard requests
POST /guard/decide              decide one guard request
GET  /sessions                  global sessions
POST /sessions/close            close
POST /sessions/sweep            sweep idle
GET  /health
```

- One endpoint, one token.
- `--harness` filters/validates; it does not select a per-harness daemon.
- `POST /lives/wake` is admission-only: it returns **202** `{ ok:true, runId, traceId, status:"accepted" }` after placing the Pheromone in the target bee's mailbox. It does not wait for native execution or final output; query `GET /lives/:id/runs/:runId` for state/output. There is no legacy wait/result envelope.
- `POST /dispatch` creates an ephemeral one-bee graph, waits for its own run to finish, returns the output/sessionId, and disposes the graph; it is not persisted as a LiveHive. If the target session is busy, it waits in harness-side admission up to the dispatch timeout, then returns 409 `dispatch-timeout`; it never writes directly to the session, returns a queue handle, or starts a second execution. A non-queue adapter returns 409 `session-busy` instead of waiting. Unknown/conflict/cancelled errors retain the existing 404/409 mapping.
- `answer` is not admission-only; it remains the synchronous user-hover answer path.
- There is no queue-status route. Adapter admission is in memory only and has no public id; a restart forgets pending prompts and never replays them.
- `GET /guards` and `POST /guard/decide` cover approvals owned by WAX/ACP sessions. ACP owns its session's entire approval channel; there is no unowned-approval or GUI pass-through. A future send-message ingress is separate and cannot decide approvals.
- No fork route. The legacy graph, catalog and queue routes are not present and have no aliases.

## 9. CLI

```text
waxd
wax live new|load|instantiate|wake|answer|save|unload|migrate|list|inspect
wax wake <liveId> <beeId>
wax answer <liveId> <beeId>
wax template compose|list
wax dispatch
wax guard list|decide <requestId> --decision allow_once|reject_once|cancelled
wax session list|close|sweep
```

The legacy graph client commands and `wax queue` are not present and have no aliases.

## 10. Invariants

1. One daemon, one ControlServer, one state root.
2. One AdapterPool; one Workspace per harness; global SessionRegistry. The WAX `DshAcpAdapter` owns prompt admission, pending and the ACP approval channel; DSH source is untouched.
3. A LiveHive can mix harnesses; `liveId` is globally unique.
4. One session has one active execution. WAX-originated prompts are one FIFO per session at the adapter; WAX is low priority relative to direct user use.
5. Same LiveHive mutating operations are serialized; different LiveHives may run in parallel.
6. `unload` keeps the catalog/sessions; `inspect`/`output` do not refresh TTL.
7. Load makes memory authoritative; save/unload overwrite disk.
8. No Agent/Revision/Definition/Actor objects; no fork command. Dispatch is an ephemeral graph, not a persistent LiveHive.
9. Logs never contain prompt/output/token bodies; output uses explicit routes.
10. Never auto-allow Guard; ACP owns its session's approval channel with no GUI/pass-through; never replay side-effecting work.
