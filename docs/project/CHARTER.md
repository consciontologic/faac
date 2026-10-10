# faac charter

## Purpose

Make a useful terminal coding assistant available through hosted free-model allowances, with work that survives model and process failures.

## In scope

- Natural-language coding in the selected workspace: inspect files, edit safely, run approved commands, and inspect results.
- Durable sessions, incremental tool records, conflict detection, and automatic eligible-model fallback.
- Official OpenRouter and Groq integration with explicit free eligibility, credentials, capabilities, and shared quota accounting.
- Validated, atomic updates from a dedicated OmniRoute Git cache.
- An accessible terminal, documented CLI, automated checks, reproducible packages, and reviewable AI-assisted development.

## Out of scope

Paid inference fallback, browser impersonation, local-model hosting, unrestricted autonomous shell access, and arbitrary automatic repair of changed upstream APIs. Checkpoints are not a replacement for Git or backups. The project does not reproduce OmniRoute's private Radar backend.

## Audience

Developers running the CLI in their own workspaces; contributors maintaining the TypeScript application; maintainers operating GitHub workflows and releases.

## Success criteria

A real authenticated coding task edits files and runs tests; a restarted process resumes it; fallback preserves completed edits; deterministic failure tests pass; packaging installs a working command. Verification distinguishes live inference, injected faults, and untested integrations.

## Constraints and trade-offs

Node.js 22+ and Git are required. The first supported verification environment is Linux. Other platforms must earn their support claims through tests. Shell commands use the host shell without a sandbox. Small, reviewed provider adapters are preferred over broad unsupported integration coverage. Context compaction is explicit and may omit older detail from a model request.

Project owner: [Serhat Akbak](https://github.com/consciontologic). License: [MIT](../../LICENSE).
