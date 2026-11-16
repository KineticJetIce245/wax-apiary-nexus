# WAX Apiary neXus — Architecture

Status: **target architecture**. The code is a B-core prototype; the target terms below are the source of truth for new work.

## 1. One sentence

A **LiveHive** is a loaded graph of **bees** connected by **beelines**; each bee runs a native harness session, and the running state lives in a **PheromoneField**.

## 2. Layers

```text
L4  Control / CLI        ControlServer / ControlClient / wax
L3  LiveHive host        LiveHiveHost / LiveHiveCatalog / LiveHiveRegistry / LiveHiveLock
L2  Session              SessionRegistry / AdapterPool / Workspace
L1  Adapter              CodexAdapter / DshAcpAdapter
L0  Native harness       Codex app-server / DSH ACP server
```

Dependency direction is upward only: L3 may call L2/L1; L2 does not know the control layer; L1 does not know LiveHive.

## 3. Core objects

| Object | Meaning |
| --- | --- |
| `LiveHive` | First-class runtime object: `bees`, `beelines`, `beeId -> sessionId` bindings, `PheromoneField`, scheduler/log, lifecycle |
| `Bee` | Execution slot: `beeId`, kind, config, outgoing beelines, optional RoleLabel, sessionMode |
| `Beeline` | Directed connection between bees: `beelineId`, `fromBee`, `toBee`, optional branch |
| `BeeBinding` | `{ beeId, sessionId }` for bees that need a native session |
| `Session` | Native session record: `sessionId`, harness, model, reasoning, params |
| `HiveTemplate` | Optional saved graph + per-bee default session params; not required to create a LiveHive |
| `RoleLabel` | Comment/label on a bee; not an instance, not a route |
| `PheromoneField` | Runtime state: pheromones, queues, pending, active, hover, joins/tombstones |
| `Dispatch` | Immediate execution of a temporary bee; not a LiveHive |

There is no Agent object, no Revision/Definition object, and no Actor object.

## 4. Execution

1. `load` reads `live.json` (bees/beelines/bindings) and Honey (`field.json`); after load, memory is authoritative.
2. `wake(liveId, beeId, input)` places a Pheromone at the bee and pumps.
3. A forager bee uses its bound session (or creates one per sessionMode); a worker bee runs argv; condition/fork/merge are control bees; user waits on hover; guard waits on approval.
4. Outputs follow outgoing beelines; a bee with no outgoing beeline is terminal. The field is at Rest when no active/pending/queued/hover/join remains.
5. `save` and `unload` write `live.json` and flush field/scheduler/log to Honey; `unload` then releases field/runtime but keeps sessions.
6. There is no revision or CAS. `field.json` is a snapshot, not an event log; active pheromones restore as unknown/stuck and are not replayed.

## 5. Persistence

```text
<stateRoot>/
  waxd/
    sessions.json
    live-catalog.json
  lives/<liveId>/
    live.json
    honey/field.json
    honey/scheduler.json
```

- `live.json` is keyed by `beeId` for `bees` and `bindings`; `beelines` are keyed by `beelineId`.
- `sessions.json` is global; each session record carries its harness.
- No revision file; a content hash may be added later for audit only.

## 6. Concurrency and failure

- One `waxd` process, one state root, one ControlServer.
- One AdapterPool; each harness has one Workspace. A failed harness is marked `unavailable` and does not block the daemon.
- `LiveHiveLock` serializes all mutating operations per LiveHive; different LiveHives may run in parallel.
- One session has at most one active execution. Sharing a session across LiveHives requires queue/forward or an explicit `session-busy` error; never silent.
- No automatic replay of side-effecting work; Guard never auto-allows.

## 7. Code names vs target names

| Target | Current code |
| --- | --- |
| LiveHive | `LiveGraph` / `Graph` |
| Bee | `node` / `Node` |
| Beeline | `edge` |
| `wake` | `trigger` |
| LiveHiveHost | `GraphHost` |
| hive structure | `CompositionDefinition` / `GraphDefinition` |

The renames happen during the M9 refactor. Until then, the code may use the old names internally.
