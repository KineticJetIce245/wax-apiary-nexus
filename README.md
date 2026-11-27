# WAX Apiary neXus

WAX Apiary neXus is a local coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into **LiveHive**s without reimplementing their session logic.

It is not a new agent runtime. Each harness stays native; WAX coordinates LiveHives, bees, sessions, work, waits, and persistence around it.

The code is a B prototype with a single daemon and one control endpoint. The M19 object model and B/public surface are implemented; real mixed Codex+DSH spread/gather evidence remains M19g.

## Target

```text
waxd
  ├─ AdapterPool            codex / dsh → one Workspace each
  ├─ SessionRegistry        global; session.harness decides the Workspace
  ├─ Harness prompt adapter  per-session admission, active execution, approval ownership
  ├─ LiveHiveService       new / load / trigger / answer / guard / save / unload / migrate / dispatch
  │    └─ LiveHiveHost     internal execution engine for bees/beelines/PheromoneField
  └─ ControlServer          one local endpoint, one token
```

## Objects and behavior

- **LiveHive is the first-class object.** A LiveHive has `bees`, `beelines`, `beeId -> sessionId` bindings, optional `schedules`, and a `PheromoneField`.
- **Value is a free JSON object.** `message` is the universal text field, `attachments` is the file convention, and every other field is arbitrary JSON. There is no `kind`/`structured` wrapper.
- **Pheromone is `{ value }`.** It has no id, timestamp or lineage. A receptor stores queue entries `{ value, enqueuedAt }`; the entry owns the TTL instant.
- **Bee is the execution slot.** A bee has a kind, config, `reads`/`writes`/optional `fallback`/optional `filter`, outgoing beelines, optional RoleLabel, and a session mode. `reads` must resolve; `writes` asserts required reply fields; `filter` removes unwanted reply fields before the write.
- **Beeline is a connection.** A condition beeline carries `when: "true" | "false"`. A normal edge has no outcome label. There is no spread/gather branch.
- **Spread is config-only.** `{ strategy: "clone", targets }` copies the value to ordered/list/map BeeId targets; `{ strategy: "cleave", targets: { BeeId: [dot paths] } }` projects each part. Spread creates no beelines, keeps no tracking, and writes no last output.
- **Gather is one receptor.** `strategy: "assemble"` (default) accumulates per-type queues until every type reaches `count`, then emits `{ type: [entries] }`; `groupBy` can key groups, and closed keyed groups keep tombstones. `strategy: "batch"` accumulates until one input matches `batch.signal`, consumes the signal, and flushes every declared type (empty arrays included). `typeQueueMax` defaults to 256. An unmatched/ambiguous type, missing path, full type queue or closed group is a typed drop.
- **`trigger` is delivery.** `trigger(liveId, beeId, input)` packages one Pheromone into the target bee's receptor and returns `202 {ok:true}`. `input` is a string (packaged as `{message}`) or a JSON object used as-is. There is no run id, no trace id and no result query; execution state is observed through `inspect`, output and logs. A session-bound prompt is admitted by the WAX `DshAcpAdapter`, not by a second WAX session queue.
- **`answer` is delivery too.** It binds a value to an existing user hover and returns `202 {ok:true}`; the field continues, the HTTP request ends. The same string-or-object input rule applies.
- **`dispatch` is an ephemeral one-bee graph.** It delivers the prompt through the same admission/approval path, returns `202 {ok:true}`, and never returns the model output or a run handle. The graph is released at silent end and is not persisted as a LiveHive. Dispatch input is also string-or-object.
- **Per-Bee drain.** Each awake Bee drives its own receptor; there is no field-wide pump and no `maxPumps`. `minIntervalMs` is a per-node pacing minimum. `settle(maxWaitMs?)` is an observation with a host wait bound, not an execution budget.
- **Output ownership.** The field keeps each Bee's last completed output in memory (any `Value`) until `unload`. Gather packages are outputs; condition/counter/spread are not. There is no run history store and no run-record directory. A durable result must be written by a downstream Bee.
- **No per-trace loop budget.** Loops are bounded by `counter`/`condition` and receptor overflow; every LiveHive must have a finite `queueMax`.
- **`receptor`, not mailbox.** A Bee's waiting list is its receptor; overflow errors are `bee-receptor-full` and `bee-receptor-block-timeout`. `queueMax` is the receptor capacity.
- **WAX is low priority.** If a user is using the session directly, a WAX prompt waits in adapter admission.
- **ACP owns approvals.** An ACP session is the sole owner of its approval channel; there is no unowned-approval pass-through and no GUI approval. ACP is automation-only: a GUI may list/resume a persisted session but cannot receive or answer its live approvals. A separate send-message ingress may be reserved, but it cannot decide approvals.
- **Save and unload both write `live.json`.** Load makes memory authoritative; disk changes are ignored until the next save/unload. `unload` snapshots and releases immediately; a running native execution is detached and its late result reloads the field as the same activation.
- **Old Honey is not migrated.** A schema-1/legacy `honey/field.json` fails load with **409 `honey-incompatible`**; WAX keeps the old state and never silently deletes it.
- **No Agent/Revision/Definition/Actor objects.** To see what a bee runs, look at `beeId -> sessionId -> session.harness/model/reasoning`.
- **No LiveHive copy command.** Manually copying files is not prevented, but not supported.
- `LiveHiveHost`, `LiveHiveStatus` and `LiveHiveId` remain internal engine names. They are not public WAX objects and are not exposed by the HTTP or CLI surface.
- M17j/M18 closeout (2026-11-23/25): prompt admission lives in the WAX `DshAcpAdapter`; the execution registry, run routes/records and per-trace budgets were removed; `wake` became `trigger`, mailbox became receptor. M19 (2026-11-26) replaced the value model, spread representation, gather and drain with the shape above. There are no aliases.

## Current commands

```text
waxd (--harness <codex|dsh> | --harnesses <codex,dsh>) [options]
wax live list|new <live.json>|load <liveId> [path]|instantiate <templateId> <liveId>|save <liveId>|unload <liveId>|migrate <liveId> <live.json>|inspect <liveId>
wax trigger <liveId> <beeId> [--input <text> | --input-json <json> | --input-file <path>]
wax answer <liveId> <beeId> [--input <text> | --input-json <json> | --input-file <path>] [--token <hv_...>]
wax template compose <template.json>|list
wax dispatch [<input> | --input <text> | --input-json <json> | --input-file <path>] [--harness <codex|dsh>] [--session <sessionId>]
wax guard list
wax guard decide <requestId> --decision allow_once|reject_once|cancelled
wax session list|close <sessionId>|sweep
```

- `--input` is the existing string input, packaged as `{message}`.
- `--input-json` and `--input-file` send one JSON object as the Value as-is. They are mutually exclusive and cannot be combined with `--input` (or, for `wax dispatch`, a positional input). A non-object JSON root or invalid JSON exits 2.
- `wax dispatch` keeps its old string precedence: `--input` wins over the positional input.
- `wax live inspect <liveId> --json` prints the raw inspect response; its `outputs[].value` is the free JSON Value, not a text-only record.
- `waxd` and the control API are the only host. One-shot/headless execution goes through `wax dispatch` or a LiveHive; there is no second host. A removed command (`wax wake`, `wax live wake`, `wax queue`, ...) is a usage error with exit 2 and has no alias.

## HTTP surface

```text
POST /lives
POST /lives/load
POST /lives/instantiate
POST /lives/trigger
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

`POST /lives/trigger`, `POST /lives/answer` and `POST /dispatch` answer **202 `{ok:true}`** and return no output or per-request id. Their `input` is a string or a JSON object used as the Value as-is. `GET /lives/:id/output` reads the field-owned last output per Bee and takes no run identifier; after `unload` it is 404. A legacy Honey snapshot returns 409 `honey-incompatible` without an absolute path. There is no per-request query route. The legacy graph routes, catalog route and legacy CLI commands are not present and have no forwarding aliases.

## Names

Public names are B names. Internal execution code still uses `LiveHiveHost`, `LiveHiveStatus`, `LiveHiveId` and `CompositionDefinition`; these are implementation details, not a second object model.

There is no Agent object, no Revision/Definition object, and no Actor object.

## Known limits

- Real mixed Codex+DSH spread/gather integration is **not yet verified for M19**; that is M19g. Earlier M18 mixed-harness evidence does not cover the M19 spread/gather shape.
- B `schedules` have no `input` field; scheduled deliveries use `{ message: "" }`.
- `unload` keeps the durable catalog and sessions; it snapshots and releases immediately. `inspect`/`output` do not refresh TTL. The per-Bee last output is memory-only and is released by `unload`.
- `answer` can return 429 `bee-receptor-full` when the downstream receptor cannot accept the value; the hover is not consumed and remains answerable.
- Per-live lock covers mutating operations; the multi-live sweep pass is not per-live locked (it relies on registry busy/refCount guards).
- `--harness` validates/filters; it does not select a per-harness daemon.
- Guard requests are not run records. A guarded delivery leaves the field active until the guard is decided; the guard decision is not part of any run history.
- Public status and outputs do not expose the internal engine identity: a status is `rest`, `hovered`, `nodes` (including a `gathers` count), optional `recovery`, and `residency`; outputs name the live as `liveId`. `graphId` and `graphRevision` never appear in HTTP or CLI output.
- Honey layout is still `apiaries/<apiary>/compositions/<liveId>/honey/...`, while ARCHITECTURE §5 specifies `lives/<liveId>/honey/...`. That is the remaining A23/C05 persistence-layout gap; `live.json` already lives under `lives/<liveId>/`. Until it is migrated, the daemon neither creates nor reads a run-record directory.
- Existing user state roots may still contain an old run-record directory or an old Honey snapshot from pre-M19 builds. The current code does not read a run-record directory, and an old Honey snapshot fails closed with 409 `honey-incompatible`; removing either is an explicit owner action.
- `fresh_once` mappings are schema v2 and require an exact `projectDirectory`; v1 mapping files are rejected, not migrated.
- Several loaded LiveHives may share one explicit session. A WAX prompt is admitted by the WAX `DshAcpAdapter`: one active execution per session, per-session FIFO, low priority relative to direct user use. `SessionOwnership` is ownership bookkeeping, not a mutex; it does not block sharing, and the adapter FIFO is the prompt gate. The queue is in memory only: a restarted daemon never replays pending work, and there is no public queue id to poll. `answer` is not queued; `dispatch` runs an ephemeral one-bee graph through the same admission path and is not persisted as a LiveHive. A non-queue adapter still rejects a second concurrent prompt with 409 `session-busy`.
- Loop safety relies on `counter`/`condition` plus receptor overflow; there is no per-trace `maxHops`/`maxDuration`. A composition should set a finite `queueMax`.
- Real mixed M18 integration had passing coverage before the M19 model change, plus recorded model-format flakes. Do not treat that older evidence as M19 real integration.
- Full unit runs under load can show timing flakes: a guard-race/CLI guard-expiry wait, or a 100 ms Codex/DSH adapter timeout (`codex-adapter-resilience`, `dsh-acp-adapter`). The affected file passes alone. These use real timers and are recorded as test-timing flakes, not product regressions.
- WAX does not control direct Web/TUI prompts. ACP sessions are automation-only: ACP owns their approvals, and the GUI cannot receive or answer them. This is accepted behavior, not a pending GUI feature; there is no approval pass-through. A future send-message ingress is separate from approvals.
- Guard expiry is explicit: a late decision returns 409 `guard-expired`; deciding an already settled request returns 409 `conflict`. Normal allow/reject/cancel still works.
- Guard allow/reject/cancel tests use a known marker to prove the side effect did or did not happen. They are guard/side-effect evidence, not Rule 9 unknown-answer evidence.
- `mixed-harness-product` and `session-registry-multi-harness` are adapter/session-level evidence, not graph/daemon cross-harness evidence. `waxd-mixed-harness` is graph-level evidence for the older M18 model, not for M19 spread/gather.
- Codex-dependent integration coverage needs a configured `CODEX_EXE` and Codex quota; when unavailable, the DSH-only integration suite is the fallback and Codex coverage is deferred rather than passed.

## Known conflicts and migration gaps

- **Approval ownership:** target is ACP full ownership (no unowned/pass-through). M17j3a's `promptSource` / `approvalPassThrough` code was reverted; the local DSH branch `m17j3-acp-ownership` is historical and the checkout is back at detached `9c2670d3bc`. Do not treat the branch as the target.
- **Admission ownership:** the WAX `DshAcpAdapter` is the only prompt-admission authority; DSH source is untouched. The legacy WAX `SessionExecutionQueue`, `QueuedRun`, `GET /queues/:queueId` and `wax queue status` are removed with no aliases. `DshAcpAdapter` advertises `queue: true`; `CodexAppServerAdapter` keeps the explicit 409 `session-busy` path. A delivery never returns a queued handle.
- **GUI conflict:** DSH/Codex GUI is a separate live owner. It can list/resume persisted sessions but cannot attach to a live ACP/app-server thread or receive its pending approval. Accepted resolution: ACP is automation-only; no GUI approval hook.
- **Persistence layout:** the Honey path mismatch (A23/C05) is a separate slice with a migration decision; do not treat the current path as the target and do not silently delete old state.

Local design documents live outside this repository in `../docs/`; they are not tracked here.
