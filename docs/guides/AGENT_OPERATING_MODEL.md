# Working with AI agents

faac uses the agentic-workspace scaffold for development instructions, reusable skills, task tracking, and recovery. This is repository tooling; it is separate from the sessions saved by the faac CLI.

## One rulebook

Read [AGENTS.md](../../AGENTS.md), [project context](../tracking/context.md), and the relevant skill before changing files. Search before creating another config or document. Existing user changes, credentials, and external reference checkouts must be preserved.

## The working loop

1. Inspect instructions, recovery state, and the current diff.
2. Choose a bounded task and acceptance checks.
3. Implement with matching tests; save long-running command logs through `xops/agent/safe-run.sh`.
4. Obtain a separate review where available; fix findings and run verification.
5. The coordinating agent records tracking and publishes only through the authorization and branch policy in AGENTS.md.

Children return evidence and do not stage another agent's files. A failed gate starts diagnosis, not a blanket reset. An interrupted task leaves a checkpoint with the remaining work and next action.

## Delegation and limits

Routine issue implementation, repair, review requests, and eligible PR merging can use the controlled GitHub automation in [DevOps](DEVOPS.md). Labels and workflow triggers provide explicit scope. Model selection and budgets are constrained by [model policy](MODEL_PROFILES.md). Account permissions and installed secrets determine what actually runs.

AI review does not replace tests or branch protection. Do not claim approval, a live request, an image publication, or a release unless its actual result was observed. Never fabricate human review or bypass unavailable checks.

For local Codex roles, see [Codex setup](CODEX_SETUP.md). MCP was not enabled during this scaffold; use [the current setup notes](MCP_SETUP.md) rather than assuming a graph server exists.
