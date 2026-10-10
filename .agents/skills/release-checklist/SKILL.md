---
name: release-checklist
description: "Release Checklist. You are about to tag a version, publish a package, or deploy to production."
---

# Release Checklist

## When to use

- You are about to tag a version, publish a package, or deploy to production.
- The definition of "release" for this project = the moment external users can
  be affected by the change.

## Procedure

### Pre-release (gate check)

- [ ] All tests pass on CI or the project's equivalent test runner.
- [ ] The project's verification checks pass cleanly.
- [ ] All `tracking.csv` rows with `commit_sha=pending` have been committed
      (`make git`).
- [ ] `CHANGELOG.md` (or equivalent) updated with user-visible changes.
      Use the tracking CSV's `summary` column as the raw material.
- [ ] Version number bumped in the one authoritative place
      (`.agentic-workspace-version`, `package.json`, `pyproject.toml`, etc.).
- [ ] Security scan ran and found nothing new (`npm audit`, `pip-audit`,
      `cargo audit`, `trivy`, …).
- [ ] README and docs still accurate for the new version.
- [ ] Breaking changes (if any) documented in CHANGELOG with migration notes.

### Tagging

Follow [the release guide](../../../docs/guides/DEVOPS.md). Prepare the version
on a work branch and publish its PR with guarded `make git`. Promote through
the protected develop-to-main PR. Dispatch the validated Release workflow, or
authorize `ai:release` on the exact promotion head. The workflow creates the
immutable tag, verifies artifacts, and publishes the container. Do not push
all local tags or move an existing release tag.


### Post-release

- [ ] Verify the published artefact (install from registry, smoke-test).
- [ ] GitHub Release / release notes published.
- [ ] Internal announcement (Slack, email) if applicable.
- [ ] Next milestone / ROADMAP.md updated.

## Anti-patterns

- ❌ Tagging a commit with uncommitted changes in the working tree.
- ❌ Releasing without running the full test suite.
- ❌ Bumping version in multiple files manually — automate with a single
  source of truth.
- ❌ Skipping CHANGELOG because "we can do it later" — later never comes.
- ❌ Publishing a `0.x` version without noting its stability guarantee
  in the README.
