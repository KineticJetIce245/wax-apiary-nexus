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

The code is a B-core prototype with the M9c single-daemon shape; it does **not** yet implement the full target above.

- **M9a/M9b/M9c (uncommitted)** are wired together: one `AdapterPool`, one global `SessionRegistry`, one `GraphHost`, one `ControlServer`, one endpoint. A graph can mix Codex and DSH sessions.
- **M9b** added `LiveHiveCatalog`, per-live `LiveHiveLock`, a graph TTL timer, and `GET /catalog`; unloaded LiveHives keep their identity. `status` still reports loaded graphs only.
- `--harness` no longer selects a per-harness directory; it only validates/filter. `waxd --harnesses codex,dsh` uses one daemonDir/stateRoot/port/token.
- The current command surface is still `waxd`, `wax graph`, `wax trigger`, `wax session`; target names are `wax live` and `wax wake`.
- The regression suite is 712 tests (711 pass + 1 Windows skip after M9c; one DSH adapter timeout flake was observed earlier, then passed on targeted and full rerun). Real integration now includes a mixed Codex+DSH `waxd` graph through one HTTP endpoint and a DSH/Codex product check; the full `npm run test:integration` suite was not run as a whole.

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
- Per-live lock covers load/trigger/answer/drain; the multi-live `sweep` pass is not per-live locked (it relies on registry busy/refCount guards).
- Idle TTL has a daemon timer (default 60s, 0 disables), but `GraphStatus`/catalog API merging is still pending.
- The scheduler module is not instantiated; `triggers` parse but never fire.
- No Guard decision endpoint; `ControlServer` never passes `onGuard`, so native tool use is rejected by default.
- Output is the in-memory `lastOutput`; no `runId`/`requestId`, and unload makes it unreadable.
- Same session can be bound to two loaded graphs; the conflict is only detected on trigger.
- `fresh_once` compares `projectId` (directory basename), not the project directory.
- Real mixed Codex+DSH `waxd` test passes; full `npm run test:integration`, native partial-failure, and daemon restart-after-exit remain unverified.
- OS SIGTERM graceful cleanup, Windows token ACL, and physical power-loss durability are not verified.

Local design documents live outside this repository in `../docs/`; they are not tracked here.
