# WAX Apiary neXus — Architecture

Status: **target architecture**. The code is a B-core prototype; the target terms below are the source of truth for new work. M17j4 dispatch graph is implemented; ACP is the sole approval owner (M17j3a approval pass-through was superseded and reverted); M17j3 moved prompt admission into the WAX `DshAcpAdapter` (DSH source untouched) and removed the legacy WAX session queue.

## 1. One sentence

A **LiveHive** is a loaded graph of **bees** connected by **beelines**; each bee runs a native harness session, and the running state lives in a **PheromoneField**.

## 2. Layers

```text
L4  Control / CLI        ControlServer / ControlClient / wax (B surface only)
L3  LiveHive host        LiveHiveService / GraphHost / LiveHiveCatalog / LiveHiveLock
L2  Session              SessionRegistry / AdapterPool / Workspace
L1  Adapter              CodexAdapter / DshAcpAdapter + adapter-owned prompt admission
L0  Native harness       Codex app-server / DSH ACP server
```

Dependency direction is upward only: L3 may call L2/L1; L2 does not know the control layer; L1 does not know LiveHive.

## 3. Core objects

| Object | Meaning |
| --- | --- |
| `LiveHive` | First-class runtime object: `bees`, `beelines`, `beeId -> sessionId` bindings, `PheromoneField`, scheduler/log, lifecycle |
| `Bee` | Execution slot: `beeId`, kind, config, outgoing beelines, optional RoleLabel, sessionMode |
| `Beeline` | Directed connection between bees: `beelineId`, `fromBee`, `toBee`, optional branch |
| `BeeBinding` | `{ beeId, sessionId }` for bees that need a native session |
| `Session` | Native session record: `sessionId`, harness, model, reasoning, params |
| `HiveTemplate` | Optional saved graph + per-bee default session params; not required to create a LiveHive |
| `RoleLabel` | Comment/label on a bee; not an instance, not a route |
| `PheromoneField` | Runtime state: pheromones, queues, pending, active, hover, joins/tombstones |
| `Dispatch` | Ephemeral one-bee LiveHive graph for one request; created, run and disposed; not a persistent LiveHive and not a direct session write |

There is no Agent object, no Revision/Definition object, and no Actor object.

## 4. Execution

1. `load` reads `live.json` (bees/beelines/bindings) and Honey (`field.json`); after load, memory is authoritative.
2. `wake(liveId, beeId, input)` places a Pheromone at the bee and pumps. A session-bound forager's prompt is admitted by the harness-side adapter; WAX does not keep a second session queue.
3. A forager bee uses its bound session (or creates one per sessionMode); a worker bee runs argv; condition/fork/merge are control bees; user waits on hover; guard waits on approval.
4. Outputs follow outgoing beelines; a bee with no outgoing beeline is terminal. The field is at Rest when no active/pending/queued/hover/join remains.
5. `save` and `unload` write `live.json` and flush field/scheduler/log to Honey; `unload` then releases field/runtime but keeps sessions.
6. There is no revision or CAS. `field.json` is a snapshot, not an event log; active pheromones restore as unknown/stuck and are not replayed.

### 4.1 Prompt admission and approval ownership

`SessionExecutionQueue` is removed as the WAX session-admission authority. The
WAX `DshAcpAdapter` owns a per-session FIFO queue for WAX-originated prompts;
the DSH source is untouched and its native one-prompt rule is honored by this
adapter queue:

```text
Bee wants prompt -> WAX DshAcpAdapter admission -> native session
                    (pending / active / terminal)
```

- One native session has at most one WAX execution at a time; different sessions
  may run in parallel. WAX is low priority: if a user is already using the
  session, the WAX request waits.
- Pending is adapter admission state, not a Bee hover and not a Pheromone queue.
- The adapter registers the execution context (WAX executionId, liveId, beeId,
  sessionId, nativeSessionId) before sending and keeps it until terminal.
- The ACP session is the sole owner of its approval channel. Every approval
  produced by an ACP session is handled by the ACP client/WAX; there is no
  unowned-approval handoff and no pass-through to a GUI/native handler.
- ACP is automation-only. A DSH/Codex GUI may list or resume a persisted
  session, but it is a different live owner: it does not receive the ACP
  session's pending approvals and cannot answer them.
- A separate **send-message ingress** may exist for submitting a new message to
  an ACP session. It only enqueues/sends a message; it is not an approval
  channel and cannot decide or cancel approvals.
- Direct Web/TUI prompts bypass the adapter. Admission priority is best-effort:
  WAX does not start while the session is visibly busy; once a WAX turn is
  running, user steer/preemption needs the reserved steer path.
- `wax answer` remains a graph/user-hover operation and is not an admission
  queue. `wax guard` covers ACP/WAX-owned approvals.
- `dispatch` creates an ephemeral one-bee LiveHive graph, runs it through the
  same admission/approval path, and disposes it; it does not write directly to
  a session and does not persist as a LiveHive.

## 5. Persistence

```text
<stateRoot>/
  waxd/
    sessions.json
    live-catalog.json
    graph-bindings.json
    runs/<runId>.json
  templates/<templateId>.json
  lives/<liveId>/
    live.json
    honey/field.json
    honey/scheduler.json
```

- `live.json` is keyed by `beeId` for `bees` and `bindings`; `beelines` are keyed by `beelineId`.
- `sessions.json` is global; each session record carries its harness.
- Adapter prompt admission/pending is memory-only; no replay after restart. A dispatch graph is ephemeral and is not persisted as a LiveHive.
- No revision file; a content hash may be added later for audit only.

## 6. Concurrency and failure

- One `waxd` process, one state root, one ControlServer.
- One AdapterPool; each harness has one Workspace. A failed harness is marked `unavailable` and does not block the daemon.
- `LiveHiveLock` serializes all mutating operations per LiveHive; different LiveHives may run in parallel.
- One session has at most one active execution. Sharing a session across LiveHives is serialized by the WAX `DshAcpAdapter` FIFO; an explicit busy path may return `session-busy`, never a silent second execution.
- WAX-originated prompts are low priority. The adapter does not preempt a running user turn; steering is a reserved future path, not part of M17j.
- Approval ownership is session-scoped: the ACP session owns its approval channel. There is no cross-process GUI handoff and no approval pass-through.
- M18 target (accepted 2026-11-24, **not implemented**): per-node workers and a short state lock; `wake` is admission-only and returns a run handle; `dispatch` waits on its own trace. The current B-core still holds `LiveHiveLock` for the whole trigger and pumps sequentially. See `../docs/temp/M18-concurrency-decision.md`.
- No automatic replay of side-effecting work; Guard never auto-allows.

## 7. Public names and internal engine names

The public object layer is B: `LiveHive`, `Bee`, `Beeline`, `BeeBinding`, `HiveTemplate`, `Schedule` and `Dispatch`. The control API and CLI expose `/lives`, `/templates`, `/dispatch`, `/guards`, `/sessions`, `wax live`, `wax wake`, `wax answer`, `wax template`, `wax dispatch`, `wax guard` and `wax session`.

`GraphHost`, `GraphStatus`, `GraphId` and `CompositionDefinition` remain internal execution-engine names. They are not a second object model and are not exposed by the HTTP or CLI surface. Renaming them is a separate internal cleanup.

The legacy graph control surface and its client commands were removed in M10c; there are no aliases.
