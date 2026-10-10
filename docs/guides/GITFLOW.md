# Branches and pull requests

**Work branch → PR → eligible checks → merge → explicit release.**

`develop` collects work; `main` holds releases. Maintainers or explicitly authorized agents coordinate the steps. Labels and completed checks do not dispatch tasks, merge PRs, or start releases.

## Choose a lane

| Work                | Start from                       | PR target                           |
| ------------------- | -------------------------------- | ----------------------------------- |
| Feature or bug fix  | `develop`                        | `develop`                           |
| Release preparation | `develop`                        | `develop`                           |
| Hotfix              | `main`                           | `main`, then backmerge to `develop` |
| Promotion           | Validated `develop`              | `main`                              |
| Backmerge           | `main` or a suitable work branch | `develop`                           |

Any source branch may open a PR into `develop`. Conventional work names keep intent clear. The helper previews without changing Git; `APPLY=1` creates the branch and worktree:

```bash
make gitflow KIND=feature NAME=clearer-errors AGENT=codex
make gitflow KIND=feature NAME=clearer-errors AGENT=codex APPLY=1
make gitflow KIND=hotfix NAME=credential-redaction AGENT=codex
make gitflow KIND=release NAME=0.1.1 AGENT=codex
```

The applied feature example creates `codex/feature/clearer-errors` from `origin/develop` under `.local/worktrees/`. Preserve existing work and reuse a suitable checkout when possible.

## Check, review, and publish

```bash
make verify
make git.dry
make git
```

Follow [AGENTS.md](../../AGENTS.md): record tracking, inspect the staged set, and publish through the guarded wrapper. Do not commit or push directly to protected branches or bypass unavailable checks. Open the PR to the target above. A separate local AI review can help; native Copilot review still has its own account/model limits.

## Exactly when checks run

The five named gates are **Quality, Package, Container, Security, and GitFlow**.

- **Any PR into `develop`:** runs the four quality/package/security jobs and the GitFlow gate.
- **Hotfix PR into `main`:** runs the same checks. Recognized branches are `hotfix/*`, `codex/hotfix/*`, `claude/hotfix/*`, and same-repository `copilot/*` with `work:hotfix`.
- **Ordinary same-repository `develop` → `main` promotion:** skips the four expensive jobs. The lightweight GitFlow gate verifies that the full source tree already passed the required checks in a merged eligible PR.
- **Pushes, merges, schedules, and manual CI dispatch:** do not start another quality/security run.

PR changes and hotfix-label changes update the applicable gate. Promotion must retain the validated tree. If conflict resolution or another edit changes that tree, validate the changed source through `develop` before promotion. A skipped promotion job is not fresh quality evidence; the source-evidence gate supplies that check.

Earlier manual CI runs were diagnostic only. GitHub does not count `workflow_dispatch` job checks as required PR evidence; see [the official rule](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated).

## Publish a release

After the verified promotion or hotfix merges, explicitly dispatch `release.yml` on `main` for the committed version. The publisher validates previous PR evidence, builds the artifacts, and checks archive integrity, checksums, and provenance. It does not rerun tests, smokes, or security scans.

Release names and tags are bare semantic versions, such as `0.1.0`. Assets are `0.1.0.tgz`, `0.1.0.cdx.json`, and `SHA256SUMS`; the image is `ghcr.io/consciontologic/faac:0.1.0`. No `latest` or commit-SHA image aliases are published by future releases. See [DevOps](DEVOPS.md#release-a-version) for the command and recovery.
