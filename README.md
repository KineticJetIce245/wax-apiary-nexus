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

The code is a B-core prototype with the M9c single-daemon shape, M9d scheduler/guard/run wiring, M9e session-ownership checks, and the M9f1/M9f2 host/control splits; it does **not** yet implement the full target above.

- **M9a/M9b/M9c (committed in `3eb24b0`)** are wired together: one `AdapterPool`, one global `SessionRegistry`, one `GraphHost`, one `ControlServer`, one endpoint. A graph can mix Codex and DSH sessions.
- **M9b** added `LiveHiveCatalog`, per-live `LiveHiveLock`, a graph TTL timer, and `GET /catalog`; unloaded LiveHives keep their identity. `status` still reports loaded graphs only.
- **M9d (committed in `425fcdc`)** added the per-LiveHive scheduler, `GET /guards` + `POST /guard/decide`, and durable `RunStore` output (`runId`/`requestId`, readable after unload).
- **M9e (committed in `a5be496`)** makes `fresh_once` reuse depend on harness + projectDirectory, and rejects a second loaded graph that binds the same explicit session with HTTP 409 `session-busy`.
- **M9f1 (committed in `ba567ad`)** splits `GraphHost` into a 114-line facade plus lifecycle/execution/read/session-ownership services, and deletes the dead `drain`/`firstHover`/`lastOutputs` APIs.
- **M9f2 (committed in `a4883cd`)** splits `ControlServer` into a 55-line facade plus lifecycle/HTTP/routes/validation/context services; no behavior change.
- **M9g (committed in `7fa3db7`)** removes the unused revision module and Honey log/transcript methods; test files are now all ≤800.
- **M9h (committed in `eda0df6`)** adds the B object layer under `src/b/`: HiveTemplate, LiveHive (`live.json` keyed by beeId), Bee/Beeline/BeeBinding, codec to CompositionDefinition, and DispatchService.
- **M9i (committed in `1eed44e`)** adds live/template/dispatch HTTP routes and CLI, `LiveHiveService`, and `GraphHost.save`; existing `/graphs` remains.
- **M9j (committed in `fbcbe53`)** adds the real Codex+DSH LiveHive acceptance chain (template → instantiate → wake → save → unload → load → migrate → dispatch) and persists created session IDs into `live.json` bindings.
- **M10a (uncommitted)** adds `GET /lives`, `GET /lives/:id/output`, top-level `wax wake`/`wax answer`, `wax live list`, and a one-way composition importer. Old `/graphs`/`wax graph`/`wax trigger` remain until M10b/M10c.
- **Review fixes (committed in `463682c`, `cbbc6ac`)** hardened real evidence: DSH recall product test, adapter prompt routing, host guard reject/cancel, partial-start/restart, guard HTTP negatives, reload-then-run, explicit timeouts, and test-file splits.
- `--harness` no longer selects a per-harness directory; it only validates/filter. `waxd --harnesses codex,dsh` uses one daemonDir/stateRoot/port/token.
- The current command surface is still `waxd`, `wax graph`, `wax trigger`, `wax session`; target names are `wax live` and `wax wake`.
- The regression suite is 766 tests (765 pass + 1 Windows skip after M10a). **Full `npm run test:integration` passes 22/22 with 0 skip**; all test files are ≤800 lines. The real B chain covers template/instantiate/wake/save/unload/load/migrate/dispatch with real Codex+DSH.

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
- Real mixed Codex+DSH, scheduler, DSH guard, DSH session-busy, and full B LiveHive chain pass; full integration is 22/22. Native approval/cancel flake risk remains recorded; OS SIGTERM cleanup, Windows token ACL, and physical power-loss durability remain unverified.

Local design documents live outside this repository in `../docs/`; they are not tracked here.
