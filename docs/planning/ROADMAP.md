# Roadmap

This is the sequenced project plan. Checked items are implemented; remaining live or hosted verification stays explicit.

| Phase                                 | State                                                  |
| ------------------------------------- | ------------------------------------------------------ |
| 1. Terminal coding agent              | Implemented and tested                                 |
| 2. Preservation and free-only routing | Implemented; live cross-provider evidence pending      |
| 3. Upstream synchronization           | Implemented and tested                                 |
| 4. Repository delivery                | Configured and locally verified; hosted checks pending |
| 5. Additional live evidence           | Requires external accounts/quota conditions            |

## Phase 1 — Terminal coding agent

Scope: `runtime`. Acceptance: typecheck, deterministic tools/commands tests, real PTY checks, and an authenticated coding task.

- [x] Run in the launch directory or an explicitly selected workspace.
- [x] Read, search, edit, patch, and run approved shell commands with results.
- [x] Provide multiline input, history, completion, streaming Markdown, diffs, cancellation, and accessible output.
- [x] Implement the documented slash commands and validated capability-aware settings.
- [x] Execute a real OpenRouter coding task and verify generated behavior independently.

## Phase 2 — Durable work and free-only routing

Scope: `resilience`. Acceptance: crash/conflict/fault tests and a restarted real coding session.

- [x] Persist session instructions, messages, actions, edits, hashes, attempts, and compaction incrementally.
- [x] Reconcile ambiguous actions and refuse incomplete tool calls and concurrent overwrites.
- [x] Enforce free eligibility, scoped failures, shared quotas, backoff, and circuit recovery.
- [x] Preserve completed edits across fallback and expose blocked retry state.
- [x] Resume a real saved objective in another process without a replacement prompt.
- [x] Verify real alternate-model inference after a deliberately injected interruption.

## Phase 3 — Upstream synchronization

Scope: `sync`. Acceptance: real Git fixture tests and a public upstream fetch.

- [x] Use a dedicated cache; leave the reference checkout unchanged.
- [x] Monitor required catalogs and reviewed adapter dependencies.
- [x] Extract validated literals and apply explicitly compatible changes.
- [x] Quarantine unknown semantic changes; activate atomically and retain rollback state.
- [x] Pin request snapshots and verify locking, corruption recovery, and failed-fetch handling.

## Phase 4 — Repository delivery

Scope: `delivery`. Acceptance: repository checks, package/container smoke tests, workflow checks, and verified GitHub settings.

- [x] Create the public repository and project metadata.
- [x] Apply agentic-workspace and replace documentation templates with faac documents.
- [x] Validate GitFlow checks, branch publication tooling, and AI task/review controllers.
- [x] Validate package assets and container setup through their smoke tests.
- [ ] Publish and verify protected main/develop branches and required workflow checks.
- [ ] Configure durable automation credentials and verify an actual Copilot task/review run.

## Phase 5 — Additional live evidence

Scope: `live-validation`. These are explicit evidence gaps, not claims of missing deterministic coverage.

- [ ] Verify Groq authenticated coding with a confirmed Free-plan account.
- [ ] Verify authenticated fallback between providers while preserving tool state.
- [ ] Observe a natural quota-triggered fallback and record the actual failure scope.
- [ ] Verify a tagged GitHub release and published GHCR image from the installed workflow.

## Completion discipline

Tests and docs move with changes. The coordinator records tracking and follows [AGENTS.md](../../AGENTS.md) for publication. Failed gates require diagnosis and repair; preserving unrelated work is mandatory. Record externally blocked steps and the next action instead of marking them complete. `make roadmap.status` summarizes checkbox progress.
