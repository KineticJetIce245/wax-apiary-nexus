# WAX Apiary neXus — Architecture

Status: **target architecture**. The delivery-only closeout (2026-11-25) is implemented: the control plane is delivery-only, ordinary beelines move the same Pheromone, the field owns the per-Bee last output, and the old execution-registry surface is gone. The target object model (2026-11-26) changes `Value` to a free JSON object and `Pheromone` to `{ value }` (no id/at/lineage); spread/gather use BeeId and value fields. The code still implements the earlier model until these slices land; §4.11
states the target no-identity rule; §4.12–§4.13 are the target, and §4.14 is an
open draft. The Honey directory layout (A23/C05, §5/§8) remains a separate known gap.

## 1. One sentence

A **LiveHive** is a loaded graph of **bees** connected by **beelines**; the **PheromoneField** owns all execution state, and the control plane only delivers messages into that field.

## 2. Layers

```text
L4  Control / CLI        ControlServer / ControlClient / wax (delivery only)
L3  LiveHive host        LiveHiveService / LiveHiveHost / LiveHiveCatalog / LiveHiveLock
L2  Session              SessionRegistry / AdapterPool / Workspace
L1  Adapter              CodexAdapter / DshAcpAdapter + adapter-owned prompt admission
L0  Native harness       Codex app-server / DSH ACP server
```

Dependency direction is upward only: L3 may call L2/L1; L2 does not know the control layer; L1 does not know LiveHive.

The control plane has no execution registry. It validates a request, hands it to a Bee/field, returns a delivery acknowledgement, and forgets it.

## 3. Core objects

| Object | Meaning |
| --- | --- |
| `LiveHive` | First-class runtime object: `bees`, `beelines`, `beeId -> sessionId` bindings, `PheromoneField`, scheduler/log, lifecycle |
| `Bee` | Execution slot and execution owner: `beeId`, kind, config (`reads`/`writes`/`fallback` in the target model), outgoing beelines, optional RoleLabel, sessionMode |
| `Value` | Free JSON object carried by a Pheromone: `message` is universal, `attachments` is the file convention, other fields are arbitrary; no `kind`/`structured` wrapper |
| `Spread` | Control Bee: `clone` or `cleave`; targets are BeeIds; no branchId/lineage |
| `Gather` | Control Bee: one receptor, `assemble` per-type queues; no branchId/lineage |
| `Beeline` | Directed connection between bees: `beelineId`, `fromBee`, `toBee`, optional condition outcome |
| `BeeBinding` | `{ beeId, sessionId }` for bees that need a native session |
| `Session` | Native session record: `sessionId`, harness, model, reasoning, params |
| `HiveTemplate` | Optional saved graph + per-bee default session params; not required to create a LiveHive |
| `Schedule` | Optional saved trigger on a LiveHive: target bee and `at`/`every`; not an execution identity |
| `RoleLabel` | Comment/label on a bee; not an instance, not a route |
| `Pheromone` | `{ value }` only; no id/at/lineage; the field's queue entry owns `enqueuedAt` |
| `PheromoneField` | The single owner of runtime state: queue entries, pending, active, hover, assemble groups/tombstones, outputs |
| `Dispatch` | A temporary Bee started for one prompt; it lives until the tool returns, then either flows to its next Bee or silently ends |

There is no Agent object, no Revision/Definition object, no Actor object, and no control-plane Run/Wake/Trace object. (The internal engine name `CompositionDefinition` is not a second object model; see §7.)

A Bee's last completed output is a field-owned, memory-only cache (see §4.10); it is not a run record and has no run/wake/trace identity.

## 4. Delivery flows

### 4.1 trigger (the only entry point)

Only `trigger` packages external information into a Pheromone.

```text
POST /lives/trigger
  { liveId, beeId, input }
        |
        v
ControlServer
  -> LiveHiveService
  -> validate live, bee, input
  -> create one Pheromone P { value }
  -> append a queue entry { value, enqueuedAt } to the entry Bee's receptor
  -> wake(entry Bee) as a signal
  -> 202 { ok: true }
        |
        v
trigger request ends; no id, record, callback or query remains
```

The receptor append is the handoff point. If the receptor is full:

- `reject`: return `429 bee-receptor-full`; no Pheromone enters the field;
- `block`: wait outside the field lock, then append and return 202, or return `429 bee-receptor-block-timeout`.

`trigger` does not wait for the Bee to execute. It does not observe the
Pheromone after handoff.

`wake(bee)` is not an HTTP operation and creates no object. It is a signal that
the Bee's receptor has work; it has no id, payload, lifecycle or record. It is
sent by `trigger`, by `answer`, and whenever a Pheromone is moved into a
receptor.

### 4.2 wake signal and receptor drain

Each Bee owns one receptor and one active slot.

```text
P is active at Bee A
  -> Bee A executes P
  -> Bee A merges its output into P.value (§4.12; default deep merge)
  -> the SAME P is placed in Bee B's receptor
  -> wake(Bee B)
  -> P becomes active at Bee B
```

A normal beeline moves the same Pheromone object; it does not create a new one
and assigns no id. The Bee's output is merged into `value` per §4.12 (default
deep merge; arrays and scalars replace). Only two graph operations change
cardinality:

- `spread`: one value becomes N values (`clone` or `cleave`);
- `gather`: N values become one assembled value.

Those are cardinality changes, not the normal edge flow. An implementation that
allocates a new Pheromone for every beeline or every Bee is nonconformant; an
implementation that adds ids or lineage to compensate is also nonconformant.

A receptor stores queue entries `{ value, enqueuedAt }`; the Pheromone itself is
only `{ value }`. `ligand` is not a layer in this architecture; only if a future
storage representation cannot hold a value may an adapter-local ligand wrapper be
used inside that representation, never as a control-plane concept.

Receptor drain:

```text
receptor[P0, P1, ...]
  -> P0 becomes pending when pacing/minInterval requires it
  -> P0 becomes active
  -> Bee executes P0
  -> P0 moves to the next receptor, or becomes a terminal field output
  -> next receptor entry, or rest
```

- Receptor order is FIFO; one Pheromone is active per Bee.
- `pending` is a pacing slot for the head of the receptor, not a second queue.
- A Bee with no outgoing beeline is terminal; its Pheromone is a field output.
- A loop is a moved Pheromone whose target is the same or another Bee; it
  re-enters that Bee's receptor. There is no per-trigger loop budget;
  `counter`/`condition` and receptor overflow bound the loop.

### 4.3 answer

A `user` Bee pauses instead of producing an output:

```text
active Pheromone
  -> hover { token, prompt }
  -> wait for a value
```

```text
POST /lives/answer
  { liveId, beeId, input, token }
        |
        v
validate Bee is hovering with this token
  -> bind the value to the hovered Pheromone
  -> clear hover
  -> wake(Bee) as a signal
  -> 202 { ok: true }
        |
        v
answer request ends; no run, no result, no handle
```

`answer` does not create a Pheromone and does not create a second execution
chain. It updates the already-hovered Pheromone; the same Bee then continues,
merges its output into its value per §4.12 and moves it along its beeline.

If the downstream receptor cannot accept the answered value, the answer is
refused with the receptor overflow error (`429 bee-receptor-full`, or the block
timeout) before the hover is consumed; the hover remains open and answerable.

### 4.4 dispatch

```text
POST /dispatch
  { prompt }
        |
        v
create a temporary Bee
  -> trigger its prompt into the temporary Bee's receptor
  -> wake(temporary Bee)
  -> 202 { ok: true }
        |
        v
dispatch request ends
```

Temporary Bee:

```text
active prompt
  -> tool/native session
  -> tool returns
     -> outgoing beeline exists: move the SAME Pheromone to the next Bee
     -> no outgoing beeline: silent end, release temporary Bee
```

`dispatch` never returns the output and never persists a run/wake record. A
caller that needs the result must compose a graph whose next Bee consumes it;
the result is graph data, not an RPC return value.

### 4.5 Pheromone lifetime

| Phase | Owner | What happens | Released when |
| --- | --- | --- | --- |
| Created | `trigger`, `spread` or `gather` | external input is packaged, or cardinality changes | never by the control plane; it owns no reference |
| Receptor | Bee/field | waits in FIFO order | dequeued, dropped by overflow, or unloaded with snapshot |
| Pending | Bee/field | pacing delay before activation | activated or expired |
| Active | Bee/field | exactly one per Bee; executing | execution ends or is marked unknown on unload |
| Moved | producing Bee | the SAME Pheromone is placed in the next receptor; its value is updated per §4.12 | consumed by the target Bee |
| Terminal | field | no outgoing beeline; field output | live unload/replacement; not a per-run record |

A Pheromone has no message identity: no id, no run/wake/trace id, no lineage.
A normal beeline moves the same object; `spread` creates new values and `gather`
creates one new value because the cardinality changes. The field's queue entry,
not the Pheromone, owns `enqueuedAt`.

### 4.6 Bee lifetime

| Phase | State | Persistence |
| --- | --- | --- |
| Loaded/rest | no receptor or empty receptor; no active | live.json |
| Awake | receptor exists; drain active | field.json includes non-empty receptor |
| Active | one active Pheromone | field.json active marker; on reload becomes unknown |
| Hover | user Bee parked with token | field.json hover + hover Pheromone |
| Rest | no active/pending/receptor/hover/open assemble group | field.json |

A Bee is not created or destroyed per trigger. It is a loaded graph node. The temporary Bee from `dispatch` is the exception: it exists only for that dispatch and is released at silent end.

In the target model, a Bee definition declares `reads`/`writes`/`fallback`; built-in
kinds have defaults and an instance may override them. A missing read field is an
error unless a fallback is configured. Plugin-defined Bee kinds are a later slice
(§4.12).

### 4.7 Field lifetime

```text
load
  -> memory authoritative
  -> trigger/answer/dispatch deliveries
  -> active/pending/receptor/hover/assemble
  -> field outputs
  -> save: snapshot to honey/field.json
  -> unload: write snapshot, release field/runtime, keep sessions
  -> load again: restore receptor/pending/hover; active becomes unknown, never replay
```

`Rest` means no active/pending/receptor/hover/incomplete assemble group remains. It is an observation of the field, not a delivery completion signal. A delivery has already ended at handoff, long before Rest.

### 4.8 Native session and prompt admission

The WAX `DshAcpAdapter` owns a per-session FIFO queue for WAX-originated
prompts; the DSH source is untouched and its native one-prompt rule is honored
by this adapter queue:

```text
Bee wants prompt -> WAX DshAcpAdapter admission -> native session
                    (pending / active / terminal)
```

- One native session has at most one WAX execution at a time; different sessions may run in parallel. WAX is low priority: if a user is already using the session, the WAX request waits.
- Pending is adapter admission state, not a Bee hover and not a Pheromone queue.
- The adapter registers an execution context (WAX executionId, liveId, beeId, sessionId, nativeSessionId) before sending and keeps it until terminal. That executionId is adapter-local correlation, not a public run/wake identity.
- The ACP session is the sole owner of its approval channel. Every approval produced by an ACP session is handled by the ACP client/WAX; there is no unowned-approval handoff and no pass-through to a GUI/native handler.
- ACP is automation-only. A DSH/Codex GUI may list or resume a persisted session, but it is a different live owner: it does not receive the ACP session's pending approvals and cannot answer them.
- A separate **send-message ingress** may exist for submitting a new message to an ACP session. It only enqueues/sends a message; it is not an approval channel and cannot decide or cancel approvals.
- Direct Web/TUI prompts bypass the adapter. Admission priority is best-effort: WAX does not start while the session is visibly busy; once a WAX turn is running, user steer/preemption needs the reserved steer path.
- `wax answer` is a graph/user-hover delivery, not an admission queue. `wax guard` covers ACP/WAX-owned approvals.
- `dispatch` uses the same admission/approval path for its temporary Bee; it does not write directly to a session and does not persist as a LiveHive.

### 4.9 Failure and release

- A Bee execution failure clears `active`, logs the failure, and releases that value. It never replays the side-effecting work.
- A receptor overflow rejection does not enqueue the new queue entry. Current
  code throws/returns `ReceptorFullError` (`trigger`/`answer` map it to 429) or
  defers an internal move through pre-consumption reservation; `waxd` does not
  exit on receptor full. The target block/reject/logged-drop policy is open
  (§4.14).
- Unload persists receptor queue entries/pending/hover/assemble groups and marks active as unknown; reload never replays active work.
- A spread emission checks target existence and part/target matching only; target acceptance is the target Bee's responsibility. After emission it keeps no tracking/cancel state; partial fan-out is possible.
- Target-full/rejection (receptor or per-type queue) is an error-handling concern: the exact block/reject/logged-drop policy is open in §4.14. No silent loss is allowed.
- A process crash follows the same rule: Honey is the snapshot; active is unknown; no automatic retry.
- A terminal Bee output stays in the field as an output until live unload/replacement. It is not a per-delivery record.
- A temporary dispatch Bee is released at silent end; its field is ephemeral and not persisted as a LiveHive.

### 4.10 Ownership

```text
control plane  -> may deliver; must not own execution state
Bee/field      -> own execution state
Honey          -> owns durable snapshots of field state
```

Consequences:

- No execution tracker, per-request registry or shadow lifecycle.
- No control-plane run/request id, span or per-request status.
- There is no run-history query route; there is nothing to query after delivery.
- No run-record directory on disk.
- The only observable execution state is the LiveHive/field: `inspect`, output, receptor/pending/active/hover/open assemble group and logs.
- If a caller wants a result, the result is an edge to another Bee, not a control-plane return value.
- Output ownership: the field keeps a memory-only last output per Bee
  (a `Value`; message/attachments/arbitrary fields; no binary). It is overwritten
  by the Bee's next successful activation, released on `unload`, and never
  written to Honey. There is no durable run-history store and no `runs/`
  directory; reliable viewing requires a downstream Bee to write a file.

### 4.11 No message identity

The target model removes `Pheromone.id` entirely. A Pheromone is `{ value }`; the
field moves that object by reference and keeps no id, no lineage, no registry,
no cursor and no public handle. The earlier rule that a field-local id must not
be used as a runId is historical; the stronger rule is that no message identity
exists at all. See §4.12.

### 4.12 Value, Pheromone, and Bee I/O

The target model:

- **Value** is a free JSON object. `message` is the universal text field;
  `attachments` is the file convention (`{ path: string; mediaType?: string }`);
  other fields
  are arbitrary JSON. There is no `kind` tag and no `structured` wrapper.
  `mediaType` is not an enum; a recommended list is documentation only.
  Image/audio are inferred from the `mediaType` prefix, otherwise the attachment
  is a file.
- **Pheromone** is `{ value }`. It has no id, `at`, `spreadId`, `branchId` or
  `lineage`. A normal beeline moves the same object; `spread` creates new values;
  `gather` creates a new value. The field's queue entry
  `{ value, enqueuedAt }` owns the TTL timestamp; `pending`/`active` need no time.
- **Bee definition**: `reads`, optional `writes`, optional `fallback`. Built-in
  kinds have defaults; an instance may override them. A read path resolves
  against the value; a missing path is an error unless a fallback is set. A plugin
  may define a new Bee kind later, using the same definition contract.
- **Writes**: default is deep merge. Objects merge recursively; arrays replace;
  scalars replace. A result may carry a separate `drop` list of paths; a value and
  a drop on the same path is an error. `writes` is an optional output
  filter/allowlist: without it a Bee may return arbitrary fields; when configured,
  output outside the filter is rejected with a typed error/log (never silently
  trimmed). The filter form (path list vs pure predicate) is still open. A plain
  `null` remains a normal value.
- **Paths**: simple dot paths (`message`, `attachments`, `meta.topic`), with pure
  functions as an escape hatch; no JSONPath. Type matching supports both
  path+expected value and a pure `typeOf` function.

### 4.13 Spread and gather

- **Spread** is stateless fan-out. `clone` copies the whole value to every target
  Bee; `cleave` splits it by fields/rules and maps the parts to target BeeIds.
  Targets are BeeIds (a map or an ordered list; map preferred). The spread checks
  only that the targets exist and that parts match targets; it does not reserve
  or inspect target capacity. Whether a target accepts is the target Bee's
  responsibility. After emission the spread forgets the copies: no tracking, no
  cancellation, no rollback. Partial fan-out is possible; a gather that never
  receives a missing part has no defined recovery yet — its timeout/failure
  policy is open (§4.14 item 6).
- **Gather** is a Bee with one receptor. It is the fan-in point; `pool` is not a
  separate strategy because a Bee receptor is already fan-in. `assemble` uses one
  input receptor plus internal per-type queues. A type has a matcher and a
  `count`; a package is `type -> array` of the fields named by `reads` from each
  collected input. With one read field the array holds scalars; with multiple
  read fields each element is an object keyed by the read fields. Required types
  wait. Groups are FIFO by default, or by a field/pure key; a missing key is an
  error. A completed group emits one package; at most one package per pump (a
  host driver pass). A closed group keeps a tombstone: a marker that the group
  completed or timed out and must not be reopened.
  Target-full behavior is part of error handling (§4.14); no default is assumed
  here. `batch` (time window) is not part of this target slice.
- There is no spreadId/branchId/lineage and no message identity. Condition
  true/false outcomes remain graph edge labels, separate from spread targets.

### 4.14 Error handling and extreme recovery (open)

Status: **draft, not implemented**. The owner is designing a freeze system; this
section is intentionally incomplete. Current behavior remains §4.9. Do not treat
these notes as a finished contract.

Open questions recorded so far:

- **Target full / freeze.** Current code: `trigger`/`answer` receptor full maps to
  429; internal moves/spreads use pre-consumption reservation and defer/pause when
  the target is full; `waxd` does not exit. For the target assemble per-type
  queues, the target Bee's policy (block, typed rejection, or logged drop) is
  part of this error-handling design and is not defined yet. Until freeze exists,
  the temporary policy is error + drop (§9). `trigger` has the 429 path; internal
  moves/spreads have no HTTP response, so the target policy must be explicit.
- **Unimplemented target paths (temporary error + drop).** For paths with no
  implementation yet (assemble per-type queue overflow, freeze), report a typed
  error, log it, and drop that item/operation; do not block, retry, or replay.
  `waxd` continues. Replace this with the freeze design later; do not exit the
  process.
- **Spread target acceptance.** A spread only checks that every split value/copy
  has a corresponding target Bee. Whether the target accepts (queue full, busy,
  failure) is the target Bee's responsibility; the spread is fire-and-forget and
  keeps no tracking/cancel state. Partial fan-out is therefore possible; the
  gather timeout/failure policy for a missing part is open (§4.14 item 6).

To be filled when the owner defines the freeze system:

1. Backpressure/freeze: queue full, freeze/resume, timeout, fairness.
2. Process stop: Ctrl+C, SIGTERM, SIGKILL.
3. Power loss and disk: atomic writes, multi-file consistency, corruption.
4. Native harness: child exit/orphan, session busy/unknown.
5. Field recovery: unknown active, open assemble groups, no replay.
6. Partial fan-out and gather timeout.
7. Observability: typed errors, logs, inspect.

Rules that already hold: no unrecorded loss; no automatic replay of side-effecting
work; fail closed when state is uncertain.

## 5. Persistence

```text
<stateRoot>/
  waxd/
    sessions.json
    live-catalog.json
    graph-bindings.json
  templates/<templateId>.json
  lives/<liveId>/
    live.json
    honey/field.json
    honey/scheduler.json
```

- `live.json` is keyed by `beeId` for `bees` and `bindings`; `beelines` are keyed by `beelineId`.
- `honey/field.json` is the durable field snapshot: receptor queue entries
  `{ value, enqueuedAt }`, active/pending/hover markers, and assemble
  groups/tombstones. It contains no Pheromone id/lineage.
- `sessions.json` is global; each session record carries its harness.
- There is no `runs/` directory and no per-wake/per-run record.
- The field's per-Bee last output is memory-only; it is not written to
  `field.json`. Durable results are files written by a downstream Bee.
- Adapter prompt admission/pending is memory-only; no replay after restart. A dispatch Bee is temporary and is not persisted as a LiveHive.
- No revision file; a content hash may be added later for audit only.

## 6. Concurrency and failure

- One `waxd` process, one state root, one ControlServer.
- One AdapterPool; each harness has one Workspace. A failed harness is marked `unavailable` and does not block the daemon.
- `LiveHiveLock` covers mutating host operations per LiveHive; delivery is short and must not hold the lock across native execution. Different LiveHives may run in parallel.
- Each Bee has one receptor and one active Pheromone; same-Bee work is FIFO/serial, different Bees may overlap. `queueMax` overflow is `reject` (429 `bee-receptor-full`) or `block` (429 `bee-receptor-block-timeout` after the configured wait); block waits outside the field lock.
- One session has at most one active execution. Sharing a session across LiveHives is serialized by the WAX `DshAcpAdapter` FIFO; an explicit busy path may return `session-busy`, never a silent second execution.
- WAX-originated prompts are low priority. The adapter does not preempt a running user turn; steering is a reserved future path, not part of this closeout.
- Approval ownership is session-scoped: the ACP session owns its approval channel. There is no cross-process GUI handoff and no approval pass-through.
- `SessionOwnership` is refcounted ownership bookkeeping, not a mutex: it records which loaded LiveHives hold an explicit session. It never blocks or rejects sharing; prompt serialization is the adapter FIFO (`DshAcpAdapter.SessionPromptQueue`).
- Loop safety is graph-level and Bee-level: counter/condition nodes, `queueMax` and receptor overflow prevent unbounded handoff. There is no per-wake hop/duration budget, because there is no wake object to budget. A loop without a counter/condition is bounded by receptor overflow; every LiveHive must have a finite `queueMax`.
- `maxPumps`/`maxWaitMs` are host driver yields, not execution budgets: they end only the current driver pass and never cancel or drop a value; a later delivery resumes. `queueTtlMs` is a per-receptor waiting TTL measured from the queue entry's `enqueuedAt`, not a message lifetime.
- A spread checks target existence and part/target matching only; target capacity and acceptance are the target Bee's concern. A spread is fire-and-forget and keeps no cancel/track state.
- Target-full behavior for internal moves/spreads and assemble queues is defined by the open error-handling section (§4.14), not by a silent default.
- No automatic replay of side-effecting work; Guard never auto-allows.

### 6.1 Implemented vs target

- **Aligned and implemented:** per-Bee receptor and on-demand drain; short delivery
  (`trigger`/`answer` 202, no id); receptor snapshot and overflow (`reject|block`,
  `bee-receptor-*`); field-owned per-Bee last output (memory only); adapter
  session FIFO; ACP approval ownership; dispatch as an ephemeral graph that is
  released at silent end and never returns output.
- **Removed in the delivery-only closeout:** the execution tracker, per-request ids, run routes and
  records, per-trace limits, the old wake route, the mailbox name and its error
  codes, the dispatch timeout, and the synchronous answer wait. There are no
  aliases.
- **Target, not implemented:** free JSON `Value`; `Pheromone` = `{ value }`
  with queue-entry `enqueuedAt`; Bee `reads`/`writes`/`fallback`; spread
  clone/cleave by BeeId; gather assemble per-type queues. The code still uses
  the earlier tagged Value and id/lineage model; no aliases/backcompat.

## 7. Public names and API

The public object layer is B: `LiveHive`, `Bee`, `Beeline`, `BeeBinding`, `HiveTemplate`, `Schedule` and `Dispatch`. The control API and CLI expose `/lives`, `/templates`, `/dispatch`, `/guards`, `/sessions`, `wax live`, `wax trigger`, `wax answer`, `wax template`, `wax dispatch`, `wax guard` and `wax session`.

```text
POST /lives/trigger     package input into a Pheromone; 202 { ok: true }
POST /lives/answer      bind a value to a hovered Pheromone; 202 { ok: true }
POST /dispatch          start a temporary Bee; 202 { ok: true }
POST /lives/save|unload|migrate
GET  /lives             list loaded/unloaded LiveHives
GET  /lives/:id/inspect status + field-owned outputs + catalog entry
GET  /lives/:id/output  field output (no run id)
GET  /templates | POST /templates
GET  /guards | POST /guard/decide
GET  /sessions | POST /sessions/close|sweep
GET  /health
```

There is no run/wake/trace query route and no per-request status id.

`POST /lives/migrate` replaces a live structure; it is not a Honey layout
migration. The layout migration has no route and remains a persistence decision
(§8).

`LiveHiveHost`, `LiveHiveStatus`, `LiveHiveId` and `CompositionDefinition` remain internal execution-engine names. They are not a second object model and are not exposed by the HTTP or CLI surface. `CompositionDefinition` remains the internal engine name; its fields follow §4.12/§4.13.

The legacy graph control surface and its client commands were removed in an earlier slice; there are no aliases.

## 8. Current implementation gap

The delivery-only closeout is implemented; §6.1 records the aligned and removed
surface. The value-only target (§4.12–§4.14) is **not implemented**: the code and
CONTRACT still use the earlier tagged Value, Pheromone.id/at/lineage and
branch-based spread/gather. This is the next implementation slice; it has no
backcompat and no aliases.

One separate gap remains: the Honey directory layout (A23/C05): the code
still uses `apiaries/<apiary>/compositions/<liveId>/honey/...`, while §5 specifies
`lives/<liveId>/honey/...`. That is a separate persistence-layout slice, not part
of the delivery/field closeout. It needs an owner decision and a migration for
existing state roots; until then do not treat the current path as the target and
do not silently move or delete old state.

## 9. Temporary design

This section records temporary choices, not the long-term error/recovery design.

- **Temporary design: error + drop.** When a queue/target is full or a target
  path is not implemented, report a typed error and drop that incoming item/
  operation. No block, retry, replay, or freeze; `waxd` continues. This is a
  placeholder until the freeze design lands.
- **Existing receptor overflow.** The current code for existing receptors maps
  `trigger`/`answer` rejection to 429 and defers internal moves/spreads through
  pre-consumption reservation; it does not exit `waxd`. This is existing
  behavior, not the target for new paths.
- **Real-harness test setup.** DSH integration tests may temporarily override the
  ACP profile to `opencode-go` / `deepseek-v4.1-flash` and must restore it after
  the run. Use `OPENCODE_API_KEY` from the User scope; do not read or print the
  key. Verify the restore (SHA256 in the integration notes). This is test setup,
  not a product contract.
