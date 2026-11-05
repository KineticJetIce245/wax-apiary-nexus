# WAX Apiary neXus

**WAX Apiary neXus** is a lightweight coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into live, editable flowgraphs.

It is not a new agent runtime. It keeps each harness native and coordinates them through a shared graph, so a composition can mix agent work, human input, local programs, waits, guards, and forks without reimplementing session logic.

> **Status**: early design. [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`CONTRACT.md`](CONTRACT.md) describe the target runtime. The runtime, Forager bridge, one-shot Codex CLI, Honey/log/transcripts, Guard hovers, live-edit reference checks, Stage 3A Fork/Merge/Branch, Stage 3B Worker/Condition worker, the Stage 3C-1 foreground daemon scheduler, the Stage 3C-2 rich manual user input, the Stage 4A offline composition editor, the Stage 4B-A JSON CLI contract for that editor, the Stage 4C read-only revision audit and orphan-temp inspection, and the Stage 4D DSH harness wiring are implemented; `npm test` passes 390/0. A real Codex smoke passed with codex-cli 0.166.0-alpha.5.1 through `--codex-exe` for the one-shot path; the daemon is covered with a fake adapter. `wax run` and `wax daemon` select Codex or the existing DSH ACP adapter; dsh requires an explicit `--dsh-root` or `DSH_ROOT`. A real DSH smoke launched the adapter and reached the model call, then failed because no API key was configured, so a real DSH completion remains unverified.

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
- The PheromoneField runtime lives in `src/runtime/`: trigger, terminal/Rest, queue/pending, condition/counter, and `user` nodes that park a Pheromone in a Hover until the answer arrives. Early answers are persisted with the field.
- Stage 3A adds Fork/Merge/Branch. A Fork consumes one Pheromone and emits one tagged copy per branch (`forkId` + `branchId`); a branch keeps its tags through normal nodes. A Merge groups arrivals by `forkId`, waits for its required branches, consumes them atomically, combines them as newline-joined text, and emits once. Duplicate, unknown, failed or missing required branches fail the merge and cancel siblings; a Merge with no outgoing edge is terminal.
- Joins persist in `honey/field.json` and count as live references for edit protection. A restored join is not replayed: arrived branches stay arrived and an already-complete join settles once.
- Stage 3B adds the `worker` node and `Condition` `mode: "worker"`. A worker runs an argv-only process (`shell: false`) with `cwd` contained to the registered project, a 60s default timeout, and a 64 KiB cap per output stream; timeout or cap overflow kills the process tree. stdout becomes the text Value, stderr stays error metadata, and non-zero exit fails the activation without retry. A Condition worker branches on the exit code instead: 0 is `true`, non-zero is `false`.
- Stage 3C-1 adds scheduled triggers. A composition may declare `triggers` with an `at` instant (ISO-8601 with `Z` or an offset) or a fixed `everyMs` interval (>= 1000). Only `forager` and `worker` targets are accepted; scheduled `user` triggers and control nodes are rejected. Trigger ids are unique.
- `wax daemon` runs one composition's schedule in the foreground. A per-composition lock refuses a second daemon, `honey/scheduler.json` records occurrences atomically before the runtime enqueues them (at-most-once: a crash can lose an occurrence, never duplicate one), and a past `at`/missed `every` fires once on start without a missed-interval storm. Active restored Foragers stay unknown and active Workers stay stuck; nothing is replayed.
- The daemon has no TTY: Guard requests are rejected by default and logged; there is no Guard inbox. Shutdown on SIGINT/SIGTERM (or the injected abort signal in tests) stops scheduling, stops the workspace, and releases the lock.
- Stage 3C-2 adds manual `message`, `image`, and `file` user answers. The parser accepts the three modalities; the runtime validates the Value shape and modality without touching the filesystem; the interactive CLI prompts for a message or one local path, expands `~`, requires an existing regular file, and stores the absolute path. The Forager bridge forwards image/file attachments to the adapter as `AttachmentDraft`s, infers `mimeType` from the path extension, and uses `See attached input.` when the rendered prompt would be empty. Nothing is copied or previewed; scheduled `user` triggers remain deferred.
- The Workspace Forager bridge lives in `src/forager.ts`; the one-shot `wax run` CLI lives in `src/cli.ts`; the daemon and scheduler live in `src/daemon.ts`, `src/scheduler.ts` and `src/daemon-lock.ts`.
- Honey lives in `src/honey.ts`: an atomically replaced `field.json` under `~/.wax/apiaries/<apiary>/compositions/<id>/honey/`, plus a metadata `log.jsonl` that never stores prompt or output bodies. Transcripts keep the event bodies; the log only references them. Both rotate at a byte limit.
- Native approvals become **Guard** hovers: bound to their `requestId`, cancelled after one hour, persisted like any other hover. An early, late or mismatched decision is rejected, and nothing is ever auto-allowed.
- `--resume` rebuilds a field; an interrupted Forager becomes unknown and is never replayed, and a persisted Guard cannot be resumed.
- `src/revision.ts` refuses a graph edit that removes or renames a node still holding queue, pending, active, hover, or merge-waiting state; a forced edit returns the nodes that must be marked as needing attention.
- Stage 4A adds offline `wax composition validate <file>` and `wax composition replace <file> --with <new-file> [--state-dir <dir>] [--apiary <id>]`. `validate` only reads and parses. `replace` parses both files, refuses a different composition id, any queue/pending/active/hover/merge-waiting reference (when `--apiary` resolves a Honey field), and a live or uncertain daemon lock; it writes through a same-directory temp file plus rename and appends one metadata-only revision audit line to `<state-dir>/revisions.jsonl` (default `~/.wax/revisions.jsonl`). There is no `--force`, no `needsAttention` write, and a stale lock is left in place. Without `--apiary`, replace still runs but prints that active references were not checked.
- Stage 4B-A adds `--json` to both composition commands. JSON mode writes exactly one object to stdout and nothing to stderr: `{ok:true,...}` for success, `{ok:false,command,code,error}` for failure with `code` one of `usage`, `parse`, `refused`, `io`, `internal`. Exit codes remain `0` success, `2` usage/parse/refusal, `1` IO. `src/composition-tool.ts` is the transport-neutral result layer; it calls the same guarded editing service as the human CLI, so active-reference, daemon-lock and audit policy is never reimplemented in JSON formatting. Results never contain composition bodies, prompts or outputs.
- Stage 4C adds read-only inspection. `wax composition revisions` reads `<state-dir>/revisions.jsonl` (default `~/.wax`), filters by `--composition`, keeps the newest `--limit` matches (default 50, max 1000) and fails on any malformed line instead of skipping it. The reader whitelists the six audit fields, so a corrupt line can never leak a composition body. `wax composition recover <file>` scans the same directory for `.<basename>.tmp-*` candidates and reports each as valid or invalid; it never renames, deletes or overwrites anything, and has no `--apply`.
- The old flow/composition/workbench/delegation/web orchestration has been removed. `src/` keeps the runtime plus the adapter/session infrastructure it uses.
- `wax run` and `wax daemon` accept `--harness codex|dsh`; dsh requires `--dsh-root <path>` or `DSH_ROOT` (no implicit default), and each per-harness override is rejected on the other harness.
- Scheduled `user` triggers remain deferred. Optional branches, object/array combine, and merge timeouts remain open; the next step is an owner review of the Stage 3C work.

## Repository layout

```text
README.md            you are here
ARCHITECTURE.md      target runtime model
CONTRACT.md          composition file, runtime state, validation, CLI
src/runtime/         the implemented single-Pheromone runtime
src/forager.ts       Workspace -> NodeExecutor bridge
src/cli.ts           `wax run` / `wax daemon` / `wax composition` CLI entry
src/composition-cli.ts  `wax composition validate|replace` argument parsing and exit codes
src/composition-tool.ts transport-neutral typed result layer behind `--json`
src/composition-edit.ts atomic composition replace, Honey/lock checks, revision audit
src/composition-audit.ts read-only revision audit and orphan-temp inspection
src/daemon.ts        foreground daemon for one composition's schedule
src/scheduler.ts     durable at/every occurrence scheduler
src/daemon-lock.ts   per-composition daemon lock
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

The one-shot CLI runs one composition through a native harness:

```bash
npm run wax -- run composition.json --project . --harness codex --trigger plan --input "why is the sky blue"
npm run wax -- run composition.json --project . --harness dsh --dsh-root <path-to-deepseek-harness> --trigger plan --input "why is the sky blue"
```

It triggers one node, pumps the graph to Rest, and prints the node states, a log
summary, and the final output. `user` nodes prompt on stdin; a non-interactive
stdin is refused instead of answered. The run persists Honey and can be
continued with `--resume` (`--state-dir` and `--apiary` override the location).
`--harness dsh` requires `--dsh-root` (or the `DSH_ROOT` environment variable); there is no implicit checkout path.

The daemon runs one composition's `triggers` until interrupted:

```bash
npm run wax -- daemon composition.json --project . --harness codex
```

`--state-dir`, `--apiary`, `--codex-exe` and `--dsh-root` have the same meanings
as for `wax run`. A second daemon for the same composition is refused while the
lock is live. The process serves no HTTP API and has no UI.

The offline composition editor never starts a daemon or a harness:

```bash
npm run wax -- composition validate composition.json
npm run wax -- composition replace composition.json --with next.json --state-dir ~/.wax --apiary demo
npm run wax -- composition revisions --state-dir ~/.wax --composition demo --limit 20
npm run wax -- composition recover composition.json --json
npm run wax -- composition validate --json composition.json
npm run wax -- composition replace --json composition.json --with next.json --apiary demo
```

`validate` only reads and parses. `replace` refuses a different composition id,
any active reference found in the Honey field, and a live or uncertain daemon
lock; it writes through a same-directory temp file plus rename and appends one
metadata-only revision audit line. A stale lock is left in place. Without
`--apiary`, `replace` reports that active references were not checked.

`revisions` reads the same audit read-only. A missing audit file is an empty
list, and any malformed line is a parse failure with exit 1 instead of a silent
skip. `recover` scans only the composition's directory for
`.<basename>.tmp-*` files and parses each one; it never renames, deletes,
overwrites or applies a recovery.

`--json` keeps the same semantics for an AI caller: stdout is exactly one JSON
object, failures are also printed to stdout as
`{"ok":false,"command":...,"code":...,"error":...}`, and stderr stays empty.
Exit codes remain `0` success, `2` usage/parse-or-refusal, `1` IO, except that a
malformed revision audit line is `parse` with exit 1.

## Design principles

- Preserve native harness semantics.
- Prefer a small, boring, recoverable implementation.
- Do not auto-replay side-effecting operations after uncertain failure.
- Keep the graph editable, but never silently reroute active work.
- Separate runtime state (`PheromoneField`) from durable data (`Honey`) and history (`log`).
