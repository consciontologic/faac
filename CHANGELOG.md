# Changelog

Changes use semantic versions. Dated verification remains in [reports](docs/reports/README.md).

## Unreleased

- Adopt the agentic-workspace scaffold with filled project, architecture, design, and contributor documentation.
- Add guarded GitFlow, cost-controlled Copilot delegation, review gates, and repository policy.
- Add deterministic CI, package smoke checks, container builds, and GitHub release/GHCR publication workflows.
- Reorganize existing usage, synchronization, attribution, and verification documents without discarding their evidence.

## 0.1.0 — initial implementation

- Terminal coding agent using official hosted OpenRouter and Groq adapters with strict free-only routing.
- Durable sessions, automatic eligible-model fallback, scoped quotas/cooldowns, and explicit context compaction.
- File tools with hash conflict checks, approved shell commands, checkpoints, and reversible edit undo.
- Interactive input, streaming Markdown, diffs, slash commands, configuration, and encrypted credentials.
- Validated Git synchronization of supported OmniRoute metadata with quarantine and rollback.
- Deterministic, PTY, and separately authenticated OpenRouter coding/resume verification.

This entry records the implemented package version; it does not claim that a GitHub release or npm registry publication already exists.
