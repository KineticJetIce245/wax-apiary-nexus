# WAX Apiary neXus — LiveHive Contract

Status: **current contract** (M19f, 2026-11-26). The M19 object model is
implemented through the B layer and the public control/CLI surface: free JSON
`Value`, `Pheromone` = `{ value }` with no id, Bee `reads`/`writes`/`fallback`/
`filter`, spread `clone`/`cleave` by BeeId, gather `assemble`/`batch`, per-Bee
drain, and the resumable unload lifecycle. Real mixed Codex+DSH spread/gather
evidence is still M19g; the independent review is M19h. The separate Honey
directory layout gap (A23/C05) is unchanged.

## 1. Scope

This document defines:

- the `live.json` file;
- bee/beeline/binding semantics;
- the `PheromoneField` runtime state;
- session binding and lifecycle;
- save/load/unload persistence;
- the control API and CLI surface.

It does not define Harness Adapter wire protocols, a UI, remote/multi-tenant
behavior, or a plugin loader.

## 2. `live.json`

`live.json` is keyed by `beeId`; `beelines` is keyed by `beelineId`. There is no
revision field and no CAS. The document is the current M19 shape only; an older
document with `branches`, `required` or `combine` is rejected, not migrated.

```json
{
  "schemaVersion": 1,
  "liveId": "demo",
  "bees": {
    "plan": {
      "kind": "forager",
      "config": { "connection": "codex", "prompt": "Plan: {{message}}" },
      "reads": ["message"],
      "writes": ["message"],
      "outgoing": ["to-split"]
    },
    "split": {
      "kind": "spread",
      "config": { "strategy": "clone", "targets": ["left", "right"] },
      "outgoing": []
    },
    "left": {
      "kind": "forager",
      "config": { "connection": "codex", "prompt": "Left review" },
      "outgoing": ["left-merge"]
    },
    "right": {
      "kind": "forager",
      "config": { "connection": "dsh", "prompt": "Right review" },
      "outgoing": ["right-merge"]
    },
    "merge": {
      "kind": "gather",
      "config": {
        "strategy": "assemble",
        "types": {
          "left": {
            "match": { "path": "side", "equals": "left" },
            "count": 1,
            "reads": ["message"]
          },
          "right": {
            "match": { "path": "side", "equals": "right" },
            "count": 1,
            "reads": ["message", "meta.score"]
          }
        },
        "typeQueueMax": 256
      },
      "outgoing": ["to-done"]
    },
    "done": {
      "kind": "forager",
      "config": { "connection": "codex", "prompt": "Write the decision" },
      "outgoing": []
    }
  },
  "beelines": {
    "to-split": { "fromBee": "plan", "toBee": "split" },
    "left-merge": { "fromBee": "left", "toBee": "merge" },
    "right-merge": { "fromBee": "right", "toBee": "merge" },
    "to-done": { "fromBee": "merge", "toBee": "done" }
  },
  "bindings": {
    "plan": "s1",
    "left": "s2",
    "right": "s3",
    "done": "s4"
  }
}
```

- `bees` and `bindings` use `beeId` as the key.
- `beelines` use `beelineId` as the key and reference `fromBee`/`toBee`.
- A control bee (condition/spread/gather/user) may have no binding.
- A bee with no outgoing beeline is terminal.
- Spread has no beelines: its targets live in `config.targets`.
- Gather has one receptor and at most one normal outgoing beeline.
- Condition has exactly two outgoing beelines, `when: "true"` and
  `when: "false"`.

## 3. Bee

```text
Bee = {
  beeId,
  kind,          // forager | worker | condition | spread | gather | user
  config,
  reads?,        // dot paths needed from the value
  writes?,       // dot paths required in the filtered reply
  fallback?,     // static values for missing read paths
  filter?,       // { allow?, deny? } output gate
  outgoing: [beelineId],
  roleLabel?,    // comment only
  sessionMode?   // reuse | fresh_once | always_fresh
}
```

- `beeId` is unique within a LiveHive.
- `forager` requires a session; `worker` runs argv; `condition` selects
  beelines; `spread`/`gather` are field control; `user` waits on hover.
- `roleLabel` is a comment/label; it does not route and does not bind a session.
- `sessionMode`:
  - `reuse`: a binding must exist;
  - `fresh_once`: create once, then reuse;
  - `always_fresh`: create a new session on every bee activation.
- `reads` is a dot-path list; a missing read path is an error unless `fallback`
  supplies it. `writes` asserts that the filtered reply contains the declared
  paths; `null` counts as present, and an empty list requires nothing.
- `filter.allow` keeps only the listed subtrees; `filter.deny` then removes
  them; deny wins on overlap. Removed paths are logged, never bodies.
- Built-in I/O defaults: forager `reads: ["message"]`, `writes: ["message"]`;
  worker `reads: []`, `writes: ["message"]`; condition/user/spread/gather
  `reads: []`, `writes: []`. An instance may override either list.
- Spread and gather are control Bees: they construct their output explicitly
  and do not use writes/filter.

### 3.1 Spread config

```text
Spread = { strategy: "clone", targets: BeeId[] | { [BeeId]: JsonValue } }
       | { strategy: "cleave", targets: { [BeeId]: [dotPath] } }
```

- `clone` copies the whole value to every target; `targets` is an ordered list
  or a map keyed by BeeId.
- `cleave` keeps only the listed dot paths for each target; a missing path is
  an error and nothing is emitted.
- Targets are BeeIds and must exist. A duplicate target, an empty target list
  or a spread beeline is a configuration error.
- A spread has no last output and keeps no per-emission tracking.

### 3.2 Gather config

```text
Gather = {
  strategy?: "assemble" | "batch",   // default "assemble"
  types: { [name]: { match: Rule, count?, reads? } },
  groupBy?: dotPath | { code },
  batch?: { signal: Rule },          // batch only
  typeQueueMax?: positive integer    // default 256
}
```

- `match` is a declarative rule (`{path, equals|oneOf|exists|type}`) or a code
  block `{ code }`. A code block runs with `value` and frozen `helpers` in a
  `node:vm` context (100 ms, no `process`/`require`/`console`). It is local,
  trusted configuration; `vm` is not a security boundary.
- `assemble` requires a positive `count` per type and emits one package
  `{ type: [entries] }` as soon as every type reaches its count; the package
  contains every declared type. A group is FIFO, or keyed by `groupBy`; a FIFO
  entry beyond a type's count starts the next group, while a keyed group refuses
  the extra input. A closed keyed group keeps a tombstone so a late input cannot
  reopen it. Every declared type is required.
- `batch` declares only `match` and `reads` (no `count`/`groupBy`). Inputs
  accumulate until one matches `batch.signal`; the signal is consumed, is not
  part of the package, and flushes every accumulated queue. An empty flush emits
  one package with empty arrays for all declared types.
- An input that matches zero or several types, a missing cleave/read path, a
  full per-type queue, or a closed group is a typed error and that input is
  dropped; the field records the drop.
- `reads` is a dot-path list. With one read path an entry is the scalar; with
  several it is a nested object keyed by those paths. An empty list produces
  `{}`.

## 4. Beeline

```text
Beeline = {
  beelineId,
  fromBee,
  toBee,
  when?: "true" | "false"
}
```

- `beelineId` is unique within a LiveHive.
- `when` is a condition outcome only. A normal edge has no `when`; there is no
  branch label and no spread/gather branch.
- A beeline is not runtime state; it does not hold a session.

## 5. Session

```text
Session = {
  sessionId,
  harness,
  model?,
  reasoning?,
  params?
}
```

- A session is a native Harness lease; WAX stores routing metadata only.
- One session has at most one active execution. An explicit session is
  authoritative for harness/model/reasoning; a conflicting creation spec is an
  error.
- WAX-originated prompts are admitted by the WAX `DshAcpAdapter`, which owns one
  FIFO per session; DSH source remains untouched and its native one-prompt rule
  is honored by this adapter. Multiple bees/LiveHives may share a session; WAX
  is low priority and waits while a user is using it. There is no second WAX
  session-admission queue.
- An ACP session is the sole owner of its approval channel. Every approval from
  that session is handled by ACP/WAX; there is no unowned-approval handoff, GUI
  approval, or pass-through. ACP is automation-only: a DSH/Codex GUI may list or
  resume the persisted session but cannot receive or answer its live approvals.
- A native approval is a runtime Guard hover. The runtime guard deadline (default
  120s) is the only approval deadline; there is no second Workspace timer. An
  expired approval is cancelled through the normal execution cancel path and is
  recorded as `approval-timeout`.
- A separate send-message ingress may submit a new message to an ACP session; it
  cannot decide or cancel approvals and does not share the approval channel.
- `dispatch` creates an ephemeral one-bee graph, delivers the prompt through the
  same admission/approval path, answers 202, and releases the graph at silent
  end. It never returns the model output or a session id, is not persisted as a
  LiveHive, and has no dispatch timeout. A non-queue adapter that cannot admit
  the temporary bee returns 409 `session-busy`; the ACP adapter FIFO is the busy
  path.

## 6. `PheromoneField`

- Holds pheromones, one receptor per Bee, pending, active, hover, gather
  groups/tombstones, counters, and the per-Bee last output.
- A `Value` is a free JSON object. `message` is the universal text field;
  `attachments` is the file convention; every other field is arbitrary JSON.
  There is no `kind` tag and no `structured` wrapper.
- A `Pheromone` is `{ value }` only. It has no id, `at`, lineage, branch or
  run/wake/trace identity. A normal beeline moves the same object; only `spread`
  and `gather` change cardinality. A receptor stores queue entries
  `{ value, enqueuedAt }`; the entry owns the TTL timestamp.
- A receptor is FIFO. `pending` is a pacing slot for the head of a receptor; one
  Pheromone is active per Bee. Each awake Bee drives its own drain: there is no
  field-wide pump and no `maxPumps`.
- A Bee with no outgoing beeline is terminal; its Pheromone becomes a field
  output.
- `field.json` is a snapshot, not an event log, and contains no run/trace record
  and no output cache.
- The per-Bee last output is a memory-only `Value` owned by the field. It is
  written by output-producing Bees (forager, worker, user, gather package) on a
  successful activation; condition/counter/spread do not write it. It is
  overwritten by the Bee's next successful activation, is not written to
  `field.json`, is not a run history, and is released on `unload`.
- A loop is bounded by `counter`/`condition` and receptor overflow (`queueMax`);
  there is no per-trace hop or duration budget.
- `maxWaitMs` is a host wait bound for `settle`/save/unload/dispatch, not an
  execution budget; `queueTtlMs` is a per-receptor waiting TTL from the enqueue
  instant, not a message lifetime.
- `load` restores receptors/pending/hover/active/open gather groups. A restored
  active Pheromone stays active and waits for its own native result. It is never
  replayed; a late result completes the same activation.
- `unload` snapshots the field and releases the runtime immediately. An active
  native execution is detached; its late result reloads the field and completes
  that activation. Sessions remain in the `SessionRegistry`.

## 7. Save / load / unload

- `load`: read `live.json` + Honey; memory becomes authoritative. A live with a
  legacy/incompatible Honey snapshot fails closed and is **not** migrated.
- `save`: flush field/scheduler/log to Honey; overwrite `live.json`. It does not
  make the output cache durable.
- `unload`: also overwrite `live.json`, then snapshot and release the
  field/runtime immediately; an active native execution is detached and its
  late result loads the field again. Sessions remain. The field's last output is
  released.
- No revision comparison, no CAS, no lease.
- Manual file copy is not a supported LiveHive copy; WAX does not guarantee
  consistency for copied files.

## 8. Control API

The API is B-only:

```text
POST /lives                     create a LiveHive
POST /lives/load                load by id, optional path or inline live
POST /lives/instantiate         instantiate a template
POST /lives/trigger             deliver input as a Pheromone
POST /lives/answer              bind a value to a user hover
POST /lives/save                save
POST /lives/unload              unload
POST /lives/migrate             explicit structure change
GET  /lives                     list loaded and unloaded LiveHives
GET  /lives/:id/inspect         status, field outputs and catalog entry
GET  /lives/:id/output          field output (no run id)
GET  /templates                 list templates
POST /templates                 compose a HiveTemplate
POST /dispatch                  ephemeral one-bee delivery
GET  /guards                    pending guard requests
POST /guard/decide              decide one guard request
GET  /sessions                  global sessions
POST /sessions/close            close
POST /sessions/sweep            sweep idle
GET  /health
```

- One endpoint, one token.
- `--harness` filters/validates; it does not select a per-harness daemon.
- `input` on `POST /lives/trigger`, `POST /lives/answer` and `POST /dispatch` is
  either a string, packaged as `{ message: <string> }`, or a JSON object used as
  the `Value` as-is. The object is not stringified; nested fields stay fields.
  Any other JSON root (array, number, boolean, `null`) is 400 `bad-request`.
- `POST /lives/trigger` is delivery-only: it appends one Pheromone to the target
  Bee's receptor, returns **202** `{ ok:true }` and forgets the request. It does
  not wait for native execution, creates no run/trace id, and has no result
  query. Execution state is observed through the LiveHive itself (`inspect`,
  `output`, logs).
- Receptor overflow follows the configured policy:
  - `reject`: 429 `bee-receptor-full` with `liveId/beeId/pending/limit/policy`;
    no Pheromone enters the field;
  - `block`: wait outside the state lock, emit `bee-receptor-blocked`, then 429
    `bee-receptor-block-timeout` with `waitedMs` if capacity does not arrive.
- `POST /lives/answer` validates the hover token, binds the value to the hovered
  Pheromone, clears hover, wakes the Bee and returns **202** `{ ok:true }`. It
  does not wait for the Bee to finish, creates no Pheromone and no second
  execution chain. If the downstream receptor cannot accept the value, it
  returns 429 `bee-receptor-full` (or the block timeout) before consuming the
  hover; the hover remains open.
- `POST /dispatch` creates an ephemeral one-bee graph, delivers the input,
  returns **202** `{ ok:true }`, and never returns the output or a session id.
  The temporary Bee is released at silent end and never becomes a
  LiveHive/catalog/Honey entry. A non-queue adapter that cannot admit it returns
  409 `session-busy`; there is no dispatch timeout and no queue handle.
  Unknown/conflict errors keep the 404/409 mapping.
- A legacy/incompatible Honey snapshot fails a create/load with **409
  `honey-incompatible`**; the response body is generic and never contains an
  absolute path. The old state is kept; WAX does not migrate or delete it.
- `GET /lives/:id/output` returns the field-owned last output per Bee. It takes
  no run identifier and has no history: after `unload` it returns 404
  `not-found`. A durable result must be written by a downstream Bee.
- There is no run, wake or trace query route and no per-request status id. There
  is no per-trace `maxHops`/`maxDuration`; loop safety is the graph plus receptor
  overflow.
- There is no queue-status route. Adapter admission is in memory only and has no
  public id; a restart forgets pending prompts and never replays them.
- `GET /guards` and `POST /guard/decide` cover approvals owned by WAX/ACP
  sessions. ACP owns its session's entire approval channel; there is no
  unowned-approval or GUI pass-through. A future send-message ingress is
  separate and cannot decide approvals. A guard decision is single-use: deciding
  the same request again returns 409 `conflict` (or 409 `guard-expired` for an
  expired request).
- No spread route. The legacy graph, wake, catalog, queue and run routes are not
  present and have no aliases.

## 9. CLI

```text
waxd
wax live list|new|load|instantiate|save|unload|inspect|migrate
wax trigger <liveId> <beeId> [--input <text> | --input-json <json> | --input-file <path>]
wax answer <liveId> <beeId> [--input <text> | --input-json <json> | --input-file <path>] [--token <hv_...>]
wax template compose|list
wax dispatch [<input> | --input <text> | --input-json <json> | --input-file <path>]
wax guard list|decide <requestId> --decision allow_once|reject_once|cancelled
wax session list|close|sweep
```

- `--input <text>` keeps the existing string behavior; it is packaged as
  `{ message: <text> }`.
- `--input-json <json>` parses one JSON object and sends it as the `Value`
  as-is. `--input-file <path>` does the same from a UTF-8 file.
- `--input-json` and `--input-file` are mutually exclusive, and neither may be
  combined with `--input` (or, for `wax dispatch`, a positional input). A
  non-object JSON root or invalid JSON is a usage error (exit 2).
- `wax dispatch` keeps its old string precedence: `--input` wins over the
  positional input; with no structured flag, one of them is required.
- `wax live inspect <liveId> --json` prints the raw inspect response; its
  `outputs[].value` is the free JSON `Value`, not a text-only record.
- `wax trigger`, `wax answer` and `wax dispatch` report only that the delivery
  was accepted (human line `accepted`, or `{ok:true}` with `--json`). They never
  print an output or a run/trace id; read `inspect`/`output` for the field's
  last output, and compose a graph for a durable result.
- There is no `wax wake`, no `wax live wake|answer` and no run query. Removed
  commands are usage errors (exit 2); there are no aliases.
- The legacy graph client commands and `wax queue` are not present and have no
  aliases.

## 10. Invariants

1. One daemon, one ControlServer, one state root.
2. One AdapterPool; one Workspace per harness; global SessionRegistry. The WAX
   `DshAcpAdapter` owns prompt admission, pending and the ACP approval channel;
   DSH source is untouched.
3. A LiveHive can mix harnesses; `liveId` is globally unique.
4. One session has one active execution. WAX-originated prompts are one FIFO per
   session at the adapter; WAX is low priority relative to direct user use.
5. Same LiveHive mutating operations are serialized; different LiveHives may run
   in parallel. Delivery is short and never holds the lock across native
   execution.
6. `unload` keeps the catalog/sessions; `inspect`/`output` do not refresh TTL.
7. Load makes memory authoritative; save/unload overwrite disk. The per-Bee
   output cache is memory-only and is released on unload.
8. The control plane owns no execution state: no run tracker, run/trace id,
   per-request registry or shadow lifecycle. A delivery ends at handoff.
   `Dispatch` is an ephemeral graph, not a persistent LiveHive; there is no
   LiveHive copy command.
9. No Agent/Revision/Definition/Actor objects.
10. No message identity: a Pheromone has no id, and no HTTP/CLI route, registry,
    tracker, persistence key, output/status lookup, wait or idempotency key may
    invent one. A normal beeline moves the same Pheromone; `spread`/`gather`
    create values only because cardinality changes.
11. Logs never contain prompt/output/token bodies; output uses explicit routes.
12. Never auto-allow Guard; ACP owns its session's approval channel with no
    GUI/pass-through; never replay side-effecting work. A restored active
    Pheromone waits for its own result and is not replayed.
13. Every LiveHive has a finite `queueMax`; loop safety relies on
    counters/conditions and receptor overflow, not on a per-trace budget.
