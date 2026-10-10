# Shared project context

## Identity

- **Name:** faac
- **Purpose:** A durable terminal coding agent using hosted free models.
- **Language/runtime:** TypeScript, Node.js 22+, npm, Git.
- **Repository:** https://github.com/consciontologic/faac
- **Owner:** Serhat Akbak (`consciontologic`).

## Key paths

| Concern                         | Path                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| Runtime and canonical contracts | `src/`, `src/types.ts`                                     |
| Curated reviewed baseline       | `data/baseline.json`                                       |
| Deterministic tests             | `tests/*.test.ts`                                          |
| Opted-in authenticated checks   | `tests/live/`                                              |
| Terminal smoke harness          | `scripts/ad-hoc/pty-smoke.py`                              |
| User guide                      | `docs/guides/USAGE.md`                                     |
| Plan and verification           | `docs/planning/ROADMAP.md`, `docs/reports/VERIFICATION.md` |
| Rules and skills                | `AGENTS.md`, `.agents/skills/`                             |
| Operations and workflows        | `xops/`, `.github/workflows/`                              |

## Current context

The application has completed authenticated OpenRouter coding and resume checks. Alternate-model continuation was verified with a clearly labeled injected fault. Groq authenticated fallback and natural quota exhaustion remain unverified. The repository uses agentic-workspace and wfform-style PR-only CI. Any PR into develop and hotfix PRs into main run all five CI jobs. Ordinary develop promotion skips all five, including GitFlow; the coordinator preserves the validated full tree. Exact-tree prior PR evidence is enforced only during explicit release validation. The delivery controller has been removed; Copilot tasks and releases require explicit local/maintainer action.

## Project conventions

Preserve strict free-only inference and provider-neutral sessions. Persist tool intent before execution. Never execute partial streamed calls or silently replay uncertain external side effects. Validate expected file hashes for edits and undo. Never import or execute fetched upstream TypeScript. Keep runtime credentials separate from GitHub task credentials. Follow the full publication policy in `AGENTS.md`.

## Read-only references

The original OmniRoute, agentic-workspace, and wfform checkouts are reference material. Do not modify them as part of faac work. Use faac-owned caches for synchronization and temporary workspaces for tests.

## External dependencies

| Service                         | Credential/configuration                        | Purpose                                    |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| OpenRouter                      | `OPENROUTER_API_KEY` or encrypted vault         | Hosted free-model inference                |
| Groq                            | `GROQ_API_KEY` or vault; Free-plan confirmation | Hosted recurring-free inference            |
| OmniRoute public Git repository | `sync.remote`, optional `sync.branch`           | Validated metadata and adapter monitoring  |
| GitHub Copilot agent tasks      | Process-scoped `FAAC_COPILOT_TOKEN`             | Explicit inexpensive-model repository work |

No secret value belongs in this file. Use [DevOps](../guides/DEVOPS.md) for explicit delegation, eligible PR checks, and release source evidence.
