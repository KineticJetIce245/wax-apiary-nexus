# Unified Workspace — AI Engineering Contract

## Mission

Implement Unified Workspace incrementally, prioritizing evidence-based architecture validation over feature completeness.

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

### 4. Verification Required

Every completed experiment must provide:

- Reproduction instructions.
- Actual commands executed and results.
- Relevant environment and dependency versions.
- Test results and limitations.
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
- A security or data-integrity risk is discovered.
- A proposed change crosses an architectural boundary.
- The next step requires a major irreversible decision.

## Definition of Done

A milestone is complete only when its stated acceptance criteria are demonstrated with reproducible evidence.

Code generation alone does not constitute completion.

# Unified Workspace — Anti-Overengineering Rules

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

## Guiding Principle

**A boring, understandable implementation that works is better than an elegant framework nobody needs.**
