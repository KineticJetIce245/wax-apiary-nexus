# WAX Apiary neXus

**WAX Apiary neXus** is a lightweight coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into live, editable flowgraphs.

It is not a new agent runtime. It keeps each harness native and coordinates them through a shared graph, so a composition can mix agent work, human input, local programs, waits, guards, and forks without reimplementing session logic.

> **Status**: early design. [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`CONTRACT.md`](CONTRACT.md) describe the target runtime. The current `src/` is an earlier prototype; the PheromoneField runtime is not implemented yet.

## Vision

- **Apiary**: a project/workspace with one or more compositions.
- **Composition**: a live graph of nodes and edges.
- **PheromoneField**: the runtime state — short-lived values ("Pheromones") moving through the graph, plus node queues and waits.
- **Bee task nodes**: `Forager` for harness work, `Worker` for local work; `user` for human input.
- **Fork / Merge / Branch**: explicit control nodes, not implicit fan-out.
- **No End node**: any node with no outgoing edge is terminal. No Pheromones = `Rest`.
- **Guard**: native tool approvals and graph-level human review.
- **Honey**: durable state, transcripts, and artifacts. **log** is the separate append-only history.

## Core ideas

1. **Native harness first.** Do not simulate what Codex or DSH already does.
2. **The graph is live.** Edit compositions while they run; active Pheromones and waits are protected.
3. **Values are short-lived.** A Pheromone is consumed by a node; the node produces new Pheromones. There is no persistent cursor object and no Run instance.
4. **Terminal is implicit.** A node without an outgoing edge simply stops. There is no special terminal node.
5. **Forking is explicit.** A Fork node emits one Pheromone per branch; a Merge node waits for required branches and continues once.
6. **Durable data is Honey.** State snapshots, transcripts, and artifacts are Honey. Operational history is `log`; it never stores prompt/output bodies by default.
7. **One big daemon.** It owns adapters and the event loop. No per-agent daemon.
8. **Custom nodes are external.** Like adapters, new node executors live outside the core. No runtime hot-plug.

## Current state

- The target architecture and contract are written.
- The repository still contains an earlier prototype (workbench, adapters, flow/delegation experiments). It is useful as protocol evidence, but it is not the target runtime.
- The new runtime starts from a single-Pheromone vertical slice: trigger → node → terminal/Rest, with queue, pending, min interval, log, and tests.
- `Fork`, `Merge`, `Worker`, schedules, and the richer input modalities come after the single-Pheromone core is solid.

## Repository layout

```text
README.md            you are here
ARCHITECTURE.md      target runtime model
CONTRACT.md          composition file, runtime state, validation, CLI
src/                 earlier prototype (adapters, workbench, flow/delegation)
tests/               prototype tests
legacy-contract/     earlier adapter/flow/composition/collaboration contracts
```

`legacy-contract/` is historical. The current design lives at the root in `ARCHITECTURE.md` and `CONTRACT.md`.

## Roadmap

1. **Single-Pheromone core** — PheromoneField, trigger, node consumption/production, terminal/Rest, queue, pending, min interval, logs.
2. **Durability** — Honey snapshots, transcripts, crash/unknown recovery, live-edit protection.
3. **Multi-Pheromone** — Fork/Merge/Branch, Worker, schedules, richer user modalities.
4. **AI editing** — composition edit tools, schema checks, active-reference guards, revision audit.
5. **Hardening** — observability, session naming, optional UI, performance.

## Build and test the current prototype

Node.js 26 LTS + npm:

```bash
npm ci
npm test
```

The prototype CLI:

```bash
npm run demo
npm run workbench
```

The new runtime will get its own entry point when the single-Pheromone slice lands.

## Design principles

- Preserve native harness semantics.
- Prefer a small, boring, recoverable implementation.
- Do not auto-replay side-effecting operations after uncertain failure.
- Keep the graph editable, but never silently reroute active work.
- Separate runtime state (`PheromoneField`) from durable data (`Honey`) and history (`log`).
