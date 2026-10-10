## Change

Describe the user-visible problem and resulting behavior. Link the issue.

## Verification

List the checks run and their result. Distinguish deterministic tests, terminal
checks, and authenticated provider tests.

## Review

- [ ] Target follows GitFlow: normal work and release preparation → `develop`; hotfix or promotion → `main`.
- [ ] Workspace preservation, free-only routing, and durable sessions remain intact.
- [ ] Tests and existing documentation match the change; no secrets or temporary artifacts are included.

A maintainer may add `ai:merge` to authorize bounded review, repair and merging.
`ai:release` separately authorizes publishing the exact head after its main merge.
`ai:pause` stops controller work. CI and unresolved review threads still gate merge.
