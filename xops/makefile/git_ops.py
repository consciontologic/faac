"""xops/makefile/git_ops.py — `make git` and `make git.dry`.

Reads docs/tracking/tracking.csv, finds rows with action=commit, status=completed,
commit_sha=pending whose run_id does NOT already appear in any commit
message, groups them by run_id, then either previews or commits + pushes.

Git has a single staging window, so one `make git` run produces exactly ONE
commit carrying the whole staged tree. Every pending run_id contributes its
summary and `[<run_id>]` trailer to that commit's message. Empty commits are
never created: with a clean tree the pending rows simply wait and fold into
the next real commit.

The row's `summary` column is used VERBATIM as the commit subject. A
`[<run_id>]` trailer is appended so repeat invocations are idempotent.

Refuses to commit if the working tree is dirty AND no pending row exists
(catches the "agent forgot to track.add" footgun).
An explicit later invocation can resume a failed push of an existing tracked
HEAD commit, after inspecting the same-name remote branch and its ancestry.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path
from typing import Iterable, List

from _common import (
    BOLD, DIM, RESET, REPO_ROOT, TRACKING_CSV, dim, dispatch, err, info, ok,
    out, run, step, warn,
)

# Conventional Commits subject: <type>(<scope>)?(!)?: <description>.
# Mirrors the gate in xops/agent/tracking_append.sh. The commit subject is the
# tracking row's `summary` verbatim, so this is the last line of defense that
# keeps the commit log Conventional-Commits-clean even if tracking.csv was
# hand-edited around the appender.
_CC_RE = re.compile(
    r"^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)"
    r"(\([^)]+\))?!?:\s.+"
)


def is_conventional_commit(subject: str) -> bool:
    """True iff `subject` is a valid Conventional Commits subject line."""
    return bool(_CC_RE.match(subject))


def is_work_branch(branch: str) -> bool:
    """Gitflow work branches only; never publish directly from main/develop."""
    slug = r"[a-z0-9]+(?:-[a-z0-9]+)*"
    semver = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    prefix = r"(?:(?:codex|claude|copilot)/)?"
    return bool(re.fullmatch(prefix + r"(?:(?:feature|bugfix|hotfix)/" + slug +
                             r"|release/" + semver + r")", branch) or
                re.fullmatch(r"copilot/" + slug, branch))


def _read_pending_rows() -> List[dict]:
    if not TRACKING_CSV.exists():
        err(f"{TRACKING_CSV} not found")
        sys.exit(66)
    rows = []
    with TRACKING_CSV.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        expected = ["ts_utc", "run_id", "agent", "scope", "action", "status",
                    "summary", "refs", "commit_sha"]
        if reader.fieldnames != expected:
            err(f"tracking.csv header mismatch: got {reader.fieldnames}")
            sys.exit(66)
        for r in reader:
            if (r["action"] == "commit"
                    and r["status"] == "completed"
                    and r["commit_sha"] == "pending"):
                rows.append(r)
    return rows


def _already_committed_run_ids() -> set[str]:
    """Return run_ids already mentioned in any commit message anywhere in repo."""
    if not (REPO_ROOT / ".git").exists():
        return set()
    log = out(["git", "log", "--all", "--format=%B"], check=False)
    seen = set()
    for line in log.splitlines():
        # match a [run-id] trailer anywhere in the line
        i = line.find("[")
        while i != -1:
            j = line.find("]", i + 1)
            if j == -1:
                break
            cand = line[i + 1 : j]
            if cand.replace("-", "").isalnum():
                seen.add(cand)
            i = line.find("[", j + 1)
    return seen


def _group_by_run_id(rows: List[dict]) -> List[List[dict]]:
    groups: dict[str, List[dict]] = {}
    order: List[str] = []
    for r in rows:
        rid = r["run_id"]
        if rid not in groups:
            groups[rid] = []
            order.append(rid)
        groups[rid].append(r)
    return [groups[rid] for rid in order]


def _build_commit_message(group: List[dict]) -> str:
    primary = group[0]
    subject = primary["summary"]
    body_lines: List[str] = []
    if len(group) > 1:
        body_lines.append("")
        body_lines.append("Additional tracking rows:")
        for r in group[1:]:
            body_lines.append(f"  - {r['action']}/{r['status']}: {r['summary']}")
    if primary["refs"]:
        body_lines.append("")
        body_lines.append("Refs:")
        for ref in primary["refs"].split(";"):
            ref = ref.strip()
            if ref:
                body_lines.append(f"  - {ref}")
    body_lines.append("")
    body_lines.append(f"[{primary['run_id']}]")
    return subject + "\n" + "\n".join(body_lines)


def _build_batch_commit_message(groups: List[List[dict]]) -> str:
    """One commit message for the whole staging window.

    A single group keeps the classic per-run message. Multiple groups share
    the batch's one real commit: first group's summary is the subject, the
    others are listed in the body, and every group's `[<run_id>]` trailer is
    included so each row stays idempotent on re-run.
    """
    if len(groups) == 1:
        return _build_commit_message(groups[0])
    subject = groups[0][0]["summary"]
    body_lines: List[str] = ["", "Also includes:"]
    for group in groups[1:]:
        body_lines.append(f"  - {group[0]['summary']}")
    refs: List[str] = []
    for group in groups:
        for ref in group[0]["refs"].split(";"):
            ref = ref.strip()
            if ref and ref not in refs:
                refs.append(ref)
    if refs:
        body_lines.append("")
        body_lines.append("Refs:")
        for ref in refs:
            body_lines.append(f"  - {ref}")
    body_lines.append("")
    for group in groups:
        body_lines.append(f"[{group[0]['run_id']}]")
    return subject + "\n" + "\n".join(body_lines)


def _working_tree_dirty() -> bool:
    return bool(out(["git", "status", "--porcelain"]).strip())


def _require_single_origin_destination() -> None:
    """Ensure the read-only inspection and push address the same one remote."""
    fetch_urls = out(["git", "remote", "get-url", "--all", "origin"]).splitlines()
    push_urls = out(["git", "remote", "get-url", "--push", "--all", "origin"]).splitlines()
    if len(fetch_urls) != 1 or not fetch_urls[0] or push_urls != fetch_urls:
        # Do not print URLs: a legacy remote may contain embedded credentials.
        err("origin must have one matching fetch/push destination; inspect its local configuration before publishing.")
        sys.exit(65)


def _push_work_branch(branch: str) -> None:
    step("🚀 pushing the validated work branch to origin")
    # Ignore upstream/default refspecs: a work branch may track main. Explicit
    # refs also override remote.origin.push; command-local settings prevent
    # mirror/followTags from expanding the publication beyond this one branch.
    run(["git", "-c", "remote.origin.mirror=false", "-c", "push.followTags=false",
         "push", "--set-upstream", "origin",
         f"refs/heads/{branch}:refs/heads/{branch}"])
    ok("pushed")


def _resume_publication(branch: str, rows: List[dict]) -> None:
    """Inspect a clean, already-committed work branch before resuming its push."""
    if _working_tree_dirty():
        err("working tree has changes but no new pending tracking run_id.")
        err("Append a tracking row for the new work before publishing (AGENTS.md §2).")
        sys.exit(2)
    _require_single_origin_destination()
    local_sha = out(["git", "rev-parse", "HEAD"]).strip()
    remote_ref = f"refs/heads/{branch}"
    remote_result = out(["git", "ls-remote", "--heads", "origin", remote_ref]).strip()
    remote_sha = None
    if remote_result:
        fields = remote_result.split()
        if (len(fields) != 2 or fields[1] != remote_ref
                or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", fields[0])):
            err("origin returned an unexpected branch reference; refusing to resume publication.")
            sys.exit(65)
        remote_sha = fields[0]
    if remote_sha == local_sha:
        ok("origin already contains this work-branch commit — nothing to publish")
        return
    message_lines = out(["git", "show", "-s", "--format=%B", "HEAD"]).splitlines()
    if not any(f"[{row['run_id']}]" in message_lines for row in rows):
        err("HEAD has no completed tracking run_id; refusing to publish an untracked commit.")
        sys.exit(2)
    if remote_sha is not None:
        ancestry = run(["git", "merge-base", "--is-ancestor", remote_sha, local_sha], check=False)
        if ancestry != 0:
            err("origin's work-branch tip is diverged or unavailable locally; fetch and inspect it before publishing.")
            sys.exit(65)
    info("resuming publication of the existing tracked commit; no new commit will be created")
    _push_work_branch(branch)


# ── subcommands ───────────────────────────────────────────────────────────

def cmd_dry(_args: List[str]) -> None:
    step("🔧 make git.dry — preview what would be committed")
    rows = _read_pending_rows()
    if not rows:
        ok("no pending commit rows in tracking.csv")
        if _working_tree_dirty():
            warn("⚠️  working tree IS dirty — agent forgot to track.add?")
            run(["git", "status", "--short"])
        return
    committed = _already_committed_run_ids()
    groups = _group_by_run_id(rows)
    new_groups = [g for g in groups if g[0]["run_id"] not in committed]
    info(f"found {len(rows)} pending row(s) in {len(groups)} run_id group(s)")
    for group in groups:
        rid = group[0]["run_id"]
        if rid in committed:
            dim(f"  ⏭  skipping {rid} — already in git log")
            continue
        if not is_conventional_commit(group[0]["summary"]):
            warn(f"  ⚠️  subject is NOT Conventional Commits — `make git` will refuse: {group[0]['summary']!r}")
    if new_groups:
        msg = _build_batch_commit_message(new_groups)
        rids = ", ".join(g[0]["run_id"] for g in new_groups)
        print()
        print(f"{BOLD}── would commit (one commit for the batch): [{rids}] ──{RESET}", file=sys.stderr)
        for line in msg.splitlines():
            print(f"    {line}", file=sys.stderr)
    print()
    if _working_tree_dirty():
        info("staged + unstaged changes (git status --short):")
        run(["git", "status", "--short"])
    elif new_groups:
        warn("working tree clean — nothing to commit; pending rows fold into the next real commit")
    else:
        info("no new commit: make git will inspect the same-name origin branch and resume any unpublished tracked HEAD")


def cmd_push(_args: List[str]) -> None:
    step("🔧 make git — commit pending tracking rows + push")
    branch = out(["git", "rev-parse", "--abbrev-ref", "HEAD"]).strip()
    if not is_work_branch(branch):
        err("Gitflow requires a feature/bugfix/hotfix/release work branch; refusing integration-branch publication.")
        err("Read docs/guides/DEVOPS.md. Existing staged files were not changed.")
        sys.exit(65)
    rows = _read_pending_rows()
    if not rows:
        if _working_tree_dirty():
            err("working tree has changes but tracking.csv has no pending row.")
            err("→ agent should append a row first (see AGENTS.md §2).")
            sys.exit(2)
        ok("nothing to commit (no pending rows, clean tree)")
        return

    committed = _already_committed_run_ids()
    groups = _group_by_run_id(rows)
    new_groups = [g for g in groups if g[0]["run_id"] not in committed]
    if not new_groups:
        _resume_publication(branch, rows)
        return

    # Final Conventional-Commits gate before anything is committed. Validate
    # every subject up front and refuse the whole batch on the first offender,
    # so a bad subject never reaches the commit log and we never commit a
    # partial batch.
    offenders = [
        g[0] for g in new_groups if not is_conventional_commit(g[0]["summary"])
    ]
    if offenders:
        err("refusing to commit: non-Conventional-Commits subject(s) in tracking.csv")
        for r in offenders:
            err(f"  [{r['run_id']}] {r['summary']!r}")
        err("  required: <type>(<scope>)?(!)?: <description>")
        err("  fix the row's summary (append a corrective row) and re-run.")
        sys.exit(65)

    # Empty commits are never created. With a clean tree the pending rows
    # stay pending and fold into the next real commit's message.
    if not _working_tree_dirty():
        warn("working tree clean — nothing to commit; pending rows will fold into the next real commit")
        return

    _require_single_origin_destination()

    # Stage everything first (humans may have left things unstaged).
    run(["git", "add", "-A"])

    # One staging window ⇒ one commit. Every pending run_id's summary and
    # [run_id] trailer rides in that commit's message.
    msg = _build_batch_commit_message(new_groups)
    rids = ", ".join(g[0]["run_id"] for g in new_groups)
    info(f"committing [{rids}] (1 commit for {len(new_groups)} run_id group(s))")
    run(["git", "commit", "-m", msg])
    ok(f"committed [{rids}]")

    _push_work_branch(branch)


TABLE = {
    "dry":  cmd_dry,
    "push": cmd_push,
}

if __name__ == "__main__":
    dispatch("git_ops", TABLE)
