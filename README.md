# WAX Apiary neXus

WAX Apiary neXus is a local coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into **LiveHive**s without reimplementing their session logic.

It is not a new agent runtime. Each harness stays native; WAX coordinates LiveHives, bees, sessions, work, waits, and persistence around it.

The code is a B-core prototype with a single daemon and one control endpoint.

## Target

```text
waxd
  ├─ AdapterPool            codex / dsh → one Workspace each
  ├─ SessionRegistry        global; session.harness decides the Workspace
  ├─ Harness prompt adapter  per-session admission, active execution, approval ownership
  ├─ LiveHiveService       new / load / wake / answer / guard / save / unload / migrate / dispatch
  │    └─ LiveHiveHost     internal execution engine for bees/beelines/PheromoneField
  └─ ControlServer          one local endpoint, one token
```

- **LiveHive is the first-class object.** A LiveHive has `bees`, `beelines`, `beeId -> sessionId` bindings, optional `schedules`, and a `PheromoneField`.
- **Bee is the execution slot.** A bee has a kind, config, outgoing beelines, optional RoleLabel, and a session mode.
- **Beeline is a connection.** Conditions choose outgoing beelines; fork/merge use branches.
- **`wake` is the execution verb.** `wake(liveId, beeId, input)` creates a Pheromone at the bee and pumps. A session-bound prompt is admitted by the WAX `DshAcpAdapter`, not by a second WAX session queue.
- **WAX is low priority.** If a user is using the session directly, a WAX prompt waits in adapter admission.
- **ACP owns approvals.** An ACP session is the sole owner of its approval channel; there is no unowned-approval pass-through and no GUI approval. ACP is automation-only: a GUI may list/resume a persisted session but cannot receive or answer its live approvals. A separate send-message ingress may be reserved, but it cannot decide approvals.
- **`dispatch` is an ephemeral one-bee LiveHive graph.** It runs once through the same admission/approval path, returns output, and is disposed; it is not a persistent LiveHive and does not write directly to a session.
- **Save and unload both write `live.json`.** Load makes memory authoritative; disk changes are ignored until the next save/unload.
- **No Agent/Revision/Definition/Actor objects.** To see what a bee runs, look at `beeId -> sessionId -> session.harness/model/reasoning`.
- **No `fork LiveHive` command.** Manually copying files is not prevented, but not supported.
- `LiveHiveHost`, `LiveHiveStatus` and `LiveHiveId` remain internal engine names. They are not public WAX objects and are not exposed by the HTTP or CLI surface.
- M17j is closed (2026-11-23): prompt admission lives in the WAX `DshAcpAdapter` (DSH source untouched); the legacy WAX `SessionExecutionQueue` and its `/queues` / `wax queue` surface were removed. `wax wake` returns the run result (or 409 `session-busy` for an adapter without a queue), never an admission handle. M17j3a approval pass-through was superseded by ACP full approval ownership and has been reverted.

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
GET  /sessions
POST /sessions/close
POST /sessions/sweep
GET  /health
```

The legacy graph routes, catalog route and legacy CLI commands are not present and have no forwarding aliases.

## Names

Public names are B names. Internal execution code still uses `LiveHiveHost`, `LiveHiveStatus`, `LiveHiveId` and `CompositionDefinition`; these are implementation details, not a second object model.

There is no Agent object, no Revision/Definition object, and no Actor object.

## Known limits

- B `schedules` have no `input` field; scheduled wakes use the existing empty text input.
- `unload` keeps the durable catalog and sessions; `inspect`/`output` do not refresh TTL.
- Per-live lock covers mutating operations; the multi-live sweep pass is not per-live locked (it relies on registry busy/refCount guards).
- `--harness` validates/filters; it does not select a per-harness daemon.
- Guard requests are not separate RunStore records; a guarded wake still produces one `trigger` run. The guard decision is part of that wake.
- Public status and run results do not expose the internal engine identity: a status is `rest`, `hovered`, `nodes`, optional `recovery`, and `residency`; a run result names the live as `liveId`. `graphId` and `graphRevision` never appear in HTTP or CLI output.
- RunStore has 1000-record / 1 MiB defaults and is used by wake/answer; an ephemeral dispatch graph also writes one run record (it has no LiveHive/catalog/Honey record).
- `fresh_once` mappings are schema v2 and require an exact `projectDirectory`; v1 mapping files are rejected, not migrated.
- Several loaded LiveHives may share one explicit session. A WAX prompt is admitted by the WAX `DshAcpAdapter`: one active execution per session, per-session FIFO, low priority relative to direct user use. `SessionOwnership` is ownership bookkeeping, not a mutex; it does not block sharing, and the adapter FIFO is the prompt gate. The queue is in memory only: a restarted daemon never replays pending work, and there is no public queue id to poll. `answer` is not queued; `dispatch` runs an ephemeral one-bee graph through the same admission path and is not persisted as a LiveHive. A non-queue adapter still rejects a second concurrent prompt with 409 `session-busy`.
- Real mixed Codex+DSH, scheduler, DSH guard, approval isolation, and the full B LiveHive chain have passing integration coverage. Native approval/cancel flake risk remains recorded; the original generic guard 500 was not reproduced by the deterministic test. OS SIGTERM cleanup, Windows token ACL, and physical power-loss durability remain unverified.
- WAX does not control direct Web/TUI prompts. ACP sessions are automation-only: ACP owns their approvals, and the GUI cannot receive or answer them. This is accepted behavior, not a pending GUI feature; there is no approval pass-through. A future send-message ingress is separate from approvals.
- Guard expiry is now explicit: a late decision returns 409 `guard-expired`; normal allow/reject/cancel still works.
- Guard allow/reject/cancel tests use a known marker to prove the side effect did or did not happen. They are guard/side-effect evidence, not Rule 9 unknown-answer evidence.
- `mixed-harness-product` and `session-registry-multi-harness` are adapter/session-level evidence, not graph/daemon cross-harness evidence. `waxd-mixed-harness` is the graph-level proof.
- `rg '/graphs|/catalog|wax graph|wax trigger' src README.md` is 0; `tests/` intentionally contains negative assertions for the removed surface, so a literal repo-wide zero is not the acceptance rule.
- Codex-dependent integration coverage needs a configured `CODEX_EXE` and Codex quota; when unavailable, the DSH-only integration suite is the fallback and Codex coverage is deferred rather than passed.

## Known conflicts and migration gaps

- **Approval ownership:** target is ACP full ownership (no unowned/pass-through). M17j3a's `promptSource` / `approvalPassThrough` code was reverted; the local DSH branch `m17j3-acp-ownership` is historical and the checkout is back at detached `9c2670d3bc`. Do not treat the branch as the target.
- **Admission ownership:** the WAX `DshAcpAdapter` is the only prompt-admission authority; DSH source is untouched. The legacy WAX `SessionExecutionQueue`, `QueuedRun`, `GET /queues/:queueId` and `wax queue status` are removed with no aliases. `DshAcpAdapter` advertises `queue: true`; `CodexAppServerAdapter` keeps the explicit 409 `session-busy` path. `wax wake` never returns a queued handle.
- **GUI conflict:** DSH/Codex GUI is a separate live owner. It can list/resume persisted sessions but cannot attach to a live ACP/app-server thread or receive its pending approval. Accepted resolution: ACP is automation-only; no GUI approval hook.
- **Verification gap:** M17j3a was tested only with fake ACP/DSH fixtures and was reverted. The M17j3 queue slice has unit/fake-ACP tests plus the real-DSH shared-session test; the full unit and integration suites were run after the queue change (see progress). Full-suite reruns after this docs-only correction are not needed for behavior.

Local design documents live outside this repository in `../docs/`; they are not tracked here.
