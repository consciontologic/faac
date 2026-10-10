# faac conventions

Read [AGENTS.md](AGENTS.md) for the authoritative policy and [docs/guides/DEVELOPMENT.md](docs/guides/DEVELOPMENT.md) for development commands.

- TypeScript ESM, Node.js 22+, strict typing, two-space indentation, semicolons, and Prettier formatting.
- Keep the CLI runtime in `src/`, deterministic tests in `tests/`, explicitly gated live tests in `tests/live/`, and delivery tooling in `xops/`.
- Keep documentation in the scaffold's subject folders and maintain `docs/README.md`.
- Never introduce a paid provider route, evaluate fetched upstream source, or silently replace concurrent user changes.
- Conventional Commits and tracked, guarded work-branch publication are the normal delivery path. Authorized coordinating agents may publish PRs; `main` and `develop` require the protected PR workflow.
- Report actual verification. Do not count catalog discovery, fixtures, or workflow configuration as live execution evidence.
