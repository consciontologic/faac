# AI delivery, releases, and containers

The workflows delegate routine work while retaining deterministic checks, explicit model choice, and a visible audit trail. Installing workflow files does not activate missing credentials or grant a Copilot account entitlement.

## Everyday flow

1. Create a clear issue: requested behavior, scope, acceptance checks, and relevant files.
2. Add a `kind:` label and the maintainer-authorized `ai:task` label.
3. The controller snapshots the request and submits one Copilot task using `mai-code-1.1-flash`.
4. Copilot opens a PR. Checks and native Copilot review run under the configured account permissions.
5. Add `ai:merge` when the PR is authorized to merge after its gates pass. Add `ai:pause` to stop automation.

Features, bug fixes, and release preparation target `develop`; hotfixes target `main`. Read [GitFlow](GITFLOW.md) for branches and local worktrees.

| Label           | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `ai:task`       | A trusted maintainer authorizes the issue's current request       |
| `kind:feature`  | Feature work; also the default kind                               |
| `kind:bugfix`   | Fix a nonurgent defect                                            |
| `kind:hotfix`   | Fix an urgent `main` defect                                       |
| `kind:release`  | Prepare a release on `develop`                                    |
| `version:0.1.1` | Requested plain semantic version for release preparation          |
| `ai:merge`      | Authorize merge after required checks and review gates pass       |
| `ai:release`    | Authorize release dispatch for the exact PR head targeting `main` |
| `ai:pause`      | Pause controller actions on that issue or PR                      |

A changed issue prompt is not silently resubmitted under the old authorization. Create a new authorized issue for changed work. A changed PR head invalidates `ai:release` authorization: remove and re-add the label to authorize the new head. Fork PRs are not automatically repaired or merged.

## Configure hosted automation

Store durable credentials in **GitHub repository Actions secrets**, not files or issue text:

| Secret                  | Purpose                                                    | Required access                                                                                                  |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `FAAC_COPILOT_TOKEN`    | GitHub Agent Tasks API using the explicit task model       | A user token with Agent tasks read/write and access to the repository; endpoint/account eligibility also applies |
| `FAAC_AUTOMATION_TOKEN` | PR lifecycle, review requests, merge, and release dispatch | Repository contents, issues, pull requests, and Actions read/write; Administration read; Checks read             |

Administration read is used to inspect branch protection; Checks read retrieves check runs for the exact PR head. These are read permissions, not authorization to weaken repository policy.

Use the narrowest repository access. A temporary setup token is not automatically installed as an Actions secret. The built-in `GITHUB_TOKEN` can perform some limited work, but is not a substitute for Agent Tasks access; PR workflows created through limited tokens can require approval. The controller reports missing credentials or permissions rather than fabricating progress.

Enable Actions and the required Copilot coding/review features for the repository/account. GitHub's Agent Tasks endpoint eligibility may depend on the plan or organization configuration. The review model itself is selected by GitHub, not pinned to the task model. Where available, select **Lite** native review effort in GitHub settings. See [model policy](MODEL_PROFILES.md) and [the checked-in policy](../../.github/copilot-model-policy.json).

The controller uses trusted `main` code for privileged events; it does not check out or execute an untrusted PR head with its secrets. Required checks are **Quality, Package, Container, Security, and GitFlow**. Native AI review and the merge controller are additional gates; an AI comment is not a substitute for a passing test.

## Costs, retries, and timing

The default policy permits one initial task per authorized issue, one repair per PR, three native review requests per PR, and at most two billable actions in a controller run. There is no `Auto` selection, alternate premium model, or indefinite retry loop. The policy stops if MAI-Code-1.1-Flash is unavailable for the account.

Intent and result receipts prevent duplicate submissions. A timeout after submission remains uncertain until reconciled; do not delete its receipt to force a retry. Inspect the issue, task, and PR state first. Fresh authorization is required for genuinely new work.

Reconciliation runs on relevant issue/PR/check events and hourly. Review completion can wait for the next hourly pass. To reconcile sooner, use Actions → **AI delivery** → **Run workflow**. Leave `issue_number` empty for the existing queue, or provide an existing issue/PR to authorize it. There are no custom slash-comment commands.

## Delegate from your terminal

Write a plain-text task file outside tracked source or under ignored `.local/`:

```bash
mkdir -p .local
cat > .local/task.md <<'TASK'
Improve the error shown for an unknown slash command.
Keep existing command behavior. Add a focused regression test and run make check.
TASK
make ai.plan KIND=feature PROMPT_FILE=.local/task.md
make ai.status
```

The plan command prepares JSON without submitting work. With `FAAC_COPILOT_TOKEN` supplied securely in your environment:

```bash
make ai.submit KIND=feature PROMPT_FILE=.local/task.md \
  RECEIPT=.local/clearer-command-task.json
```

The receipt path must be new. For release preparation, add `KIND=release RELEASE_VERSION=0.1.1`. For a local worktree rather than a remote AI task, use `make gitflow`; see [GitFlow](GITFLOW.md).

## Release a version

First merge a reviewed version change to `main`. `package.json` and the lockfile must agree. Update the changelog and keep checks green. The requested version below must match the current package version.

```bash
gh workflow run release.yml --ref main -f version=0.1.0
```

Alternatively, authorize the exact promotion/hotfix PR with `ai:release`. After merge, the controller dispatches `release.yml` only if that merge commit is still current `main`, using the committed package version. `ai:merge` alone does not publish a release. A matching `vMAJOR.MINOR.PATCH` tag also triggers the release workflow.

The workflow validates the source revision, runs application/terminal/package/container checks, creates a draft release, publishes tested artifacts, and then makes the release public. Artifacts are:

- `faac-VERSION.tgz`: installable npm tarball.
- `faac-VERSION.cdx.json`: CycloneDX inventory of locked production npm dependencies.
- `SHA256SUMS`: asset checksums.
- `ghcr.io/consciontologic/faac:VERSION` and a commit-specific tag; `latest` updates after release completion.

The workflow uses GitHub's release environment, package permission, and provenance attestations. Environment approval rules are controlled in GitHub settings. The hosted release builds Linux AMD64 images; local Docker builds use the host's architecture. No npm registry publication is configured. The npm inventory does not describe operating-system packages in the container.

## Build and test artifacts locally

```bash
make package
make package.test
make image
make image.test
```

Package assets land in `build/package/`. The image smoke test uses `faac:local`, so build it first. An installed tarball can be tested without a global registry publication. CI artifacts and a local image are not proof that a public release exists. If publication fails after artifacts exist, rerun the failed publication job so it reuses those same artifacts; do not rebuild different contents under an immutable version.

## Run the container

The image includes Node.js 22, Git, Bash, ripgrep, and Python. It runs the `faac` entrypoint as a nonroot user, with `/workspace` as the working directory. Add project-specific toolchains in a derived image when needed.

For a local build, use `faac:local`:

```bash
mkdir -p "$HOME/.local/share/faac"
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/workspace" \
  --mount "type=bind,src=$HOME/.local/share/faac,dst=/state" \
  --env FAAC_HOME=/state \
  --env HOME=/state/home \
  --env OPENROUTER_API_KEY \
  faac:local
```

`OPENROUTER_API_KEY` must already be set securely if you use that option; otherwise connect through the hidden prompt and persist the encrypted vault in the mounted state directory. Replace `faac:local` with `ghcr.io/consciontologic/faac:0.1.0` only after that version has been published. Avoid putting a literal key on the command line.

The workspace mount allows edits to the host files you chose. The state mount preserves sessions across container exits. The container contains a shell but is not a security boundary for arbitrary mounted files or forwarded credentials. Do not mount the Docker socket into an agent workspace.

## Diagnose a stopped workflow

Inspect Actions logs, the receipt, and the PR checks. Missing token/model access needs account configuration; a failed deterministic check needs a code fix; an uncertain submission needs reconciliation. Exhausted repair or review budgets stop automatically and need a deliberate new task. Keep the recorded evidence intact rather than repeatedly clicking retry.
