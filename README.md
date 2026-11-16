# WAX Apiary neXus

WAX Apiary neXus is a local coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into **LiveHive**s without reimplementing their session logic.

It is not a new agent runtime. Each harness stays native; WAX coordinates LiveHives, bees, sessions, work, waits, and persistence around it.

## Target

```text
waxd
  ├─ AdapterPool            codex / dsh → one Workspace each
  ├─ SessionRegistry        global; session.harness decides the Workspace
  ├─ LiveHiveHost           load / wake / answer / guard / save / unload
  │    └─ LiveHive          bees + beelines + PheromoneField
  └─ ControlServer          one local endpoint, one token
```

- **LiveHive is the first-class object.** A LiveHive is a loaded graph with `bees`, `beelines`, `beeId -> sessionId` bindings, and a `PheromoneField`.
- **Bee is the execution slot** (previously called node). A bee has a kind, config, outgoing beelines, optional RoleLabel, and a session mode.
- **Beeline is a connection** (previously called edge). Conditions choose outgoing beelines; fork/merge use branches.
- **`wake` replaces trigger.** `wake(liveId, beeId, input)` creates a Pheromone at the bee and pumps.
- **Save and unload both write `live.json`.** Load makes memory authoritative; disk changes are ignored until the next save/unload.
- **No Agent/Revision/Definition/Actor objects.** To see what a bee runs, look at `beeId -> sessionId -> session.harness/model/reasoning`.
- **No `fork LiveHive` command.** Manually copying files is not prevented, but not supported.

## Current status

The code is a B-core prototype with the M9c single-daemon shape, M9d scheduler/guard/run wiring, M9e session-ownership checks, and the M9f1 GraphHost split; it does **not** yet implement the full target above.

- **M9a/M9b/M9c (committed in `3eb24b0`)** are wired together: one `AdapterPool`, one global `SessionRegistry`, one `GraphHost`, one `ControlServer`, one endpoint. A graph can mix Codex and DSH sessions.
- **M9b** added `LiveHiveCatalog`, per-live `LiveHiveLock`, a graph TTL timer, and `GET /catalog`; unloaded LiveHives keep their identity. `status` still reports loaded graphs only.
- **M9d (committed in `425fcdc`)** added the per-LiveHive scheduler, `GET /guards` + `POST /guard/decide`, and durable `RunStore` output (`runId`/`requestId`, readable after unload).
- **M9e (committed in `a5be496`)** makes `fresh_once` reuse depend on harness + projectDirectory, and rejects a second loaded graph that binds the same explicit session with HTTP 409 `session-busy`.
- **M9f1 (uncommitted)** splits `GraphHost` into a 114-line facade plus lifecycle/execution/read/session-ownership services, and deletes the dead `drain`/`firstHover`/`lastOutputs` APIs.
- `--harness` no longer selects a per-harness directory; it only validates/filter. `waxd --harnesses codex,dsh` uses one daemonDir/stateRoot/port/token.
- The current command surface is still `waxd`, `wax graph`, `wax trigger`, `wax session`; target names are `wax live` and `wax wake`.
- The regression suite is 734 tests (733 pass + 1 Windows skip after M9f1; 5 dead-API tests were removed). Real integration now includes a mixed Codex+DSH `waxd` graph, a DSH/Codex product check, a scheduled Codex graph, a real DSH guard approval, and a real DSH session-busy/reload check; the full `npm run test:integration` suite was not run as a whole.

## Current commands

```text
waxd (--harness <codex|dsh> | --harnesses <codex,dsh>) [options]
wax graph list|status <graphId>|output <graphId>|load <composition>|load --manifest <file>|unload <graphId>|sweep|answer <graphId> <nodeId>
wax trigger <graphId> <nodeId> [--input <text>] [--graph <manifest>]
wax session list|close <sessionId>|sweep
```

`wax run`, `wax daemon`, `wax answer`, `wax status/log/honey`, `wax composition` and `wax mcp` are removed. One-shot/headless execution goes through `waxd` plus the control API; there is no second host.

## Current code names vs target names

The code still uses the old names; renames happen during the M9 refactor.

| Target | Current code |
| --- | --- |
| LiveHive | `LiveGraph` / `Graph` |
| Bee | `node` / `Node` |
| Beeline | `edge` |
| `wake` | `trigger` |
| LiveHiveHost | `GraphHost` |
| hive structure | `CompositionDefinition` / `GraphDefinition` |

## Known limits

- `GET /catalog` exposes unloaded identity, but `GET /status` still only reports loaded graphs.
- Per-live lock covers load/trigger/answer; the multi-live `sweep` pass is not per-live locked (it relies on registry busy/refCount guards).
- Idle TTL has a daemon timer (default 60s, 0 disables), but `GraphStatus`/catalog API merging is still pending.
- Scheduler triggers pass an empty text Value because `TriggerDefinition` has no `input` field.
- Guard requests are exposed/decided by `requestId`; they are not RunStore records because `GuardRequest` has no `liveId`.
- RunStore has 1000-record / 1 MiB defaults and is used by trigger/answer.
- `fresh_once` mappings are schema v2 and require an exact `projectDirectory`; v1 mapping files are rejected, not migrated.
- A second loaded graph binding the same explicit session is rejected with 409 `session-busy`; there is no queue/forward yet. After the first unload, the second can load.
- Real mixed Codex+DSH `waxd`, scheduler, DSH guard, and DSH session-busy tests pass; full `npm run test:integration`, native partial-failure, and daemon restart-after-exit remain unverified.
- `ControlServer` (~1885) remains over Rule 11 budget; `GraphHost` is a 114-line facade now. M9f2 is next.
- OS SIGTERM graceful cleanup, Windows token ACL, and physical power-loss durability are not verified.

Local design documents live outside this repository in `../docs/`; they are not tracked here.
