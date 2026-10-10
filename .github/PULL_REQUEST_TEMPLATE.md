## Change

Describe the user-visible problem and resulting behavior. Link the issue.

## Verification

List commands and actual results. Distinguish deterministic, terminal, and authenticated provider tests. For a develop-to-main promotion, link the merged source PR and show that its verified full Git tree is unchanged; do not rerun quality/security pipelines merely for promotion.

## Review

- [ ] Normal work/release preparation targets `develop`; hotfix or validated develop promotion targets `main`.
- [ ] Workspace preservation, free-only routing, and durable sessions remain intact.
- [ ] Tests and documentation match the change; no secrets or temporary artifacts are included.
- [ ] Findings and conversations are resolved; any remaining native review/account gate is reported accurately.

Quality/package/security jobs run only for PRs into `develop` or hotfix PRs into `main`. The PR-only GitFlow gate verifies promotion evidence. Labels do not dispatch AI work, merge, or release; those steps require explicit action. Same-repository Copilot hotfix branches use `work:hotfix` to select the hotfix check lane.
