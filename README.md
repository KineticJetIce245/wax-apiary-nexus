# WAX Apiary neXus

WAX Apiary neXus is a local coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into **LiveHive**s without reimplementing their session logic.

It is not a new agent runtime. Each harness stays native; WAX coordinates LiveHives, bees, sessions, work, waits, and persistence around it.

The code is a B-core prototype with a single daemon and one control endpoint.

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

## Current commands

```text
waxd (--harness <codex|dsh> | --harnesses <codex,dsh>) [options]
wax live list|new <live.json>|load <liveId> [path]|instantiate <templateId> <liveId>|wake <liveId> <beeId>|answer <liveId> <beeId>|save <liveId>|unload <liveId>|migrate <liveId> <live.json>|inspect <liveId>
wax wake <liveId> <beeId> [--input <text>]
wax answer <liveId> <beeId> [--input <text>] [--token <hv_...>]
wax template compose <template.json>|list
wax dispatch --input <text>
wax guard list
wax guard decide <requestId> --decision allow_once|reject_once|cancelled
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
GET  /queues/:queueId
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
- `--harness` validates/filters; it does not select a per-harness daemon.
- Guard requests are not separate RunStore records; a guarded wake still produces one `trigger` run. The guard decision is part of that wake.
- Public status and run results do not expose the internal engine identity: a status is `rest`, `hovered`, `nodes`, optional `recovery`, and `residency`; a run result names the live as `liveId`. `graphId` and `graphRevision` never appear in HTTP or CLI output.
- RunStore has 1000-record / 1 MiB defaults and is used by wake/answer.
- `fresh_once` mappings are schema v2 and require an exact `projectDirectory`; v1 mapping files are rejected, not migrated.
- Several loaded LiveHives may share one explicit session. A wake that finds the session busy is queued FIFO (16 waiting per session, 5 min wait): the response carries `queueId` / `position`, and `GET /queues/:queueId` reports `queued|running|completed|failed|timeout|dropped` plus the `runId` once it starts. The queue is in memory only, so a restarted daemon answers 404 for old queue ids and never replays queued work. `answer` and `dispatch` are not queued; `wax live wake` prints the queued handle as JSON.
- Real mixed Codex+DSH, scheduler, DSH guard, shared-session queue, approval isolation, and the full B LiveHive chain have passing integration coverage. Native approval/cancel flake risk remains recorded; the original generic guard 500 was not reproduced by the deterministic test. OS SIGTERM cleanup, Windows token ACL, and physical power-loss durability remain unverified.
- Guard expiry is now explicit: a late decision returns 409 `guard-expired`; normal allow/reject/cancel still works.
- Guard allow/reject/cancel tests use a known marker to prove the side effect did or did not happen. They are guard/side-effect evidence, not Rule 9 unknown-answer evidence.
- `mixed-harness-product` and `session-registry-multi-harness` are adapter/session-level evidence, not graph/daemon cross-harness evidence. `waxd-mixed-harness` is the graph-level proof.
- `rg '/graphs|/catalog|wax graph|wax trigger' src README.md` is 0; `tests/` intentionally contains negative assertions for the removed surface, so a literal repo-wide zero is not the acceptance rule.
- Codex-dependent integration coverage needs a configured `CODEX_EXE` and Codex quota; when unavailable, the DSH-only integration suite is the fallback and Codex coverage is deferred rather than passed.

Local design documents live outside this repository in `../docs/`; they are not tracked here.
