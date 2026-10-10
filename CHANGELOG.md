# Changelog

All notable changes to faac are documented in this file.

Entries follow [Keep a Changelog](https://keepachangelog.com/) and use bare semantic versions. Dated verification remains in [reports](docs/reports/README.md). No npm registry publication is configured.

## [Unreleased]

## [0.1.2] - 2026-10-10

### Changed

- Use curated, dated changelog entries as GitHub release notes, with an Unreleased section for changes awaiting the next version.

### Fixed

- Restore GitHub deployment visibility by recording package publication in the `release` environment, linked to the published release. This records publication; no application server is deployed.

## [0.1.1] - 2026-10-10

### Added

- Adopt the agentic-workspace scaffold with filled project, architecture, design, and contributor documentation.
- Add guarded GitFlow, cost-controlled Copilot delegation, review gates, and repository policy.
- Add deterministic CI, package smoke checks, container builds, and GitHub release/GHCR publication workflows.

### Changed

- Run all five CI jobs only for any PR into `develop` or a hotfix PR into `main`; skip every job on ordinary main promotion and remove push, merge, scheduled, and manual CI duplication.
- Validate exact-tree prior PR evidence only during explicit release publication, without rerunning tests, smokes, or scanners.
- Publish package releases without a GitHub deployment environment and name each run by its semantic version.
- Retain explicit local MAI-Code-1.1-Flash delegation with one submission and a durable receipt.
- Reorganize existing usage, synchronization, attribution, and verification documents without discarding their evidence.

### Removed

- Remove the delivery workflow/controller and automatic label-driven tasks, repairs, merges, promotions, backmerges, and release dispatch at the owner's request.

### Fixed

- Preserve readable Markdown summaries under hosted ShellCheck and pin release-evidence reads to the API contract that exposes merge commits.

## [0.1.0] - 2026-10-10

### Added

- Terminal coding agent using official hosted OpenRouter and Groq adapters with strict free-only routing.
- Durable sessions, automatic eligible-model fallback, scoped quotas/cooldowns, and explicit context compaction.
- File tools with hash conflict checks, approved shell commands, checkpoints, and reversible edit undo.
- Interactive input, streaming Markdown, diffs, slash commands, configuration, and encrypted credentials.
- Validated Git synchronization of supported OmniRoute metadata with quarantine and rollback.
- Deterministic, PTY, and separately authenticated OpenRouter coding/resume verification.

Published artifact and naming-migration evidence is recorded in [verification](docs/reports/VERIFICATION.md).
