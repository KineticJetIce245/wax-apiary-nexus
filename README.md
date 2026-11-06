# WAX Apiary neXus

**WAX Apiary neXus** is a lightweight coordination runtime for composing native AI harnesses — Codex app-server, DeepSeek Harness/ACP, and future harnesses — into live, editable flowgraphs.

It is not a new agent runtime. It keeps each harness native and coordinates them through a shared graph, so a composition can mix agent work, human input, local programs, waits, guards, and forks without reimplementing session logic.

> **Status**: early, usable single-composition runtime. The core, Fork/Merge, Worker/Condition, user input, the daemon scheduler, the composition editor, both harness adapters, session naming, queue backpressure, queue TTL, and read-only inspection are implemented. There is no UI. `npm test` is green (557 tests).
>
> Target model: [`ARCHITECTURE.md`](ARCHITECTURE.md). Composition/command contract: [`CONTRACT.md`](CONTRACT.md).

## Quick start

Node.js 26 LTS + npm:

```bash
npm ci
npm run typecheck
npm test
```

Run one composition through a native harness:

```bash
npm run wax -- run composition.json --project . --harness codex --trigger plan --input "why is the sky blue"
npm run wax -- run composition.json --project . --harness dsh \
  --dsh-root <path-to-deepseek-harness> --trigger plan --input "why is the sky blue"
```

`--state-dir` and `--apiary` override the Honey location. `--harness dsh` requires `--dsh-root` or `DSH_ROOT`; there is no implicit checkout path. `user` nodes prompt on stdin; without a TTY they are refused instead of answered.

Run a daemon for a composition's `triggers`:

```bash
npm run wax -- daemon composition.json --project . --harness codex
```

A second daemon for the same composition is refused while its lock is live. The daemon serves no HTTP API and has no UI.

Answer a running daemon's user hover from another terminal:

```bash
npm run wax -- answer composition.json --project . --node ask --text "looks good"
npm run wax -- answer composition.json --project . --node ask --token hv_... --choice approve
npm run wax -- answer composition.json --project . --node ask --yes
npm run wax -- answer composition.json --project . --node ask --image ./photo.png
npm run wax -- answer composition.json --project . --node ask --file ./report.pdf
```

`wax answer` writes one record under `<honey>/answers/` and never writes the field. The daemon applies it only when it matches the current hover; stale, duplicate, wrong-node, wrong-token and malformed records are logged and dropped.

Inspect persisted state without starting a runtime, daemon or adapter:

```bash
npm run wax -- status composition.json --project . --json
npm run wax -- log composition.json --project . --tail 20 --json
npm run wax -- honey composition.json <conversationId> --project . --tail 50 --json
```

`status` reports composition/revision, node queue/pending/active/hover/join counts, scheduler next-due/fired, daemon lock state, and Honey paths. It never prints prompt, output, Value, hover-token or transcript bodies. `log` prints only the metadata whitelist. `honey` is the only command that prints transcript bodies. All three are read-only; a missing field/log is empty, corrupt data exits 1, and usage errors exit 2.

Offline composition editing:

```bash
npm run wax -- composition validate composition.json
npm run wax -- composition replace composition.json --with next.json --apiary demo
npm run wax -- composition revisions --state-dir ~/.wax --composition demo --limit 20
npm run wax -- composition recover composition.json --json
```

`replace` refuses a different composition id, active references, and a live or uncertain daemon lock. It writes through a same-directory temp file plus rename and appends one metadata-only revision audit line. `revisions` and `recover` are read-only; malformed audit lines fail instead of being skipped.

The same editing service is available as a local MCP stdio server:

```bash
npm run wax -- mcp
```

`wax run` / `wax daemon` also accept `--composition-tools`, which mounts this server as `wax_composition` for the selected harness. It is off by default.

## What works

| Area | Implemented |
| --- | --- |
| Core runtime | `PheromoneField`, trigger, terminal/Rest, node queue/pending, `minIntervalMs`, `Condition`, `Counter`, `user` hovers, Guard hovers |
| Flow control | Explicit Fork/Merge/Branch, optional Merge branches, Merge timeout, structured object/array combine, nested Fork/Merge lineage, persisted join tombstones |
| Human input | text/choice/boolean/message/image/file answers, interactive CLI, `wax answer` inbox, scheduled `user` targets |
| Local work | Worker argv-only (`shell: false`), project-contained cwd, 60s timeout, 64 KiB stream caps, process-tree kill; worker `Condition` |
| Durability | Honey field/scheduler/transcripts, `--resume`, unknown-active recovery semantics, live-edit reference protection |
| Scheduling | `at` / `every` triggers, at-most-once occurrence bookkeeping, missed intervals fire once, per-composition daemon lock, SIGINT/SIGTERM shutdown |
| Editing | `composition validate/replace/revisions/recover`, active-reference guards, revision audit, JSON results, MCP tools |
| Harnesses | Codex app-server and DSH ACP adapters behind one Workspace/Forager bridge; explicit harness selection |
| Session identity | Unified alias `wax-apiary-nexus-session-<apiary>-<composition>`; Codex native thread names and existing-project reuse; DSH native title plus Workspace adoption through a workspace-owned Cordis plugin |
| Backpressure / TTL | `queueMax` pre-consumption preflight with reserved output slots; hover answers and Merge joins survive a full downstream queue; `queueTtlMs` expires queue/pending entries on pump/restore |
| Inspection | Read-only `status` / `log` / `honey`; field/scheduler/daemon-lock snapshot; metadata-only log whitelist; transcript bodies only through `honey` |

## Concepts

| Term | Meaning |
| --- | --- |
| Apiary | A project/workspace containing one or more compositions. |
| Composition | A live graph of nodes and edges, stored as JSON. |
| Pheromone | A short-lived Value moving through the graph. |
| PheromoneField | The runtime state: node queues, pending/active slots, hovers, joins, Rest. |
| Forager / Worker | Harness task node / local argv task node. |
| Fork / Merge / Branch | Explicit fan-out, join, and branch tags; no implicit multi-edge fan-out. |
| Guard | Native tool approval or graph-level human review, represented as a hover. |
| Hover | A stable wait state; user and guard hovers are persisted and resumed. |
| Honey | Durable state, transcripts, and artifacts. |
| log | Separate append-only metadata history; no prompt/output bodies. |
| Rest | The field is quiet: no queue, pending, active, hover, or incomplete join. |

There is no End node. A node with no outgoing edge is terminal. There is no persistent cursor or Run object.

## Commands

| Command | Purpose |
| --- | --- |
| `wax run <composition.json> ...` | Trigger one node, pump to Rest, print node state/output. |
| `wax daemon <composition.json> ...` | Run the composition's scheduled triggers in the foreground. |
| `wax answer <composition.json> ...` | Write an answer for a running user hover; never writes the field. |
| `wax status <composition.json> ...` | Read-only field/scheduler/lock snapshot; no bodies. |
| `wax log <composition.json> ...` | Read-only metadata log tail; no bodies. |
| `wax honey <composition.json> <conversationId>` | Read-only transcript tail; the only inspection command with bodies. |
| `wax composition validate <file>` | Parse and validate; read-only. |
| `wax composition replace <file> --with <next>` | Guarded atomic edit with active-reference/lock checks and audit. |
| `wax composition revisions ...` | Read the revision audit; malformed lines fail. |
| `wax composition recover <file>` | Inspect orphan temp files; never applies. |
| `wax mcp` | Local JSON-RPC MCP server for the composition tools. |

`--json` on the composition commands writes exactly one object to stdout and nothing to stderr; exit codes are `0` success, `2` usage/parse/refusal, `1` IO.

## Repository layout

```text
ARCHITECTURE.md      target runtime model
CONTRACT.md          composition file, runtime state, validation, CLI
src/runtime/         PheromoneField, composition parsing, logging, Worker
src/adapters/        Codex app-server and DSH ACP adapters
src/cli/             CLI entry, read-only inspection, and MCP server
src/daemon/          foreground daemon, per-composition lock, scheduler
src/composition/     offline editor, audit, MCP config, revision references
src/session/         workspace lifecycle, Forager bridge, Codex connection
src/project/         project kernel and project-directory checks
src/storage/         Honey, conversation store, artifact store
src/input/           answer/approval inboxes and the shared answer parser
src/shared/          shared content types and envelopes
tests/               runtime, adapter, CLI and infrastructure tests
legacy-contract/     historical adapter/flow contracts
```

## Known limits

- `queueMax` counts `queue + reserved` only; `pending` and `active` are not included, so a node can briefly hold up to `queueMax + 2` inputs.
- Queue reservations are process-local. A crash with an active task keeps the existing unknown/no-replay semantics.
- `queueTtlMs` is checked on pump and restore, not by a wall-clock timer. A CLI blocked in `askUser`, or a long active task, delays cleanup of other node queues until the next pump; the daemon heartbeats every 500 ms.
- One `wax run` uses one native conversation for all Forager nodes. Cross-session handoff currently requires two runs; per-node sessions are not implemented.
- The DSH bridge plugin and its patch files live in `unified-workspace/dsh-plugins`, not in this repository. Workspace adoption runs only in the DSH web process and attaches ungrouped Sessions whose cwd exactly matches an existing Workspace; it never creates one.
- `status.joins` counts persisted join records including closed tombstones; it is not a count of currently waiting joins. `status.scheduler.fired` counts consumed one-shot `at` triggers only; `every` triggers do not persist a fired count.
- Inspection reads the current `log.jsonl` and transcript file, not rotated segments. `status`/`log`/`honey` report failures on stderr with exit 1/2; they do not emit the composition commands' `{ok:false}` JSON error object.
- The 3-level mid-flight Honey save/load restart is covered by a deterministic test; a real OS process kill during active native work is still unverified.
- No UI. Real edge verification still pending: native Codex MCP tool call, DSH graceful SIGINT, OS restart during a scheduled timer, and process-kill mid-flight.

## Next

1. Real native edge verification for the gaps above.
2. Optional UI only after the read-only observability surface is stable.

## Design principles

- Preserve native harness semantics.
- Prefer a small, boring, recoverable implementation.
- Do not auto-replay side-effecting operations after uncertain failure.
- Keep the graph editable, but never silently reroute active work.
- Separate runtime state (`PheromoneField`) from durable data (`Honey`) and history (`log`).
