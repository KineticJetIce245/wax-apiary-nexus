# WAX Apiary neXus

**WAX Apiary neXus** is a lightweight coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into live, editable flowgraphs.

It is not a new agent runtime. It keeps each harness native and coordinates them through a shared graph, so a composition can mix agent work, human input, local programs, waits, guards, and forks without reimplementing session logic.

> **Status**: early design. [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`CONTRACT.md`](CONTRACT.md) describe the target runtime. The runtime, Forager bridge, one-shot Codex CLI, Honey/log/transcripts, Guard hovers, and live-edit reference checks are implemented; `npm test` passes 224/0. `--harness dsh` is not wired, and a real Codex smoke test is still pending in an environment where `codex` is available.

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
- The single-Pheromone runtime lives in `src/runtime/`: trigger, terminal/Rest, queue/pending, condition/counter, and `user` nodes that park a Pheromone in a Hover until the answer arrives. Early answers are persisted with the field.
- The Workspace Forager bridge lives in `src/forager.ts`; the one-shot `wax run` CLI lives in `src/cli.ts`.
- Honey lives in `src/honey.ts`: an atomically replaced `field.json` under `~/.wax/apiaries/<apiary>/compositions/<id>/honey/`, plus a metadata `log.jsonl` that never stores prompt or output bodies. Transcripts keep the event bodies; the log only references them. Both rotate at a byte limit.
- Native approvals become **Guard** hovers: bound to their `requestId`, cancelled after one hour, persisted like any other hover. An early, late or mismatched decision is rejected, and nothing is ever auto-allowed.
- `--resume` rebuilds a field; an interrupted Forager becomes unknown and is never replayed, and a persisted Guard cannot be resumed.
- `src/revision.ts` refuses a graph edit that removes or renames a node still holding queue, pending, active or hover state; a forced edit returns the nodes that must be marked as needing attention.
- The old flow/composition/workbench/delegation/web orchestration has been removed. `src/` keeps the runtime plus the adapter/session infrastructure it uses.
- `--harness dsh` is not wired yet; the real Codex smoke test still needs a machine with Codex available.
- The next step is a real Codex smoke test (and then the Stage 3 graph features); no additional Stage 2 code slice is pending.

## Repository layout

```text
README.md            you are here
ARCHITECTURE.md      target runtime model
CONTRACT.md          composition file, runtime state, validation, CLI
src/runtime/         the implemented single-Pheromone runtime
src/forager.ts       Workspace -> NodeExecutor bridge
src/cli.ts           one-shot `wax run` CLI
src/adapters/        native harness adapters
src/workspace.ts     native session lifecycle used by the Forager bridge
src/                 session/infrastructure modules
tests/               runtime, adapter and infrastructure tests
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

The one-shot CLI runs one composition through a real Codex app-server:

```bash
npm run wax -- run composition.json --project . --harness codex --trigger plan --input "why is the sky blue"
```

It triggers one node, pumps the graph to Rest, and prints the node states, a log
summary, and the final output. `user` nodes prompt on stdin; a non-interactive
stdin is refused instead of answered. The run persists Honey and can be
continued with `--resume` (`--state-dir` and `--apiary` override the location).
`--harness dsh` is not wired yet.

## Design principles

- Preserve native harness semantics.
- Prefer a small, boring, recoverable implementation.
- Do not auto-replay side-effecting operations after uncertain failure.
- Keep the graph editable, but never silently reroute active work.
- Separate runtime state (`PheromoneField`) from durable data (`Honey`) and history (`log`).
