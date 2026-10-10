# Contributing

Start with [development setup](docs/guides/DEVELOPMENT.md) and [AGENTS.md](AGENTS.md). The [architecture](docs/code/ARCHITECTURE.md) explains runtime boundaries; the [DevOps guide](docs/guides/DEVOPS.md) explains branches and AI-assisted PRs.

1. Open an issue describing the behavior and a way to verify it.
2. Use a feature or bugfix branch based on `develop`; use the documented hotfix path for urgent `main` fixes.
3. Preserve unrelated changes. Add meaningful tests with behavior changes.
4. Run `make check`, `make build`, and the focused checks relevant to your change.
5. Record the change in tracking when working as an agent, inspect the complete diff, and open a PR to the correct base.

Use Conventional Commits in change summaries and PR titles. Explain the problem, resulting behavior, and actual validation. Do not present fixture responses as live hosted inference, or an injected interruption as a natural quota failure. Keep credentials and private transcripts out of patches and issue comments.

Provider changes must preserve free-only eligibility, tool completeness, failure scope, shared quotas, and work preservation. Unknown billing or API behavior is a reason to exclude a route until reviewed.

Before proposing a security-sensitive change, read [SECURITY.md](SECURITY.md). Contributions retain the project's MIT license and required third-party notices.
