# WAX Apiary neXus

WAX Apiary neXus is a local coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into live graphs without reimplementing their session logic.

It is not a new agent runtime. Each harness stays native; WAX coordinates graphs, sessions, work, waits, and persistence around it.

## Vision

The target is **B-core**: one daemon, many live graphs, real native sessions.

```text
waxd
  ├─ GraphHost
  │    ├─ Composition (nodes, edges, triggers)
  │    ├─ PheromoneField (runtime state)
  │    └─ Honey (durable field/scheduler/log)
  ├─ SessionRegistry (native sessions, busy, persistence)
  └─ Control API (load / trigger / status / unload / sweep)
```

- **One execution path.** A-mode is not a second engine; it becomes a profile of B-core.
- **Graphs are live objects.** Load creates a LiveGraph; trigger uses it; unload releases it; idle graphs are evicted.
- **Sessions are real leases.** A Forager binds a native session or requests a fresh one; session identity is persisted and lazily reattached after restart.
- **Composition and manifest are separate.** A composition describes the graph; a `<graph>.wax.json` manifest describes how to load it (project, harness, bindings, idle TTL).
- **Graph references can restore work.** A trigger or hover answer may carry a manifest/address; when the graph is no longer in memory, the daemon can load it again.
- **Idle and hover graphs can unload.** Honey preserves field and hover state; sessions are decoupled from graph lifetime and have their own lifecycle.
- **Plugins coordinate across graphs.** A harness plugin owns the session → compositions map and sends triggers one at a time; the daemon does not share nodes across graphs or broadcast to “all graphs for a session”.
- **Edits are validated and revisioned.** Structural graph changes go through a validated API, not direct mutation of a running Live. This part is still future work.

The full Agent Network direction — Agent identity, CompositionTemplate, Live binding, dispatch, multi-Live scheduling, native session fork — is **not implemented**. B-core currently stops at graphs, sessions, hosting, persistence, and local control.

## Progress

**M1–M4c2c2 are complete and pushed** as `3a6054f`; this README refocus is `3e842e9`.

| Milestone | State |
| --- | --- |
| M1 Honey durability | Atomic write, fsync, temp cleanup, failure-injection tests |
| M2 Graph registry | Residency, idle TTL, sweep, refCount/lease, Rest-only unload |
| M3 Session binding | Binding validation, SessionRegistry, routing executor, per-forager sessions |
| M4a GraphHost | Load / trigger / status / unload / sweep; pacing waits; Rest-only unload |
| M4b Honey persistence | Restore on load, flush on trigger/unload, flush failure blocks unload |
| M4c1 Control API | Loopback HTTP, token auth, load/trigger/status/unload/sweep |
| M4c2a ControlClient | Daemon discovery, loopback-only, timeouts, safe errors |
| M4c2b CLI | `waxd`, `wax graph`, `wax trigger`; real process smoke |
| M4c2c1 Session persistence | Store, hydrate, `ensureAttached`, native session resume |
| M4c2c2 Multi-harness | One `waxd` process, per-harness control servers and state roots |

Current verification:

- full suite: **762 tests — 761 pass, 1 platform-skipped**
- native DSH/Codex integration: **11/11** (last full run after M3a)
- real native smokes: session create/busy/close, multi-session fork/merge, GraphHost, Honey unload/reload, HTTP control, ControlClient, `waxd` CLI, session resume after restart, dual-harness `waxd`
- A-mode tests remain green; the `wax run` path was not rewritten

## Next

| Milestone | Planned |
| --- | --- |
| M5 | Manifest + `fresh_once` / `fresh_always` + resolved bindings store |
| M6 | `graphRef` lazy load + hover unload + session lifecycle |
| M7 | A command-surface pruning; A becomes a B-core profile |
| M8 | Edit API + six-stage validation + CAS/lease + atomic graph write |

M5a — manifest parser + `wax graph load --manifest` — is in progress.

## Known limits

- No edit API or structural validation/CAS yet; graph edits are still offline.
- A is still exposed as a separate command surface; pruning has not started.
- Graph definitions and bindings are not auto-restored today; only sessions and Honey are persisted. M5/M6 address this.
- Idle unload is Rest-only today; hover and session-decoupled unload are M6.
- OS SIGTERM graceful cleanup, `close` after a failed session-store removal, and the single-endpoint multi-host model remain unverified or unfinished.
- Native session fork, Agent identity, Template/Live, and multi-Live scheduling are not implemented.
- Physical power-loss durability and real active-work native process kills are not verified.
