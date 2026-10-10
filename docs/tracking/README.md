# Tracking and recovery

Contributor tracking is separate from faac's end-user sessions. The append-only [tracking.csv](tracking.csv) records meaningful repository work; [the schema](tracking.schema.md) defines its nine columns.

| Path                      | Purpose                                     | Versioned |
| ------------------------- | ------------------------------------------- | --------- |
| `tracking.csv`            | Work, test, review, and publication records | Yes       |
| `context.md`              | Shared project context                      | Yes       |
| `state/current.json`      | Active contributor task                     | No        |
| `state/checkpoint.json`   | Interrupted step and remaining work         | No        |
| `state/last_failure.json` | Recovery breadcrumb from safe-run           | No        |
| `state/log.jsonl`         | Local event log                             | No        |

## Record a change

Only the coordinating agent appends completion rows and stages the agreed scope. Use the script; do not hand-edit CSV rows.

```bash
make track.add ACTION=test STATUS=passed AGENT=codex SCOPE=runtime \
  SUMMARY='test(runtime): deterministic suite passed'
make track.add ACTION=commit STATUS=completed AGENT=codex SCOPE=docs \
  SUMMARY='docs(usage): explain exact shell approvals'
make track.list
make git.dry
```

A commit row defaults to `commit_sha=pending`. `make git.dry` previews publication without writing. `make git` is subject to the branch and authorization rules in [AGENTS.md](../../AGENTS.md); it is not permission to write directly to protected branches. See [DevOps](../guides/DEVOPS.md).

## Recovery

Run `xops/agent/session-bootstrap.sh` at session start. Read any unresolved failure before new work. Wrap risky commands with `xops/agent/safe-run.sh`; it records the command, output, and exit status under `/tmp/agent-runs/`. Diagnose a failure before retrying. Clear the breadcrumb only after its cause is resolved.

For an interruption, save the step, scope, last command, completed work, remaining work, and next action in `state/checkpoint.json`. Preserve unrelated changes. Never use a failed test as a reason to discard the working tree.

Corrections are new `action=note` rows referring to the earlier run ID. Historical rows remain intact. Review logs for secrets before publishing them.
