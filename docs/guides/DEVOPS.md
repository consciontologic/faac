# PR checks, explicit AI tasks, and releases

faac follows the checked-in wfform-style workflow: prepare work, open a PR, review its evidence, merge, then explicitly publish a release. There is no delivery controller, automatic repair loop, label-triggered merge, scheduled task purchaser, or automatic release dispatch.

## Delegate one task to Copilot

Write a bounded request with allowed files, expected behavior, tests, and the PR target:

```bash
mkdir -p .local
cat > .local/task.md <<'TASK'
Improve the error shown for an unknown slash command.
Keep existing command behavior. Add a focused regression test and run make verify.
Open a PR into develop.
TASK
make ai.plan KIND=feature PROMPT_FILE=.local/task.md
```

The plan command prepares a request without submitting it. Supply `FAAC_COPILOT_TOKEN` securely in the current process, then explicitly submit:

```bash
make ai.submit KIND=feature PROMPT_FILE=.local/task.md \
  RECEIPT=.local/clearer-command-task.json
```

The token needs repository access and GitHub Agent Tasks read/write permission; account entitlement also applies. No permanent Actions secret is needed for this local helper. Never put the value in the task file, command arguments, or Git.

Each submission uses the explicit `mai-code-1.1-flash` model and a new receipt path. It does not fall back to Auto or a premium model. A timeout can mean the request was accepted: inspect the receipt and actual GitHub task before doing anything again. The helper does not upload uncommitted local work.

Use `KIND=bugfix`, `KIND=hotfix`, or `KIND=release` for those tasks. Release preparation also needs `RELEASE_VERSION=0.1.1`. `HEAD_REF` targets an existing authorized work branch when applicable. No background process resubmits, repairs, or advances the PR.

## Review and merge

A maintainer or explicitly authorized coordinating agent requests review, handles supported findings, and merges through the protected PR. Issue labels organize work; they do not authorize external actions. Copilot's `work:hotfix` label selects the same-repository hotfix check lane only.

Native Copilot review chooses its own model; the task model cannot select it. Where the account exposes review effort, Lite is the inexpensive option. Quota failure is not a successful review, including a `COMMENTED` response saying no review was performed. A local AI review is separate evidence and must not be represented as native Copilot approval. See [model selection](MODEL_PROFILES.md).

The required names are **Quality, Package, Container, Security, and GitFlow**. Quality, package, container, and security work runs only on **any PR into `develop`** or a **hotfix PR into `main`**. Ordinary `develop` → `main` promotion skips those jobs and uses a lightweight GitFlow gate to verify the exact tree's prior eligible PR evidence. No push, merge, scheduled, or manual CI duplication is configured. [GitFlow](GITFLOW.md) defines the lanes and the changed-tree recovery path.

## Release a version

Prepare the version/changelog change through `develop`, then promote the already validated tree to `main`. A release uses the current committed version; do not bump it merely to change filenames. After the merged source is ready:

```bash
gh workflow run release.yml --ref main -f version=0.1.1
```

Replace `0.1.1` with the new version actually committed on `main`. Existing `0.1.0` assets are immutable; this example is not an instruction to rebuild or replace them.

Release dispatch is explicit. Neither a tag push, label, completed check, nor merge starts publication. The workflow checks current `main`, the committed version, and its merged main PR. A hotfix supplies its own successful checks; a develop promotion must match the full Git tree from a successful merged develop PR. It records the source PR and check runs. A changed or unproven tree must return through the PR quality lane.

Publication reuses that source evidence rather than rerunning application tests, PTY checks, dependency auditing, or scanners. It builds the npm package and container, validates archive contents and identity, verifies checksums, and publishes provenance. It does not rerun package/container smokes, tests, or scanners: those results come from the eligible PR. Archive and checksum validation protect publication integrity without repeating those jobs.

The existing `release` environment controls any configured deployment restrictions. No new human-approval rule is imported from the reference project. Respect the actual environment and branch protections; never approve or bypass a gate without authorization.

Assets use bare versions:

- `VERSION.tgz`, for example `0.1.0.tgz`: installable npm tarball.
- `VERSION.cdx.json`, for example `0.1.0.cdx.json`: locked production npm dependency inventory.
- `SHA256SUMS`: checksums for those assets.
- `ghcr.io/consciontologic/faac:VERSION`: Linux AMD64 image, with only a semantic-version tag.

No npm registry publication is configured. The CycloneDX inventory does not cover container OS packages. Never move a published tag or replace its assets. If publication fails after verified artifacts exist, diagnose first and rerun the failed publication job to reuse the same artifacts.

## Build artifacts locally

```bash
make package
make package.test
make image
make image.test
```

Package output lives in `build/package/`. Build `faac:local` before the image smoke test. Local commands remain available when you deliberately need them; they do not enable extra hosted CI triggers.

## Run the container

The image includes Node.js 22, Git, Bash, ripgrep, and Python. It uses a nonroot `faac` entrypoint and `/workspace` as the working directory. Project-specific test toolchains may require a derived image.

```bash
mkdir -p "$HOME/.local/share/faac"
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/workspace" \
  --mount "type=bind,src=$HOME/.local/share/faac,dst=/state" \
  --env FAAC_HOME=/state \
  --env HOME=/state/home \
  --env OPENROUTER_API_KEY \
  ghcr.io/consciontologic/faac:0.1.0
```

Set `OPENROUTER_API_KEY` securely before running, or omit it and connect through the hidden prompt. The state mount preserves sessions and the encrypted vault. The workspace mount permits host-file edits. Do not mount the Docker socket. Use `faac:local` for a locally built image.

## Diagnose a blocked step

Read the failed job and its PR/source revision. A missing eligible source run needs a real PR event, not a manual CI substitute. Changed-tree promotion needs fresh checks through `develop`. Missing Copilot access needs account configuration; an uncertain task needs reconciliation. Native review quota cannot be fixed by treating an error comment as approval. Keep receipts and evidence intact.

If GitHub clears a merged run's PR association, historical recovery requires a same-repository source branch used by exactly one PR, no retargeting, matching immutable parent/tree data, and checks completed before merge. Ambiguous fork, reused-branch, or retargeted history is rejected; validate the source through a fresh PR instead of bypassing the evidence gate.

Historical setup results, including the original controller and manual diagnostics, are recorded in [verification](../reports/VERIFICATION.md). They describe the earlier configuration, not the current trigger policy.

## Read the logs

Workflow steps use clear labels and short status markers: 🏃 running, ✅ passed, and ❌ failed. Grouped output keeps command detail expandable; durations and the job summary show where time went. Read the failing command's output before retrying. A successful artifact build is not a replacement for the recorded source-PR evidence.

The faac terminal supports `NO_COLOR=1` and `FAAC_ASCII=1` when color or Unicode is inconvenient. These are application display options; GitHub controls how its own workflow UI renders step names and groups.
