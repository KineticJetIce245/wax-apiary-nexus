# WAX Apiary neXus — LiveHive Contract

Status: **target contract**. The code is a B-core prototype; this contract defines the target object/API shape for new work.

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
- One session has at most one active execution.
- An explicit session is authoritative for harness/model/reasoning; a conflicting creation spec is an error.
- Multiple bees/LiveHives may share a session only with queue/forward support, or the send must return `session-busy`; never silent.

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

Target routes:

```text
POST /lives                     new LiveHive
POST /lives/:id/load            load
POST /lives/:id/unload          unload
POST /lives/:id/wake            wake a bee
POST /lives/:id/answer          answer a user hover
POST /lives/:id/guard           guard decision
POST /lives/:id/save            save
POST /lives/:id/migrate         explicit structure change
GET  /lives                     list
GET  /lives/:id                 status
GET  /lives/:id/output          run output
GET  /sessions                  global sessions
POST /sessions/close            close
POST /sessions/sweep            sweep idle
POST /dispatch                  temporary bee
POST /templates                 compose HiveTemplate
GET  /templates                 list templates
```

- One endpoint, one token.
- `--harness` filters/validates; it does not select a per-harness daemon.
- No fork route.

## 9. CLI

```text
waxd
wax live new|load|instantiate|wake|answer|guard|save|unload|migrate|list|status|output
wax dispatch
wax template compose|list
wax session list|close|sweep
```

Current code still exposes `wax graph` / `wax trigger`; those names are renamed during M9.

## 10. Invariants

1. One daemon, one ControlServer, one state root.
2. One AdapterPool; one Workspace per harness; global SessionRegistry.
3. A LiveHive can mix harnesses; `liveId` is globally unique.
4. One session has one active execution.
5. Same LiveHive mutating operations are serialized; different LiveHives may run in parallel.
6. `unload` keeps catalog/sessions; `status`/`output` do not refresh TTL.
7. Load makes memory authoritative; save/unload overwrite disk.
8. No Agent/Revision/Definition/Actor objects; no fork command.
9. Logs never contain prompt/output/token bodies; output uses explicit routes.
10. Never auto-allow Guard; never replay side-effecting work.
