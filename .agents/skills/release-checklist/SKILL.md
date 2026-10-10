---
name: release-checklist
description: "Verify source evidence and artifact integrity before an explicitly requested faac release."
---

# Release checklist

Use before publishing a faac version. Read [the release guide](../../../docs/guides/DEVOPS.md) and [AGENTS.md](../../../AGENTS.md).

## Source evidence

- Confirm the committed `package.json` and lockfile version is a new bare SemVer.
- Confirm changelog and user documentation match the actual release.
- Verify current main came through a merged main PR: a hotfix with successful eligible checks, or a develop promotion preserving the full tree from a successful merged develop PR.
- Preserve the exact source tree. Changed source needs fresh checks through develop before publication.
- Review the recorded source PR and check-run evidence. Do not substitute old manual-dispatch diagnostics or a skipped promotion job for actual source validation.

Quality, package, container, and security jobs run only in the eligible PR lanes. Do not trigger duplicate tests, smokes, or scans during promotion or release. The release workflow validates earlier evidence and performs artifact-build/integrity work.

## Publication

Explicitly dispatch `release.yml` on main with the committed version. No tag push, label, merge, completed check, or delivery controller starts publication. Respect the configured release environment; do not invent or bypass approval rules.

The workflow builds package/container artifacts, checks allowed archive contents, identity, checksums and provenance, then publishes the immutable bare-version tag and assets. Existing tags/assets must not be moved or replaced. After a failure, inspect remote state before rerunning the failed job with its original artifacts.

## Results

Confirm the release tag, asset names, checksums, and versioned GHCR reference. Preserve dated evidence. Do not report publication merely because a local build succeeded. Update the roadmap and tracking through the coordinating agent.
