---
name: changelog-discipline
description: "Document user-visible changes in the existing changelog, including changes affecting downstream developers."
---

# Changelog discipline

## When to use

Every user-visible change. "User" includes downstream developers consuming
the public API.

## Procedure

1. **Keep a `CHANGELOG.md` at the repo root.** Format: [Keep a Changelog](https://keepachangelog.com/).
2. **Append under `## [Unreleased]`** in the same commit as the change.
   Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
   `Security`.
3. **Write for the consumer**, not the implementer. Example:
   - ❌ "Refactored `auth.go` to use the new context pattern."
   - ✅ "Auth tokens now expire after 1 hour (was 24h)."
4. **Prepare the release in the same change as the version bump.** Curate the
   pending entries using tracking summaries and reviewed changes as raw material.
   Rename `[Unreleased]` to `## [0.1.2] - YYYY-MM-DD` (using the actual version
   and release date), then open a new `## [Unreleased]` section above it. Keep
   releases newest first and omit empty categories. Preserve historical facts;
   a later reversal belongs to the new version, not a rewrite of an older entry.
5. **Use bare SemVer throughout.** The changelog version must match
   `package.json`, the lockfile root, release title, Git tag, and container tag.
   Do not add `v` or `faac-` prefixes. Include migration guidance for breaking
   changes and distinguish implemented behavior from pending verification.
6. **Publish that version's curated section as GitHub release notes.** Do not
   substitute a commit log or copy Unreleased/older entries into the release.
   Follow the existing protected PR and explicit release-dispatch procedure in
   [AGENTS.md](../../../AGENTS.md) and [DevOps](../../../docs/guides/DEVOPS.md).
   After publication, verify the release body and published artifact version.
7. **Link to issues / PRs** where relevant: `(#42)`.

## Anti-patterns

- ❌ One vague "various improvements" line covering 20 commits.
- ❌ Auto-generated changelog from commit subjects with no curation.
- ❌ Entries describing internal refactors that don't affect the user.
- ❌ Forgetting to update `[Unreleased]` and remembering at release time (you won't).
- ❌ Security fixes mentioned only in commit messages, not in the changelog.
