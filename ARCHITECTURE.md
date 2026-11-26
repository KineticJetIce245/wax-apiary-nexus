# WAX Apiary neXus — Architecture

Status: **target architecture**; the M18 closeout (2026-11-25) made the code conformant: the control plane is delivery-only (`trigger`/`answer`/`dispatch` answer 202 and own no execution state), ordinary beelines move the same Pheromone (§4.2), the field owns the per-Bee last output, mailbox was renamed to receptor, and the old execution-registry surface (tracker, per-request ids, run routes and records, per-trace budgets, the old wake route) was removed. The one remaining known gap is the Honey directory layout (A23/C05, §5/§8). §9 is the owner decision record and remains normative.

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
| `Bee` | Execution slot and execution owner: `beeId`, kind, config, outgoing beelines, optional RoleLabel, sessionMode |
| `Beeline` | Directed connection between bees: `beelineId`, `fromBee`, `toBee`, optional branch |
| `BeeBinding` | `{ beeId, sessionId }` for bees that need a native session |
| `Session` | Native session record: `sessionId`, harness, model, reasoning, params |
| `HiveTemplate` | Optional saved graph + per-bee default session params; not required to create a LiveHive |
| `Schedule` | Optional saved trigger on a LiveHive: target bee and `at`/`every`; not an execution identity |
| `RoleLabel` | Comment/label on a bee; not an instance, not a route |
| `Pheromone` | One message/value travelling through the graph; no run/wake/trace identity |
| `PheromoneField` | The single owner of runtime state: pheromones, receptors, pending, active, hover, gathers/tombstones, outputs |
| `Dispatch` | A temporary Bee started for one prompt; it lives until the tool returns, then either flows to its next Bee or silently ends |

There is no Agent object, no Revision/Definition object, no Actor object, and no control-plane Run/Wake/Trace object.

A Bee's last completed output is a field-owned, memory-only cache (see D2 in
§9 and §4.10); it is not a run record and has no run/wake/trace identity.

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
  -> create one Pheromone P { id, value, at }
  -> append P to the entry Bee's receptor
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
  -> Bee A replaces P.value with its output
  -> the SAME P is placed in Bee B's receptor
  -> wake(Bee B)
  -> P becomes active at Bee B
```

A normal beeline moves the Pheromone; it does not create a new one. The same
`Pheromone.id` continues from Bee to Bee. Only two graph operations change the
number of Pheromones:

- `spread`: one input Pheromone becomes one copy per branch;
- `gather`: several branch Pheromones become one gatherd Pheromone.

Those are cardinality changes, not the normal edge flow. An implementation that
allocates a new Pheromone for every beeline or every Bee is nonconformant.

A receptor stores Pheromone objects directly. `ligand` is not a layer in this
architecture; only if a future storage representation cannot hold a Pheromone
may an adapter-local ligand wrapper be used inside that representation, never as
a control-plane concept.

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
replaces its value and moves it along its beeline.

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
| Moved | producing Bee | the SAME Pheromone is placed in the next receptor; its value is replaced | consumed by the target Bee |
| Terminal | field | no outgoing beeline; field output | live unload/replacement; not a per-run record |

A Pheromone never carries a run/wake/trace id. Its only identity is the message
`id` needed inside the field. A normal beeline preserves that id; `spread` creates
branch copies and `gather` creates one gatherd Pheromone because the cardinality
changes.

### 4.6 Bee lifetime

| Phase | State | Persistence |
| --- | --- | --- |
| Loaded/rest | no receptor or empty receptor; no active | live.json |
| Awake | receptor exists; drain active | field.json includes non-empty receptor |
| Active | one active Pheromone | field.json active marker; on reload becomes unknown |
| Hover | user Bee parked with token | field.json hover + hover Pheromone |
| Rest | no active/pending/receptor/hover/join | field.json |

A Bee is not created or destroyed per trigger. It is a loaded graph node. The temporary Bee from `dispatch` is the exception: it exists only for that dispatch and is released at silent end.

### 4.7 Field lifetime

```text
load
  -> memory authoritative
  -> trigger/answer/dispatch deliveries
  -> active/pending/receptor/hover/join
  -> field outputs
  -> save: snapshot to honey/field.json
  -> unload: write snapshot, release field/runtime, keep sessions
  -> load again: restore receptor/pending/hover; active becomes unknown, never replay
```

`Rest` means no active/pending/receptor/hover/incomplete join remains. It is an observation of the field, not a delivery completion signal. A delivery has already ended at handoff, long before Rest.

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

- A Bee execution failure clears `active`, logs the failure, and releases that Pheromone. It never replays the side-effecting work.
- A receptor overflow rejection drops the new Pheromone before it enters the field. A block timeout drops only that waiting request.
- Unload persists receptor/pending/hover/gathers and marks active as unknown; reload never replays active work.
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
- The only observable execution state is the LiveHive/field: `inspect`, output, receptor/pending/active/hover/join and logs.
- If a caller wants a result, the result is an edge to another Bee, not a control-plane return value.
- Output ownership is D2: the field keeps a memory-only last output per Bee
  (`text` or file/attachment path). `unload` releases it; there is no durable
  run-history store and no `runs/` directory.

### 4.11 Pheromone identity is not a control handle

`Pheromone.id` is a field-local message identity. It exists for internal
correlation (logs, spread/gather lineage, join bookkeeping) and for tests. It is
not a cursor, not a run handle, and not a public object.

Allowed uses:

- internal log correlation by the field;
- spread/gather/join bookkeeping and lineage;
- tests that inspect the field.

Forbidden uses:

- any HTTP route, CLI command, or client method that accepts or returns a
  pheromone id as a query key;
- a registry, tracker, status object, wait/subscribe, callback, or retry policy
  keyed by pheromone id;
- a persisted record, `runs/` file, output lookup, or idempotency key keyed by
  pheromone id;
- treating the id as stable across LiveHives, restarts, or unloads;
- using it to fetch a result, execution state, or lifecycle. Use `inspect`,
  `output`, and the field state instead.

A normal beeline moving the same id across Bees means one message moved, not one
execution or run. `Pheromone.id` ends with the message (terminal, drop, a
spread/gather cardinality change, or unload) and is not durable.

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
- `honey/field.json` is the durable field snapshot, including awake receptors and active/pending/hover markers.
- `sessions.json` is global; each session record carries its harness.
- There is no `runs/` directory and no per-wake/per-run record.
- The field's per-Bee last output is memory-only (D2); it is not written to
  `field.json`. Durable results are files written by a downstream Bee.
- Adapter prompt admission/pending is memory-only; no replay after restart. A dispatch Bee is temporary and is not persisted as a LiveHive.
- No revision file; a content hash may be added later for audit only.

## 6. Concurrency and failure

- One `waxd` process, one state root, one ControlServer.
- One AdapterPool; each harness has one Workspace. A failed harness is marked `unavailable` and does not block the daemon.
- `LiveHiveLock` covers mutating host operations per LiveHive; delivery is short and must not hold the lock across native execution. Different LiveHives may run in parallel.
- Each Bee has one receptor and one active Pheromone; same-Bee work is FIFO/serial, different Bees may overlap. `queueMax` overflow is `reject` (429 `bee-receptor-full`) or `block` (429 `bee-receptor-block-timeout` after the configured wait); block waits outside the state lock.
- One session has at most one active execution. Sharing a session across LiveHives is serialized by the WAX `DshAcpAdapter` FIFO; an explicit busy path may return `session-busy`, never a silent second execution.
- WAX-originated prompts are low priority. The adapter does not preempt a running user turn; steering is a reserved future path, not part of M17j.
- Approval ownership is session-scoped: the ACP session owns its approval channel. There is no cross-process GUI handoff and no approval pass-through.
- `SessionOwnership` is refcounted ownership bookkeeping, not a mutex: it records which loaded LiveHives hold an explicit session. It never blocks or rejects sharing; prompt serialization is the adapter FIFO (`DshAcpAdapter.SessionPromptQueue`).
- Loop safety is graph-level and Bee-level: counter/condition nodes, `queueMax` and receptor overflow prevent unbounded handoff. There is no per-wake hop/duration budget, because there is no wake object to budget. A loop without a counter/condition is bounded by receptor overflow; every LiveHive must have a finite `queueMax` (D3).
- `maxPumps`/`maxWaitMs` are host driver yields, not execution budgets: they end only the current driver pass and never cancel or drop a Pheromone; a later delivery resumes. `queueTtlMs` is a per-receptor waiting TTL measured from the enqueue instant (`Pheromone.at`), not a message lifetime.
- No automatic replay of side-effecting work; Guard never auto-allows.

### 6.1 Implemented vs target

- **Aligned and implemented:** per-Bee receptor and on-demand drain; short delivery
  (`trigger`/`answer` 202, no id); receptor snapshot and overflow (`reject|block`,
  `bee-receptor-*`); field-owned per-Bee last output (D2, memory only); adapter
  session FIFO; ACP approval ownership; dispatch as an ephemeral graph that is
  released at silent end and never returns output.
- **Removed in M18 closeout:** the execution tracker, per-request ids, run routes and
  records, per-trace limits, the old wake route, the mailbox name and its error
  codes, the dispatch timeout, and the synchronous answer wait. There are no
  aliases.

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

`LiveHiveHost`, `LiveHiveStatus`, `LiveHiveId` and `CompositionDefinition` remain internal execution-engine names. They are not a second object model and are not exposed by the HTTP or CLI surface. `CompositionDefinition` is unchanged.

The legacy graph control surface and its client commands were removed in M10c; there are no aliases.

## 8. Current implementation gap

The M18 closeout is implemented: the control plane is delivery-only, ordinary
beelines move the same Pheromone (§4.2), the field owns the per-Bee last output
(D2), delivery is `trigger`/`answer`/`dispatch` with `202 {ok:true}`, mailbox is
receptor with `bee-receptor-*`, and the former execution-registry surface
(tracker, per-request ids, run query route, run records on disk, per-trace
budgets, the old wake route and the synchronous answer wait) was removed with no
aliases. §6.1 records the same split.

The only remaining known gap is the Honey directory layout (A23/C05): the code
still uses `apiaries/<apiary>/compositions/<liveId>/honey/...`, while §5 specifies
`lives/<liveId>/honey/...`. That is a separate persistence-layout slice, not part
of the delivery/field closeout. It needs an owner decision and a migration for
existing state roots; until then do not treat the current path as the target and
do not silently move or delete old state.

## 9. Owner decision record for M18 closeout (2026-11-25)

This section records the lead's architecture questions and the owner's answers.
They are normative for the M18 closeout; code that contradicts them is
nonconformant. The questions were asked before any code was changed.

### D1. `dispatch` accepts a delivery; it does not return the output

**Question (lead).** ARCHITECTURE §4.4/§7 says `POST /dispatch` returns
`202 {ok:true}` and never returns the model output; the current code waits for
its run and returns `output`/`sessionId`. Which semantics should the closeout
implement?

**Owner answer.** Strictly follow the architecture: `202` only. `wax dispatch`
shows an acceptance, not the answer. A caller that needs the result must compose
a graph whose next Bee consumes it.

**Consequence.** `DispatchService` no longer waits for terminal state, returns no
output or sessionId, and has no `dispatch-timeout`. It may still return
`409 session-busy` when a non-queue adapter cannot admit the temporary Bee; the
ACP adapter FIFO remains the busy path. The temporary Bee is still released at
silent end.

### D2. Per-Bee last output is a memory-only field cache

**Question (lead).** Deleting `RunStore` removes the per-run history; after
`unload`, `GET /lives/:id/output` can no longer read the last run. Is losing that
history acceptable?

**Owner clarification.** The owner asked why the result would disappear at
unload when the result should travel with the Pheromone, and offered this
compromise (verbatim): “每一个Bee可以暂存上一次跑完之后结果的output（只能是文字，如果是文件应该留地址）如果想reliable查看只能让下游Bee写入文件”.

**Owner answer.** Each Bee may cache the output of its last completed run: text,
or a file address/path. Reliable viewing is the graph's job; a downstream Bee
must write the result to a file. The cache is not a run history.

**Consequence.**

- `PheromoneField` owns the per-Bee last output (`text` or file/attachment path).
  It is not a run record and carries no `runId`/`requestId`/`traceId`. It holds
  no binary payload; a file result is stored by address only.
- The cache is in memory only. It is not written to `honey/field.json` and is
  released with the field on `unload`; `save` does not make it durable.
- `GET /lives/:id/output` reads the field's per-Bee last output and has no
  `runId` parameter. `inspect` exposes the same field-owned outputs.
- If a caller needs a durable result, the graph must route it to a Bee that
  writes a file; WAX does not maintain run history.

### D3. No per-trace loop budget

**Question (lead).** ARCHITECTURE §4.2/§6.1 removes `maxHopsPerTrace` and
`maxDurationPerTraceMs`; a loop without `counter`/`condition` is then bounded
only by receptor overflow (`queueMax`). Is that acceptable?

**Owner answer.** Yes; follow the architecture and rely on `queueMax`.

**Consequence.** Delete the run-tracker trace limits, `TraceLimitError`,
`trace-presence`, and every `traceId` gate/purge. Every LiveHive must have a
finite `queueMax`; a loop with no counter/condition stops when the target
receptor rejects/overflows, not by a per-trace clock.

### D4. Rename mailbox to receptor

**Question (lead).** The architecture calls the Bee's waiting list `receptor`
and uses `bee-receptor-full`; the code calls it `mailbox` and uses
`bee-mailbox-full`. Should the closeout rename both the internal concept and the
public error codes?

**Owner answer.** Rename them together.

**Consequence.** Internal modules, state fields, logs, events and the public
error codes become `receptor` / `bee-receptor-full` /
`bee-receptor-block-timeout`. `queueMax` remains the composition config name and
is documented as the receptor capacity (ARCHITECTURE §6). No aliases are kept.

### D5. DSH real-integration provider for the M18 closeout

**Question (lead).** The DSH integration child is launched with `--profile acp`;
that profile defaults to `deepseek-official`, so setting `OPENCODE_API_KEY` alone
still fails with `no API key for provider route "deepseek-official"`. May the
closeout temporarily override the ACP profile to `opencode-go` /
`deepseek-v4.1-flash`, then restore it?

**Owner answer.** Allowed: temporarily patch the ACP profile and restore it after
the run.

**Consequence.** The real DSH run used `OPENCODE_API_KEY` from the User scope and
a temporary `~/.dsh/profiles/acp/cordis.patch.yml` override (agent default, the
`llm-pi-ai` provider block, and the `acp` plugin config). The original file was
restored from `../docs/temp/acp-cordis.patch.yml.m18-backup` and verified by
SHA256 (`EF189A8C27DB6D63930AA3046A3040482E952EAFCB7487C644D508E8D461F027`).
The overlay template is `../docs/temp/acp-opencode.patch.yml`. No key file was
read and no key value was printed; this is test-environment setup, not a product
contract.

### D6. Same-Pheromone movement and the per-Bee last-output cache

**Question (lead).** Does "a normal beeline moves the same Pheromone" mean the
input envelope is reused at each Bee, and how is the per-Bee last output kept?
The owner asked whether the Pheromone is discarded after each Bee, and whether
the Bee's returned value reuses the same Pheromone.

**Owner clarification.** The owner asked whether it is necessary to design the
Pheromone as "used and discarded at each Bee". The answer is no: the current
model keeps one envelope id along a normal beeline, and the per-Bee last output
is a separate cache, not the Pheromone's value.

**Owner answer.** Keep D2. A normal beeline moves the same `Pheromone` id; the
Bee consumes its value and writes its returned value into the same envelope.
The Bee additionally caches its own last completed output in
`NodeState.lastOutput`: memory-only, overwritten by its next successful
activation, released on `unload`, never written to `field.json`, and never a
run history. The cache is written by output-producing Bees (forager, worker,
user, gather); condition/counter/spread have no single result value and do not
write it. The cached `Value` is stored as-is (text and file/attachment paths are
the primary forms; no binary). "Used and discarded" happens only at a terminal
Bee, a drop/failure, or a cardinality change (spread copies; gather consumes
branches and emits one gatherd Pheromone).

**Consequence.** No code change: the A1 same-Pheromone implementation and
`tests/runtime-pheromone-identity.test.ts` remain valid. The last-output scope
and the "same envelope, replaced value" semantics are documented in CONTRACT §6
and ARCHITECTURE §3/§4.10.

### D7. `Pheromone.id` is not a RunId

**Question (lead).** If the Pheromone is retained/moved, is it a cursor-like
object? The owner accepts reusing the same pheromone id across Bees, but
requires that it must not become a runId-like handle.

**Owner answer.** The owner accepts reusing `Pheromone.id`; it must not be used
like the old runId. A Pheromone is a field-local message envelope, not a cursor:
it has no position/fetch/next/status semantics. Its id may appear only in
internal field/log/join bookkeeping; it must not be exposed as a public query
key or used to own execution state.

**Consequence.** §4.11 is normative. No HTTP/CLI route, registry, tracker,
persistence key, output/status lookup, wait, or idempotency key may use
`Pheromone.id`. The public surface has no pheromone-id route; a guard test
asserts that adding one fails.
