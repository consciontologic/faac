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

The application has completed authenticated OpenRouter coding and resume checks. Alternate-model continuation was verified with a clearly labeled injected fault. Groq authenticated fallback and natural quota exhaustion remain unverified. The repository now adopts the agentic-workspace scaffold and GitHub delivery tooling; actual hosted automation depends on account eligibility and configured secrets.

## Project conventions

Preserve strict free-only inference and provider-neutral sessions. Persist tool intent before execution. Never execute partial streamed calls or silently replay uncertain external side effects. Validate expected file hashes for edits and undo. Never import or execute fetched upstream TypeScript. Keep runtime credentials separate from GitHub development automation credentials. Follow the full publication policy in `AGENTS.md`.

## Read-only references

The original OmniRoute, agentic-workspace, and wfform checkouts are reference material. Do not modify them as part of faac work. Use faac-owned caches for synchronization and temporary workspaces for tests.

## External dependencies

| Service                         | Credential/configuration                        | Purpose                                    |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| OpenRouter                      | `OPENROUTER_API_KEY` or encrypted vault         | Hosted free-model inference                |
| Groq                            | `GROQ_API_KEY` or vault; Free-plan confirmation | Hosted recurring-free inference            |
| OmniRoute public Git repository | `sync.remote`, optional `sync.branch`           | Validated metadata and adapter monitoring  |
| GitHub Copilot agent tasks      | `FAAC_COPILOT_TOKEN` in Actions secrets         | Explicit inexpensive-model repository work |
| GitHub automation               | `FAAC_AUTOMATION_TOKEN` in Actions secrets      | PR/review/delivery permissions             |

No secret value belongs in this file. Use [DevOps](../guides/DEVOPS.md) for the distinction between installed workflow files and activated hosted automation.
