# WAX Apiary neXus — AI Engineering Contract

## Mission

Implement WAX Apiary neXus incrementally, prioritizing evidence-based architecture validation over feature completeness.

You are responsible for research, implementation, testing, documentation, and reporting.

The human project owner retains authority over major architecture decisions and scope changes.

## Rules

### 1. Evidence Before Abstraction

Do not design generalized interfaces based solely on assumed Harness capabilities.

Validate real Harness behavior before finalizing Adapter contracts.

Distinguish observed behavior, documented guarantees, assumptions, and unsupported capabilities.

### 2. Vertical Slices First

Prefer the smallest executable experiment that validates a critical architectural hypothesis.

Do not build infrastructure that is unnecessary for the current experiment.

### 3. No Silent Architecture Decisions

Request approval before:

- Selecting a foundational framework or runtime.
- Introducing major architectural abstractions.
- Changing the core object model.
- Adding dependencies that materially affect the system.
- Changing persistence, concurrency, or permission semantics.
- Expanding the approved project scope.

When evidence invalidates an assumption the current design depends on, or when
ownership of a control point, queue, or source of truth is ambiguous, stop and
ask the owner before reinterpreting or changing the design. Present the observed
evidence, the assumption it contradicts, the viable options and tradeoffs, and
what remains unverified. Do not present a new boundary as if it were the
original design.

### 4. Verification Required

Every completed experiment must provide:

- Reproduction instructions.
- Actual commands executed and results.
- Relevant environment and dependency versions.
- Test results and limitations.
- At least one real test (Rule 9) executed against the real entry point and the
  topology the requirement names, not only unit tests.
- Observed failures and unresolved risks.
- Evidence supporting or contradicting the hypothesis.

Never report a test as passed unless it was actually executed.

### 5. Preserve Native Harness Semantics

Do not simulate native session persistence, recovery, or execution behavior and present it as verified native functionality.

Mocks are allowed for isolated unit tests but cannot substitute for native integration tests.

### 6. Explicit Concurrency and Recovery

Do not assume that one Native Conversation can safely accept concurrent execution requests.

Do not automatically replay operations with possible side effects after uncertain failures.

### 7. Maintain Human Comprehension

At the end of each milestone, provide:

- What was implemented.
- Why it was implemented this way.
- Which architecture assumptions were validated.
- Which assumptions remain uncertain.
- What the human owner needs to decide next.

### 8. Stop Conditions

Stop and request review when:

- Evidence contradicts the current architecture.
- A core assumption cannot be verified.
- A control boundary, queue owner, or source of truth is ambiguous.
- A security or data-integrity risk is discovered.
- A proposed change crosses an architectural boundary.
- The next step requires a major irreversible decision.

### 9. Real Tests Are Required

Unit tests with fake adapters are necessary but are not evidence that the
product works. Every milestone, architecture claim, and cross-harness feature
must include at least one **real test** that was actually executed.

A real test:

- Drives the real entry point (`waxd`, `wax`, the control HTTP API, or the
  native adapter) against real native harness processes, not a fake adapter,
  mock workspace, or in-memory substitute.
- Uses the topology the requirement names. For cross-harness behavior this
  means **one graph with at least one Codex session and one DSH session** (or
  another pair of distinct harnesses). Two per-harness graphs, two daemons, or
  a unit test with two fake records do not test cross-harness routing and do
  not count.
- Exercises a realistic end-to-end case (for example load -> trigger ->
  spread/gather -> Rest -> unload/reload), not just an internal function call.
- Uses an unknown-answer prompt (random constraint), never a fixed prompt whose
  answer is already known; it records the actual output and the constraints it
  satisfied.
- Is reproducible: the exact command, non-secret environment assumptions, the
  expected observable shape, and the observed result.

Unit tests, mock-adapter tests, and per-harness-only tests may support a claim
but cannot satisfy it. If a required real test cannot run (missing API key,
missing executable, unavailable harness), report the milestone as unverified
and stop; do not substitute a unit test. A real test that fails once and passes
on rerun is a flake: record both runs and the failure; do not report only the
passing rerun.

### 10. One Progress Code and One Version Name

There is exactly one progress-code scheme: `M<n>` (for example `M8`), with
sub-slice suffixes such as `M4c2c2`. Every new implementation slice, brief,
test, commit message, and active document uses it. `Gxxx` is retired historical
A-era numbering; `Stage n` and `B0-B6` are not progress codes. Do not introduce
a new alphanumeric progress scheme.

There is exactly one version naming: `A` is the legacy single-composition
runtime; `B` is the current coordination fabric. `B-core` is the implemented
core scope of B, not a third version. `B-full` is not a version name; write
"full B" when that scope is meant. Do not add a new version codename without
owner approval.

Active documents use the canonical names. Historical G/Stage material is
removed from `../docs/`; do not recreate a docs archive, review folder, or brief
pile. If an old file is restored for reference, keep it in `../docs/temp/` and
mark it historical.

Local docs: keep at most ten core files in `../docs/`; put each small goal in
`../docs/temp/` and collect or remove it when done.

### 11. Complexity and File Budgets

Source files: 400 lines target, 500 hard. Test files: 600 lines target, 800
hard. A test file may exceed the soft target only when it is table-driven; split
by scenario before the hard limit.

Classes: 250 lines of class body, 12 public methods, 8 constructor dependencies;
one primary responsibility. A class must not combine transport, domain logic,
and persistence. Extra dependencies must be grouped into a sub-service or an
options object, not added to the constructor.

Functions and methods: 50 lines, cyclomatic complexity at most 10, nesting at
most 4, parameters at most 6. Modules: at most 20 exports.

Existing violations may be reduced or left unchanged; new or modified code must
not create a new violation. Exceptions require explicit approval, a written
reason, and a removal slice; no permanent exceptions. Enforcement is
`npm run complexity` once it exists; until then, review manually against these
budgets. The local repair outline maps every existing violation to a target
split.

### 12. Concept Budget

Every new concept — object, identity, registry, tracker, lifecycle, state
machine, layer, or public field — must be justified against the concepts that
already exist.

Before adding one, answer in writing:

- Which existing concept cannot represent this?
- Who exclusively owns the new state?
- When is it released, and who releases it?
- Can it be derived from, or folded into, an existing owner?

Do not add a parallel identity, a shadow registry/tracker, or a second lifecycle
for work an existing owner already represents. Control-plane operations must not
own execution state; their state ends at handoff.

A new concept is an architecture change: update `ARCHITECTURE.md` and obtain
owner approval before implementation. Passing tests, a new name, or a new file
does not prove that a concept is necessary.

### 13. Final design vs temporary design

Architecture and contract documents must separate the final design from temporary
placeholders.

- The main body states only the final design. Do not present current code,
  workarounds, or temporary placeholders as final.
- If a behavior is not defined, say so explicitly ("not defined in the final
  design") and point to the Temporary design section. Do not invent a final rule
  to fill the gap.
- The Temporary design section is first-class: describe the current placeholder
  as fully as a normal design (scope, behavior, entry points, state, recovery,
  observability), mark it temporary, and name what replaces it.
- Current implementation details belong in the current-gap section, not in
  final-design sections.

### 14. Owner-gated refactoring

Do not refactor, restructure, rename, split, or perform a structural cleanup
unless the owner explicitly requests it or approves it in writing. A verified
slice is not permission to start the next structural change. If a refactor seems
useful, propose it and wait; do not perform it while implementing another slice.

### 15. Commit before acting on an objection

When the owner raises an objection to a result, first freeze the current verified
state with a commit (or an explicitly preserved branch when a commit is
impossible), then discuss or change. Do not start refactoring, reverting, or
"fixing" the working tree in the same step as an objection.

A phase that has passed verification must be committed before the next phase
starts. Never begin a new phase on an uncommitted working tree; an uncommitted
"verified" state has no baseline and cannot be recovered reliably.

## Definition of Done

A milestone is complete only when its stated acceptance criteria are demonstrated with reproducible evidence, including at least one real test (Rule 9) executed in this environment.

Code generation and unit tests alone do not constitute completion.

# WAX Apiary neXus — Anti-Overengineering Rules

You are developing a personal, experimental, open-source AI workspace.

The human owner has limited time and delegates nearly all coding, testing, and routine maintenance to AI agents.

Your highest priorities are correctness, simplicity, recoverability, and low maintenance burden.

## Mandatory Rules

1. **Minimal Change:** Implement the smallest correct change that satisfies the current requirement. Avoid unrelated refactoring.
2. **No Speculative Abstractions:** Do not introduce frameworks, services, layers, or dependencies solely for hypothetical future requirements.
3. **Reuse Before Rebuild:** Prefer existing native Harness capabilities and stable APIs.
4. **Root Cause First:** Never stack workarounds without identifying the underlying problem.
5. **Protect Working Code:** Work in isolated branches or worktrees. Preserve a known-good baseline.
6. **Verify, Don't Assume:** Run relevant tests, type checks, and builds. Report what actually ran and what remains unverified.
7. **Complexity Audit:** Before completion, inspect the diff for unnecessary abstractions, dependencies, duplicated logic, and unrelated changes.
8. **Failure Escalation:** After two unsuccessful attempts to fix the same issue, stop patching and reassess the root cause and approach.
9. **No Silent Scope Expansion:** Do not implement unrelated features or expand the architecture without approval.
10. **Maintain Recoverability:** Do not perform destructive operations, irreversible migrations, or risky permission changes without explicit authorization.

## Completion Report

Keep reports concise:

- What changed?
- What was verified?
- What remains uncertain?
- Was any new abstraction or dependency introduced? Why?
- What new concept was introduced, and which existing concept could not cover it?

## Guiding Principle

**Less is good.** Prefer fewer concepts, fewer layers, fewer states, and less code that does the same job.

**A boring, understandable implementation that works is better than an elegant framework nobody needs.**

The Concept Budget (Rule 12) is how this principle is enforced; it is not a matter of taste.

# Sensitive Information and Git Tracking

- Before writing any artifact, decide whether it is public project material or private local material. Do not place credentials, tokens, private keys, personal information, private conversations, machine-specific paths, or private environment details in files that Git tracks.
- Local plans, proposals, research notes, execution reports, and work logs live **outside this repository**, in the parent directory (`../docs/`, `../LOG.md`). Maintain them there; never stage them here. Do not create `docs/` or `LOG.md` inside the repo, and do not add ignore rules for them; the layout, not `.gitignore`, keeps them out of Git. This takes precedence over earlier instructions to commit those documents or logs.
- Ignore files that may contain private data before writing them. Never use `git add -f` to bypass these rules. An ignored path is not sufficient protection if the file is already tracked; check `git ls-files` and remove it from the index with `git rm --cached` while preserving the local file when needed.
- Stage explicit paths rather than using broad staging commands. Inspect the entire staged diff and new files for sensitive content before every commit. Sanitize any public examples and reports; do not echo detected secrets into tool output, commit messages, or review comments.
- A pattern scan is supporting evidence, not a guarantee that a file contains no sensitive information. Report the scope and limitations of the check honestly.
- Ignoring or untracking a file does not remove it from previous commits, other branches, tags, reflogs, or remote copies. If sensitive information is found in history, identify the affected references without repeating the secret, stop publication, and present a concrete history-cleanup plan for owner approval. Do not rewrite history, purge backups, or force-push silently.
