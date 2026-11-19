# WAX Apiary neXus

WAX Apiary neXus is a local coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into **LiveHive**s without reimplementing their session logic.

It is not a new agent runtime. Each harness stays native; WAX coordinates LiveHives, bees, sessions, work, waits, and persistence around it.

## Target

```text
waxd
  ├─ AdapterPool            codex / dsh → one Workspace each
  ├─ SessionRegistry        global; session.harness decides the Workspace
  ├─ LiveHiveService       new / load / wake / answer / guard / save / unload / migrate / dispatch
  │    └─ GraphHost         internal execution engine for bees/beelines/PheromoneField
  └─ ControlServer          one local endpoint, one token
```

- **LiveHive is the first-class object.** A LiveHive has `bees`, `beelines`, `beeId -> sessionId` bindings, optional `schedules`, and a `PheromoneField`.
- **Bee is the execution slot.** A bee has a kind, config, outgoing beelines, optional RoleLabel, and a session mode.
- **Beeline is a connection.** Conditions choose outgoing beelines; fork/merge use branches.
- **`wake` is the execution verb.** `wake(liveId, beeId, input)` creates a Pheromone at the bee and pumps.
- **Save and unload both write `live.json`.** Load makes memory authoritative; disk changes are ignored until the next save/unload.
- **No Agent/Revision/Definition/Actor objects.** To see what a bee runs, look at `beeId -> sessionId -> session.harness/model/reasoning`.
- **No `fork LiveHive` command.** Manually copying files is not prevented, but not supported.
- `GraphHost`, `GraphStatus` and `GraphId` remain internal engine names. They are not public WAX objects and may be renamed later.

## Current status

The code is a B-core prototype with a single daemon and one control endpoint.

- **M9a–M9j** established the single daemon, global session registry, scheduler/guard/RunStore wiring, B object layer (`HiveTemplate`, `LiveHive`, bees/beelines/bindings), real Codex+DSH LiveHive chain, and session-ownership checks.
- **M10a** added `GET /lives`, `GET /lives/:id/output`, top-level `wax wake`/`wax answer`, `wax live list`, and a one-way composition importer.
- **M10b1** added B `schedules` (`Schedule`, at/every), mapped through the codec so the scheduler survives the surface cut.
- **M10b2** migrated surface coverage to `/lives` and B CLI, and fixed B unload/duplicate-load 409 mapping.
- **M10c (committed in `c6af169`)** removes the legacy graph control surface and client commands. The HTTP API, CLI, tests and client now expose only `/lives`, `/templates`, `/dispatch`, `/guards` and `/sessions`.
- **M10d (committed in `83b3d4c`)** adds final B-only surface assertions: legacy routes 404, removed graph/trigger CLI commands are usage errors, and the real Codex+DSH B chain stays green.
- **M10e (committed in `0e54524`)** closes review evidence gaps: dispatch session harness, guarded-wake RunStore record, two-live loaded/unloaded list, CLI save/load, POST legacy 404, and explicit evidence boundaries.
- **M11 (uncommitted)** makes guard expiry explicit: runtime expiry notifies the broker, late decisions return 409 `guard-expired`, and normal allow/reject/cancel is unchanged. The original generic 500 was not reproduced.
- `--harness` no longer selects a per-harness directory; it only validates/filters. `waxd --harnesses codex,dsh` uses one daemonDir/stateRoot/port/token.
- The regression suite is 722 tests (721 pass + 1 Windows skip). Full integration is currently deferred while Codex quota is restricted; `npm run test:integration:dsh` is 10/10.

## Current commands

```text
waxd (--harness <codex|dsh> | --harnesses <codex,dsh>) [options]
wax live list|new <live.json>|load <liveId> [path]|instantiate <templateId> <liveId>|wake <liveId> <beeId>|answer <liveId> <beeId>|save <liveId>|unload <liveId>|migrate <liveId> <live.json>|inspect <liveId>
wax wake <liveId> <beeId> [--input <text>]
wax answer <liveId> <beeId> [--input <text>] [--token <hv_...>]
wax template compose <template.json>|list
wax dispatch --input <text>
wax session list|close <sessionId>|sweep
```

`waxd` and the control API are the only host. One-shot/headless execution goes through `wax dispatch` or a LiveHive; there is no second host.

## HTTP surface

```text
POST /lives
POST /lives/load
POST /lives/instantiate
POST /lives/wake
POST /lives/answer
POST /lives/save
POST /lives/unload
POST /lives/migrate
GET  /lives
GET  /lives/:id/inspect
GET  /lives/:id/output
GET  /templates
POST /templates
POST /dispatch
GET  /guards
POST /guard/decide
GET  /sessions
POST /sessions/close
POST /sessions/sweep
GET  /health
```

The legacy graph routes, catalog route and legacy CLI commands are not present and have no forwarding aliases.

## Names

Public names are B names. Internal execution code still uses `GraphHost`, `GraphStatus`, `GraphId` and `CompositionDefinition`; these are implementation details, not a second object model.

There is no Agent object, no Revision/Definition object, and no Actor object.

## Known limits

- B `schedules` have no `input` field; scheduled wakes use the existing empty text input.
- `unload` keeps the durable catalog and sessions; `inspect`/`output` do not refresh TTL.
- Per-live lock covers mutating operations; the multi-live sweep pass is not per-live locked (it relies on registry busy/refCount guards).
- Guard requests are not separate RunStore records; a guarded wake still produces one `trigger` run. The guard decision is part of that wake.
- RunStore has 1000-record / 1 MiB defaults and is used by wake/answer.
- `fresh_once` mappings are schema v2 and require an exact `projectDirectory`; v1 mapping files are rejected, not migrated.
- A second LiveHive binding the same explicit session is rejected with 409 `session-busy`; there is no queue/forward yet. After the first unload, the second can load.
- Real mixed Codex+DSH, scheduler, DSH guard, DSH session-busy, and full B LiveHive chain pass; full integration was 22/22 before Codex quota deferral. Native approval/cancel flake risk remains recorded; the original generic guard 500 was not reproduced by the deterministic test. OS SIGTERM cleanup, Windows token ACL, and physical power-loss durability remain unverified.
- Guard expiry is now explicit: a late decision returns 409 `guard-expired`; normal allow/reject/cancel still works.
- Guard allow/reject/cancel tests use a known marker to prove the side effect did or did not happen. They are guard/side-effect evidence, not Rule 9 unknown-answer evidence.
- `mixed-harness-product` and `session-registry-multi-harness` are adapter/session-level evidence, not graph/daemon cross-harness evidence. `waxd-mixed-harness` is the graph-level proof.
- `rg '/graphs|/catalog|wax graph|wax trigger' src README.md` is 0; `tests/` intentionally contains negative assertions for the removed surface, so a literal repo-wide zero is not the acceptance rule.
- While the Codex quota is restricted, use `npm run test:integration:dsh` (10 DSH-only tests) instead of the full 22-test integration. Codex-dependent coverage is deferred, not passed.

Local design documents live outside this repository in `../docs/`; they are not tracked here.
