# Branches and pull requests

`main` is the release branch. `develop` collects the next release. Routine work goes through pull requests; protected branches are not direct-push destinations.

| Work                | Start from | PR target                                  |
| ------------------- | ---------- | ------------------------------------------ |
| Feature             | `develop`  | `develop`                                  |
| Bug fix             | `develop`  | `develop`                                  |
| Release preparation | `develop`  | `develop`, followed by promotion to `main` |
| Urgent hotfix       | `main`     | `main`, followed by backmerge to `develop` |
| Release promotion   | `develop`  | `main`                                     |
| Backmerge           | `main`     | `develop`                                  |

## Start work

These commands first show the planned branch and worktree. Add `APPLY=1` only when ready to create it.

```bash
make gitflow KIND=feature NAME=clearer-errors AGENT=codex
make gitflow KIND=feature NAME=clearer-errors AGENT=codex APPLY=1
make gitflow KIND=bugfix NAME=resume-conflict AGENT=codex
make gitflow KIND=hotfix NAME=credential-redaction AGENT=codex
make gitflow KIND=release NAME=0.1.1 AGENT=codex
```

The applied feature example creates `codex/feature/clearer-errors` from `origin/develop` in `.local/worktrees/codex-feature-clearer-errors`. It fetches before creation and preserves the original checkout. Release names require plain `MAJOR.MINOR.PATCH`. Copilot and Dependabot use their service-generated branch names; the GitFlow check handles their permitted targets.

## Publish a branch

Follow [AGENTS.md](../../AGENTS.md): inspect the current diff, run checks, obtain review, record tracking, then use the guarded publisher. Do not use it to bypass protected branches.

```bash
make check
make git.dry
make git
```

`make git.dry` is read-only. `make git` commits tracked staged work under the repository policy and pushes only an allowed work branch. Conflicts, detached state, unrelated work, or missing authorization must be resolved before publishing. Never force-push or overwrite a user's work to make a lane pass.

Open a PR to the target in the table. The required checks are **Quality, Package, Container, Security, and GitFlow**. Branch protection requires them on the reviewed change. AI merge authorization is separate: [DevOps](DEVOPS.md) describes `ai:merge`, review gating, and the repair budget.

## Releases

A release-preparation PR updates version metadata and the changelog on `develop`. After it merges, promotion moves `develop` to `main`. The release workflow checks the version against current `main`, builds and verifies artifacts, then publishes a GitHub release and GHCR image. A hotfix or release on `main` gets a backmerge PR so `develop` retains it.

Merging a PR does not automatically authorize a public release. Use the dedicated `ai:release` label on the exact PR head, or dispatch the release workflow explicitly as described in [DevOps](DEVOPS.md#release-a-version).
