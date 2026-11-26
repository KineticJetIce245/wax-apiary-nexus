# WAX Apiary neXus — Architecture

Status: **target architecture**. This document states the final design. The M19
object model (owner decisions 2026-11-26) is: `Value` is a free JSON object;
`Pheromone` is `{ value }` (no id/at/lineage); Bee definitions carry
`reads`/`writes`/`fallback`/`filter`; write-back is deep merge with an
independent `drop`; spread is `clone`/`cleave` by BeeId; gather is `assemble`
(per-type queues, count, group key) or `batch` (a sentinel pheromone flushes the
accumulated package); type matchers and group keys may be declarative rules or
local code blocks. §4.11 states the no-identity rule; §4.12–§4.13 are the target;
§4.14 is not defined yet (see §9 Temporary design). The current implementation
gap is §8. The Honey directory layout (A23/C05, §5/§8) remains a separate known
gap.

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
| `Bee` | Execution slot and execution owner: `beeId`, kind, config, `reads`/`writes`/optional `fallback`/optional `filter`, outgoing beelines, optional RoleLabel, sessionMode |
| `Value` | Free JSON object carried by a Pheromone: `message` is universal, `attachments` is the file convention, other fields are arbitrary; no `kind`/`structured` wrapper |
| `Spread` | Control Bee: `clone` or `cleave`; targets are BeeIds; no branchId/lineage; emit-only, no last output |
| `Gather` | Control Bee: one receptor; `assemble` per-type queues or `batch` sentinel flush; no branchId/lineage |
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

`input` is either a string, packaged as `{ message: <string> }`, or a JSON object
used as the Value as-is. Any loaded Bee may be the entry Bee; a control Bee
applies its own rules to the delivered value. A `gather` input that matches no
declared type is a typed error and is dropped (§9).

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

**Receptor drain is per Bee.** Each awake Bee drives its own receptor; there is
no field-wide pump and no host driver pass. An enqueue into a receptor is a
`wake(bee)` signal: if that Bee has no drain running, one starts; if it already
has one, the new entry joins the same FIFO.

```text
receptor[P0, P1, ...]
  -> P0 becomes pending (the pacing slot) when minIntervalMs requires it
  -> P0 becomes active
  -> Bee executes P0
  -> P0 moves to the next receptor (waking that Bee), or becomes a terminal output
  -> the same Bee takes its next receptor entry, or rests
```

- Receptor order is FIFO; one Pheromone is active per Bee.
- Different Bees drain concurrently; the field's short state lock protects
  shared state, and a slow native execution never blocks another Bee.
- `minIntervalMs` is a per-node pacing minimum (default 1000 ms, minimum 1000
  ms; a composition default applies when a node omits it). A drain that is not
  due yet schedules its own timer and resumes; there is no host pump to retry.
- `pending` is a pacing slot for the head of the receptor, not a second queue.
- A Bee's drain ends when its receptor and pending are empty; a hover pauses it
  and an `answer` wakes it. A Bee with no outgoing beeline is terminal; its
  Pheromone is a field output.
- A failed input is dropped and logged; the same Bee's drain continues with the
  next entry (§9 Temporary design). It never replays the side-effecting work.
- A loop is a moved Pheromone whose target is the same or another Bee; it
  re-enters that Bee's receptor. There is no per-trigger loop budget;
  `counter`/`condition` and receptor overflow bound the loop.
- There is no `maxPumps`. `maxWaitMs` is a host wait bound for `settle`/dispatch,
  not an execution budget; it never cancels or drops a value.

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

A `user` Bee's modality stays a validation rule on the answer; it does not add a
Value wrapper. The answer maps to ordinary Value fields: `text`/`message` ->
`message` (plus `attachments` for `message`), `choice` -> `choice`, `yes-no` ->
`boolean`, `image`/`file` -> `attachments: [{ path, mediaType? }]`. A JSON object
answer is used as-is when no modality restricts it.

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
| Active | Bee/field | exactly one per Bee; executing | execution ends, or stays active in the unload snapshot until its result arrives |
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
| Active | one active Pheromone | field.json active marker; restored as active, waiting for its own result |
| Hover | user Bee parked with token | field.json hover + hover Pheromone |
| Rest | no active/pending/receptor/hover/open assemble group | field.json |

A Bee is not created or destroyed per trigger. It is a loaded graph node. The temporary Bee from `dispatch` is the exception: it exists only for that dispatch and is released at silent end.

In the target model, a Bee definition carries `reads`, `writes`, optional
`fallback` and optional `filter`; built-in kinds have defaults and an instance
may override them. `reads` must resolve (a missing path is an error unless
`fallback` supplies it); `writes` lists the fields the reply must contain;
`filter` removes unwanted reply fields before the write. Every Bee also has a
per-node `minIntervalMs` pacing minimum (default 1000 ms, minimum 1000 ms; the
composition default applies when a node omits it). Plugin-defined Bee kinds are
a later slice (§4.12).

### 4.7 Field lifetime

```text
load
  -> memory authoritative
  -> trigger/answer/dispatch deliveries
  -> active/pending/receptor/hover/assemble
  -> field outputs
  -> save: snapshot to honey/field.json
  -> idle: write snapshot, release field/runtime, keep sessions
  -> load again: restore the same field, including active; a late result continues it
```

`Rest` means no active/pending/receptor/hover/incomplete assemble group remains. It is an observation of the field, not a delivery completion signal. A delivery has already ended at handoff, long before Rest.

On `load`, every Bee with restored receptor/pending work starts its own drain. A restored active is the same activation: it waits for its native result; until that result arrives the Bee is occupied and later inputs wait in FIFO. Nothing is replayed; the late result is the completion of that activation.

Unload is a memory-saving snapshot, not a terminal state. When the field has not changed for the configured idle TTL (default 30 min with Honey), the host may snapshot and release the runtime even with an active Bee, a hover, or an open assemble group. A pending guard blocks this idle unload. A later delivery or native result loads the field again and continues at the same point. An explicit unload also snapshots and releases immediately: it does not wait for a running activation, and the active is handed to the late-result path. `save` may still observe running drains within the host wait bound before snapshotting.

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
- A native execution may outlive an idle unload. When its result arrives, the same field and Bee receive it: if the field is not loaded it is loaded first, then the restored active completes with that result. The result is the completion of the existing activation, not a second execution, and it is not a replay.

### 4.9 Failure and release

- A Bee execution failure clears `active`, logs the failure, and releases that value. It never replays the side-effecting work. The same Bee's drain then continues with its next receptor entry; other Bees are unaffected (§9 Temporary design).
- Overflow/target-full behavior is not defined in the final design; see §4.14
  and §9 Temporary design. No silent loss; any drop must be recorded.
- Unload persists receptor/pending/active/hover/assemble groups and releases the runtime; sessions stay. Load restores the same field. A restored active waits for its native result; a late result completes that activation (write-back and move), it is not a replay. Later inputs queue behind it.
- An idle unload may occur with active/hover/open group when the field has not changed for the idle TTL; a pending guard blocks it. A later delivery or native result loads the field again.
- A spread emission checks target existence and part/target matching only; target acceptance is the target Bee's responsibility. After emission it keeps no tracking/cancel state; partial fan-out is possible.
- A process crash follows the same rule: Honey is the snapshot; a restored active waits for its result; no automatic retry.
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
  (a `Value`; message/attachments/arbitrary fields; no binary). Only
  output-producing Bees write it: forager, worker, user and a gather package
  (`assemble` completion or `batch` flush). condition, counter and spread do not
  write a last output. It is overwritten by the Bee's next successful activation,
  released on `unload`, and never written to Honey. There is no durable
  run-history store and no `runs/` directory; reliable viewing requires a
  downstream Bee to write a file.

### 4.11 No message identity

The target model removes `Pheromone.id` entirely. A Pheromone is `{ value }`; the
field moves that object by reference and keeps no id, no lineage, no registry,
no cursor and no public handle. The earlier rule that a field-local id must not
be used as a runId is historical; the stronger rule is that no message identity
exists at all. See §4.12.

### 4.12 Value, Pheromone, Bee I/O, and write-back

The target model:

- **Value** is a free JSON object. `message` is the universal text field;
  `attachments` is the file convention (`{ path: string; mediaType?: string }`;
  `path` is required, `mediaType` is optional and not an enum — image/audio are
  inferred from its prefix, otherwise the attachment is a file); every other
  field is arbitrary JSON. There is no `kind` tag and no `structured` wrapper.
  A plain `null` is a normal value.
- **Pheromone** is `{ value }`. It has no id, `at`, `spreadId`, `branchId` or
  `lineage`. A normal beeline moves the same object; `spread` creates new values;
  `gather` creates a new value. The field's queue entry
  `{ value, enqueuedAt }` owns the TTL timestamp; `pending`/`active` need no time.
- **Bee definition**: `reads`, `writes`, optional `fallback`, optional `filter`.
  Built-in kinds have defaults; an instance may override them. A plugin may
  define a new Bee kind later with the same contract.
- **reads**: dot paths the Bee needs from the value. A missing path is an error
  unless `fallback` maps that path to a static value.
- **writes**: dot paths that must be present in the Bee's (filtered) reply. It is
  an assertion about required output, not an allowlist. A missing declared path
  is a typed error; `null` counts as present; an empty list requires nothing.
- **Built-in defaults** (an instance may override any of them):

  | kind | reads | writes | result |
  | --- | --- | --- | --- |
  | forager | `message` | `message` | model reply -> `message` (attachments from the reply) |
  | worker | none | `message` | stdout -> `message`; non-zero exit is a failure |
  | condition | none | none | no value; chooses a true/false edge |
  | counter | none | none | no value; updates the counter |
  | user | none | none | the answer is bound to the hovered value; no write-back |
  | spread | none | none | explicit clone/cleave values |
  | gather | none | none | explicit assemble/batch package |
- **filter**: optional output gate applied to the raw reply before the `writes`
  check. `allow` and `deny` are dot-path subtree lists and may coexist. When
  `allow` is non-empty, only paths equal to or under an allow entry survive; then
  every path equal to or under a `deny` entry is removed (deny wins on overlap).
  Removed fields are recorded in a structured log (paths only, never bodies) and
  are never written. With no filter the whole reply is eligible.
- **Write-back**: after filter and `writes` check, the whole remaining reply is
  merged into `value` (default deep merge). Objects merge recursively; arrays and
  scalars replace; `null` replaces. A result may carry a separate `drop` list of
  dot paths applied after the merge. A value and a drop on the same path is an
  error; dropping a missing path is a logged no-op. Array elements are whole
  values: a dot path may resolve through an array for reads, but `writes` and
  `drop` address an array as a whole (`items`, not `items.0`); an index path in
  `writes`/`drop` is a configuration error. `spread` and `gather` are control
  Bees: they construct their output explicitly and do not use merge/write-back.
- **Control input**: `trigger`/`answer`/`dispatch` accept `input` as a string
  (packaged as `{ message: <string> }`) or as a JSON object used as the Value
  as-is.
- **Paths and rules**: simple dot paths (`message`, `attachments`, `meta.topic`);
  no JSONPath. A rule (type matcher, batch signal, group key) is either
  declarative or a code block:
  - declarative: `{ path: "kind", equals: "review" }`, also `oneOf`, `exists`
    and a type check;
  - code block: `{ code: "return value.kind === 'review';" }`, a function body
    executed with `value` and a frozen `helpers` (path access only) in a
    `node:vm` context with a 100 ms timeout and no `process`/`require`/`console`.
    A matcher returns boolean; a group key returns a non-empty string.
  Code blocks are user-authored local code. Configuration is trusted; importing
  a template from another party is the user's trust decision. `vm` is
  best-effort isolation, not a security boundary. A syntax error is rejected at
  parse time; a runtime throw/timeout/wrong result type is a typed error and the
  input is dropped per §9.

### 4.13 Spread and gather

- **Spread** is stateless fan-out with two strategies:
  - `clone` copies the whole value to every target. `targets` is an ordered list
    of BeeIds or a map whose keys are BeeIds.
  - `cleave` is field projection: `targets` is a map `BeeId -> [dot paths]` and
    each emitted part contains only those paths; a missing path is an error.
  Targets are BeeIds. The spread checks only that targets exist and that
  parts/targets align; a missing target, a missing cleave path or a mismatch is a
  typed error and emits nothing. It does not reserve or inspect target capacity;
  acceptance is the target Bee's responsibility. After emission it keeps no
  tracking, cancellation or rollback; partial fan-out is possible. A spread
  produces no last output and does not write a value.
- **Gather** is a Bee with one receptor. It is the fan-in point; `pool` is not a
  separate strategy. `strategy` is `assemble` (default) or `batch`; both use one
  input receptor plus internal per-type queues.
  - `assemble`: `types` is a map `name -> { match, count, reads }`. `match` is a
    rule; `count` is a positive integer; `reads` is a dot-path list. An input
    matches exactly one type (zero matches: typed error + drop; multiple matches:
    typed error, ambiguous). A group is FIFO by default or by `groupBy` (a dot
    path or code-block key); a missing/empty key is an error. Every type is
    required. When every type reaches its `count`, the group emits one package
    `{ type: [entries] }` immediately. With one read field an entry is the scalar;
    with multiple read fields it is a nested object keyed by the read paths (the
    same dot-path language; a path such as `meta.score` produces `meta: { score }`).
    A completed group keeps a tombstone (group key plus close time) so it cannot
    be reopened; a late input for a closed group is a typed error and is dropped.
  - `batch`: `types` declares only `match` and `reads` (no `count`/`groupBy`).
    Inputs accumulate until one matches `batch.signal` (a rule); the signal is
    checked before type matching. The matching input is consumed as the flush
    signal, is not part of the package, and triggers one package built from
    everything accumulated; the queues then reset. Inputs that arrive before the
    first signal keep accumulating. The signal may arrive from any edge,
    including a trigger or schedule delivery to the gather; there is no origin
    flag.
  - Per-type queues are bounded by `typeQueueMax` (default 256). Overflow is a
    typed error + drop of the incoming input (§9), never silent loss.
- Groups, batch accumulators and tombstones are field state: persisted in
  `field.json` and restored. Tombstone retention is bounded (default 64
  tombstones / 1 hour; temporary until §4.14).
- There is no spreadId/branchId/lineage and no message identity. Condition
  true/false outcomes remain graph edge labels, separate from spread targets.

### 4.14 Error handling and extreme recovery

**Final design: not defined.** Freeze/resume, target-full handling, and extreme
recovery are not decided. §9 Temporary design describes the current placeholder;
it is not part of the final design.

Undefined areas:

1. Backpressure/freeze: queue full, freeze/resume, timeout, fairness.
2. Process stop: Ctrl+C, SIGTERM, SIGKILL.
3. Power loss and disk: atomic writes, multi-file consistency, corruption.
4. Native harness: child exit/orphan, session busy/unknown.
5. Field recovery: a restored active waiting for its result, open assemble groups, no replay.
6. Partial fan-out and gather timeout.
7. Observability: typed errors, logs, inspect.

Principles: no silent loss; any drop must be recorded; no automatic replay of
side-effecting work; fail closed when state is uncertain.

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
  `{ value, enqueuedAt }`, active/pending/hover markers, and assemble/batch
  per-type queues, groups and tombstones. It contains no Pheromone id/lineage.
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
- There is no `maxPumps` and no host driver pass. `maxWaitMs` is a host wait bound for `settle`/dispatch, not an execution budget: it never cancels or drops a value. `queueTtlMs` is a per-receptor waiting TTL measured from the queue entry's `enqueuedAt`, not a message lifetime.
- A spread checks target existence and part/target matching only; target capacity and acceptance are the target Bee's concern. A spread is fire-and-forget and keeps no cancel/track state.
- Target-full behavior for internal moves/spreads and assemble/batch per-type queues is not defined in the final design; see §4.14 and §9 Temporary design. `typeQueueMax` bounds each per-type queue.
- No automatic replay of side-effecting work; Guard never auto-allows.
- Idle unload is a snapshot, not an execution end: when the field has not changed for the idle TTL, the host may unload even with active/hover/open group; a pending guard blocks it. A late delivery or native result reloads and continues.

### 6.1 Implemented vs target

- **Aligned and implemented:** free JSON `Value`; `Pheromone` = `{ value }`;
  queue entries `{ value, enqueuedAt }`; Bee `reads`/`writes`/`fallback`/
  `filter` and `minIntervalMs`; condition `{ when }` rules; spread
  `clone`/`cleave` by BeeId; per-Bee self-driven drain (`wake`/`settle`,
  per-Bee pacing, failure isolation); idle snapshot/unload; restored active
  with late-result continuation; lazy-load on trigger/answer/native result;
  field-owned per-Bee last output (memory only); adapter session FIFO; ACP
  approval ownership; dispatch as an ephemeral graph that is released at silent
  end and never returns output.
- **Removed in the delivery-only closeout:** the execution tracker, per-request ids, run routes and
  records, per-trace limits, the old wake route, the mailbox name and its error
  codes, the dispatch timeout, and the synchronous answer wait. There are no
  aliases.
- **Target, not implemented:** gather `assemble`/`batch` per-type queues,
  packages and tombstones (currently a typed not-implemented placeholder);
  B-layer `live.json`, HTTP/CLI input JSON and CONTRACT/README sync; real
  Codex+DSH spread/gather evidence; independent conformance review.

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

`trigger`/`answer` load an unloaded LiveHive by id before delivery when its
`live.json` and Honey exist; a native result does the same for its field. An
idle-unloaded LiveHive is still listed and can be loaded again.

`POST /lives/migrate` replaces a live structure; it is not a Honey layout
migration. The layout migration has no route and remains a persistence decision
(§8).

`LiveHiveHost`, `LiveHiveStatus`, `LiveHiveId` and `CompositionDefinition` remain internal execution-engine names. They are not a second object model and are not exposed by the HTTP or CLI surface. `CompositionDefinition` remains the internal engine name; its fields follow §4.12/§4.13.

The legacy graph control surface and its client commands were removed in an earlier slice; there are no aliases.

## 8. Current implementation gap

The delivery-only closeout is implemented; §6.1 records the aligned and removed
surface. The M19 object model is delivered in slices (M19a–M19d): free JSON
`Value`, `{ value }` `Pheromone`, queue entries with `enqueuedAt`, Bee
`reads`/`writes`/`fallback`/`filter`, spread `clone`/`cleave`, per-Bee drain and
the resumable unload lifecycle. Remaining:

- M19e: gather `assemble`/`batch` per-type queues, packages and tombstones
  (§4.13); gather is currently a typed not-implemented placeholder;
- M19f: B-layer `live.json`, HTTP/CLI input JSON, CONTRACT/README sync;
- M19g: real Codex+DSH spread/gather evidence;
- M19h: independent conformance review.

There is no backcompat and no aliases.

One separate gap remains: the Honey directory layout (A23/C05): the code
still uses `apiaries/<apiary>/compositions/<liveId>/honey/...`, while §5 specifies
`lives/<liveId>/honey/...`. That is a separate persistence-layout slice, not part
of the delivery/field closeout. It needs an owner decision and a migration for
existing state roots; until then do not treat the current path as the target and
do not silently move or delete old state.

## 9. Temporary design

Status: **temporary, not final**. This section describes the current placeholder
for target-full and unimplemented paths until the replacement slices land. The
final design is not defined (§4.14). Do not copy this section into final rules or
treat it as a guarantee.

### 9.1 Scope

The temporary design applies to:

- a target Bee receptor that is full during an internal move;
- an assemble or batch per-type queue that is full (`typeQueueMax`);
- an input that matches no assemble type, matches multiple types, or arrives for
  a closed group;
- a code-block rule that throws, times out or returns the wrong type;
- a target path with no implementation yet (freeze, gather per-type queue
  overflow); gather is still a typed not-implemented placeholder.

It does not change the final Value, Pheromone, spread, gather, read/write or
persistence rules in §3/§4.12/§4.13/§5.

### 9.2 Behavior: error + drop

When one of the cases above occurs:

1. The operation fails fast with a typed error and a structured log. The log
   carries the node/edge, the reason, and the dropped item/operation; it never
   carries a prompt/output/token body.
2. The incoming item/operation is dropped. It is not enqueued, retried, replayed,
   or held for a later freeze.
3. `waxd` continues; other Bees and LiveHives are unaffected.
4. For a spread, copies already emitted are not rolled back; the dropped branch
   is lost and partial fan-out remains. For an assemble/batch gather, the dropped
   input is not retried; the group/batch may remain incomplete and this temporary
   design invents no timeout for it.
5. There is no block, no backpressure wait, no freeze/resume, and no automatic
   retry.
6. A failed or dropped input ends only that input; the same Bee's drain
   continues with its next receptor entry and other Bees are unaffected. It
   never replays the side-effecting work.

### 9.3 Entry points and surfaces

- `trigger`/`answer`: a full receptor is reported to the caller. Current code maps
  it to 429 `bee-receptor-full` or `bee-receptor-block-timeout`; the temporary
  design does not change that HTTP behavior.
- Internal move/spread: there is no HTTP response. The typed error is logged and
  that item/operation is dropped.
- Assemble/batch per-type queue and code-block rules: the typed error is logged
  and the input is dropped; there is no HTTP surface.
- `inspect`: no freeze state is added. A dropped item is gone; logs are the only
  record.

### 9.4 State, recovery and observability

- A dropped input is not persisted and creates no tombstone. Normal queue/active
  removal still applies.
- Restart does not replay a dropped item; the caller must re-deliver if it still
  wants the work.
- Logs are the observable record. There is no wait/subscribe/query for a dropped
  item, and no new identity is minted.
- A restored active waits for its native result. If the daemon process restarts, that result is not reachable by the new process; the active stays until a later delivery or an operator decision. This is a temporary limitation, not a final recovery guarantee.
- This temporary design does not define what happens to an assemble group left
  incomplete by a drop; that is part of the final error design (§4.14).

### 9.5 Existing code vs temporary placeholder

- Existing code (not final): `trigger`/`answer` receptor full -> 429; internal
  moves drop + log; a failed activation is dropped and the same Bee continues
  with its next entry; gather is a typed not-implemented placeholder. M19e
  implements gather.
- The temporary placeholder for new target paths is error + drop as in §9.2.
- The final design is not defined; do not infer it from either behavior.

### 9.6 Temporary test environment

DSH integration tests may temporarily override the ACP profile to
`opencode-go` / `deepseek-v4.1-flash` and must restore it after the run. Use
`OPENCODE_API_KEY` from the User scope; do not read or print the key. Verify the
restore (SHA256 in the integration notes). This is test setup, not a product
contract.

### 9.7 Replacement

The freeze/recovery design replaces §9.2 when it lands. M19e implements gather
and then retires the gather placeholder described here. At that point this
section becomes historical, and §4.14 receives the final policy.
