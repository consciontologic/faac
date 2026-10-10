# Codex setup

Open the faac checkout in a local Codex client and review its project trust/configuration prompts. This repository already includes the generated instruction and role files; there is no faac-local scaffold installer to run.

| Surface                                      | Purpose                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| `AGENTS.md`                                  | Shared operating and publication policy                    |
| `CONVENTIONS.md`, `docs/tracking/context.md` | Project conventions and current context                    |
| `.agents/skills/`                            | Shared skills, including adapters for repository workflows |
| `.codex/agents/`                             | Planner, implementer, reviewer, and verifier roles         |
| `.codex/config.toml`                         | Project runtime defaults; MCP disabled                     |
| `.github/agents/`, `.github/prompts/`        | Shared workflow bodies read by native adapters             |

Models inherit the user's selection. Copilot YAML `tools`, handoffs, or slash names are not Codex APIs. Use the native tools available in the current client. For a workflow named `/plan` in a shared prompt, use the corresponding `avb` skill where the client exposes it. Do not manufacture a tool that is not loaded.

The coordinator owns tracking and publication. Delegated reviewers inspect the complete current diff; verifiers run the relevant checks. Children return evidence rather than staging each other's files. Repository policy and user authorization govern Git writes; role metadata is not permission to bypass them.

To verify the client setup, ask it to report loaded instructions, available skills, and custom agents without changing files. Then run a small read-only review with the reviewer role. No graph-server result should be claimed: [MCP is intentionally disabled](MCP_SETUP.md).

Trust and sandbox enforcement belong to the client. Do not alter global trust, model choices, or credential storage to make a project task run. After cloning to another location, inspect configuration for machine-specific paths before enabling optional integrations.
