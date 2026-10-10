# Changelog

Changes use semantic versions. Dated verification remains in [reports](docs/reports/README.md).

## Unreleased

- Remove the delivery workflow/controller and automatic label-driven tasks, repairs, merges, promotions, backmerges, and release dispatch at the owner's request.
- Run all five CI jobs only for any PR into `develop` or a hotfix PR into `main`; skip every job on ordinary main promotion and remove push, merge, scheduled, and manual CI duplication.
- Validate exact-tree prior PR evidence only during explicit release publication, without rerunning tests, smokes, or scanners.
- Retain explicit local MAI-Code-1.1-Flash delegation with one submission and a durable receipt.

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

Published artifact and naming-migration evidence is recorded in [verification](docs/reports/VERIFICATION.md). No npm registry publication is configured.
