"""Tests for `make git` batch commit-message construction."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import git_ops

from git_ops import _build_batch_commit_message, _build_commit_message


def _row(run_id: str, summary: str, refs: str = "") -> dict:
    return {
        "ts_utc": "2026-09-09T12:00:00Z",
        "run_id": run_id,
        "agent": "copilot",
        "scope": "test",
        "action": "commit",
        "status": "completed",
        "summary": summary,
        "refs": refs,
        "commit_sha": "pending",
    }


class BuildBatchCommitMessageTest(unittest.TestCase):
    def test_single_group_matches_per_group_message(self) -> None:
        group = [_row("run-a", "feat(x): add thing", "a.go;b.go")]
        self.assertEqual(
            _build_batch_commit_message([group]),
            _build_commit_message(group),
        )

    def test_multi_group_uses_first_subject_and_lists_others(self) -> None:
        groups = [
            [_row("run-a", "feat(x): add thing")],
            [_row("run-b", "fix(y): correct thing")],
            [_row("run-c", "docs(z): explain thing")],
        ]
        msg = _build_batch_commit_message(groups)
        lines = msg.splitlines()
        self.assertEqual(lines[0], "feat(x): add thing")
        self.assertIn("Also includes:", lines)
        self.assertIn("  - fix(y): correct thing", lines)
        self.assertIn("  - docs(z): explain thing", lines)

    def test_multi_group_carries_every_run_id_marker_once(self) -> None:
        groups = [
            [_row("run-a", "feat(x): add thing")],
            [_row("run-b", "fix(y): correct thing")],
        ]
        msg = _build_batch_commit_message(groups)
        for marker in ("[run-a]", "[run-b]"):
            self.assertEqual(msg.count(marker), 1, marker)

    def test_multi_group_unions_refs_in_order_without_duplicates(self) -> None:
        groups = [
            [_row("run-a", "feat(x): add thing", "a.go;shared.go")],
            [_row("run-b", "fix(y): correct thing", "shared.go;b.go")],
        ]
        msg = _build_batch_commit_message(groups)
        lines = msg.splitlines()
        refs_at = lines.index("Refs:")
        self.assertEqual(
            lines[refs_at + 1 : refs_at + 4],
            ["  - a.go", "  - shared.go", "  - b.go"],
        )
        self.assertEqual(msg.count("shared.go"), 1)

    def test_multi_group_omits_refs_section_when_no_refs(self) -> None:
        groups = [
            [_row("run-a", "feat(x): add thing")],
            [_row("run-b", "fix(y): correct thing")],
        ]
        self.assertNotIn("Refs:", _build_batch_commit_message(groups))


class PublishBranchTest(unittest.TestCase):
    branch = "codex/release/1.0.0"
    local_sha = "a" * 40
    remote_sha = "b" * 40

    def resume_output(self, remote_sha=None, message="fix(gitflow): guard publication\n\n[branch-guard]\n"):
        def output(command, **kwargs):
            if command in (["git", "remote", "get-url", "--all", "origin"],
                           ["git", "remote", "get-url", "--push", "--all", "origin"]):
                return "https://example.invalid/owner/repository.git\n"
            if command == ["git", "rev-parse", "--abbrev-ref", "HEAD"]:
                return self.branch
            if command == ["git", "rev-parse", "HEAD"]:
                return self.local_sha
            if command == ["git", "show", "-s", "--format=%B", "HEAD"]:
                return message
            if command == ["git", "ls-remote", "--heads", "origin", f"refs/heads/{self.branch}"]:
                return "" if remote_sha is None else f"{remote_sha}\trefs/heads/{self.branch}\n"
            self.fail(f"Unexpected read command: {command}")
        return output

    def test_explicit_retry_after_failed_push_publishes_without_another_commit(self):
        state = {"committed": False, "pushes": 0}
        def command_run(command, **kwargs):
            if command[:2] == ["git", "commit"]:
                state["committed"] = True
            if "push" in command:
                state["pushes"] += 1
                if state["pushes"] == 1:
                    raise SystemExit(1)
            return 0
        with patch.object(git_ops, "out", side_effect=self.resume_output()), \
                patch.object(git_ops, "run", side_effect=command_run) as run, \
                patch.object(git_ops, "_read_pending_rows", return_value=[
                    _row("branch-guard", "fix(gitflow): guard publication")]), \
                patch.object(git_ops, "_already_committed_run_ids", side_effect=lambda: {"branch-guard"} if state["committed"] else set()), \
                patch.object(git_ops, "_working_tree_dirty", side_effect=lambda: not state["committed"]):
            with self.assertRaises(SystemExit):
                git_ops.cmd_push([])
            self.assertEqual(state["pushes"], 1)
            git_ops.cmd_push([])
        self.assertEqual(state["pushes"], 2)
        commits = [c for c in run.call_args_list if c.args[0][:2] == ["git", "commit"]]
        self.assertEqual(len(commits), 1)
        pushes = [c.args[0] for c in run.call_args_list if "push" in c.args[0]]
        self.assertEqual(pushes[0], pushes[1])
        self.assertEqual(pushes[1][-1], f"refs/heads/{self.branch}:refs/heads/{self.branch}")

    def test_already_published_commit_is_a_no_op(self):
        with patch.object(git_ops, "out", side_effect=self.resume_output(self.local_sha)), \
                patch.object(git_ops, "run") as run, \
                patch.object(git_ops, "_read_pending_rows", return_value=[
                    _row("branch-guard", "fix(gitflow): guard publication")]), \
                patch.object(git_ops, "_already_committed_run_ids", return_value={"branch-guard"}), \
                patch.object(git_ops, "_working_tree_dirty", return_value=False):
            git_ops.cmd_push([])
        run.assert_not_called()

    def test_resume_refuses_dirty_work_without_new_tracking(self):
        with patch.object(git_ops, "out", return_value=self.branch), \
                patch.object(git_ops, "run") as run, \
                patch.object(git_ops, "_read_pending_rows", return_value=[
                    _row("branch-guard", "fix(gitflow): guard publication")]), \
                patch.object(git_ops, "_already_committed_run_ids", return_value={"branch-guard"}), \
                patch.object(git_ops, "_working_tree_dirty", return_value=True):
            with self.assertRaises(SystemExit) as raised:
                git_ops.cmd_push([])
        self.assertEqual(raised.exception.code, 2)
        run.assert_not_called()

    def test_resume_refuses_diverged_or_unknown_remote_tip(self):
        for ancestry_result in (1, 128):
            with self.subTest(result=ancestry_result), \
                    patch.object(git_ops, "out", side_effect=self.resume_output(self.remote_sha)), \
                    patch.object(git_ops, "run", return_value=ancestry_result) as run, \
                    patch.object(git_ops, "_read_pending_rows", return_value=[
                        _row("branch-guard", "fix(gitflow): guard publication")]), \
                    patch.object(git_ops, "_already_committed_run_ids", return_value={"branch-guard"}), \
                    patch.object(git_ops, "_working_tree_dirty", return_value=False):
                with self.assertRaises(SystemExit) as raised:
                    git_ops.cmd_push([])
                self.assertEqual(raised.exception.code, 65)
                self.assertFalse(any("push" in c.args[0] for c in run.call_args_list))

    def test_resume_fast_forwards_an_inspected_remote_tip(self):
        with patch.object(git_ops, "out", side_effect=self.resume_output(self.remote_sha)), \
                patch.object(git_ops, "run", return_value=0) as run, \
                patch.object(git_ops, "_read_pending_rows", return_value=[
                    _row("branch-guard", "fix(gitflow): guard publication")]), \
                patch.object(git_ops, "_already_committed_run_ids", return_value={"branch-guard"}), \
                patch.object(git_ops, "_working_tree_dirty", return_value=False):
            git_ops.cmd_push([])
        self.assertEqual(run.call_args_list[0].args[0], [
            "git", "merge-base", "--is-ancestor", self.remote_sha, self.local_sha])
        self.assertEqual(len([c for c in run.call_args_list if "push" in c.args[0]]), 1)
        self.assertFalse(any(c.args[0][:2] == ["git", "commit"] for c in run.call_args_list))

    def test_resume_refuses_head_without_tracking_evidence(self):
        with patch.object(git_ops, "out", side_effect=self.resume_output(message="untracked commit\n")), \
                patch.object(git_ops, "run") as run, \
                patch.object(git_ops, "_read_pending_rows", return_value=[
                    _row("branch-guard", "fix(gitflow): guard publication")]), \
                patch.object(git_ops, "_already_committed_run_ids", return_value={"branch-guard"}), \
                patch.object(git_ops, "_working_tree_dirty", return_value=False):
            with self.assertRaises(SystemExit) as raised:
                git_ops.cmd_push([])
        self.assertEqual(raised.exception.code, 2)
        run.assert_not_called()

    def test_resume_refuses_malformed_or_unexpected_remote_references(self):
        for response in ("invalid-sha\trefs/heads/" + self.branch,
                         self.remote_sha + "\trefs/heads/main",
                         f"{self.remote_sha}\trefs/heads/{self.branch}\n" * 2):
            original_output = self.resume_output()
            def output(command, **kwargs):
                if command[:2] == ["git", "ls-remote"]:
                    return response
                return original_output(command, **kwargs)
            with self.subTest(response=response), \
                    patch.object(git_ops, "out", side_effect=output), \
                    patch.object(git_ops, "run") as run, \
                    patch.object(git_ops, "_read_pending_rows", return_value=[
                        _row("branch-guard", "fix(gitflow): guard publication")]), \
                    patch.object(git_ops, "_already_committed_run_ids", return_value={"branch-guard"}), \
                    patch.object(git_ops, "_working_tree_dirty", return_value=False):
                with self.assertRaises(SystemExit) as raised:
                    git_ops.cmd_push([])
                self.assertEqual(raised.exception.code, 65)
                run.assert_not_called()

    def test_failed_remote_inspection_never_retries_or_pushes(self):
        original_output = self.resume_output()
        def output(command, **kwargs):
            if command[:2] == ["git", "ls-remote"]:
                raise SystemExit(128)
            return original_output(command, **kwargs)
        with patch.object(git_ops, "out", side_effect=output) as reads, \
                patch.object(git_ops, "run") as run, \
                patch.object(git_ops, "_read_pending_rows", return_value=[
                    _row("branch-guard", "fix(gitflow): guard publication")]), \
                patch.object(git_ops, "_already_committed_run_ids", return_value={"branch-guard"}), \
                patch.object(git_ops, "_working_tree_dirty", return_value=False):
            with self.assertRaises(SystemExit) as raised:
                git_ops.cmd_push([])
        self.assertEqual(raised.exception.code, 128)
        run.assert_not_called()
        self.assertEqual(len([c for c in reads.call_args_list if c.args[0][:2] == ["git", "ls-remote"]]), 1)

    def test_destination_mismatch_or_multiple_push_urls_stop_before_commit(self):
        original_output = self.resume_output()
        for push_urls in ("https://example.invalid/other.git\n",
                          "https://example.invalid/owner/repository.git\nhttps://example.invalid/other.git\n"):
            def output(command, **kwargs):
                if command == ["git", "remote", "get-url", "--push", "--all", "origin"]:
                    return push_urls
                return original_output(command, **kwargs)
            with self.subTest(push_urls=push_urls), \
                    patch.object(git_ops, "out", side_effect=output), \
                    patch.object(git_ops, "run") as run, \
                    patch.object(git_ops, "_read_pending_rows", return_value=[
                        _row("branch-guard", "fix(gitflow): guard publication")]), \
                    patch.object(git_ops, "_already_committed_run_ids", return_value=set()), \
                    patch.object(git_ops, "_working_tree_dirty", return_value=True):
                with self.assertRaises(SystemExit) as raised:
                    git_ops.cmd_push([])
                self.assertEqual(raised.exception.code, 65)
                run.assert_not_called()

    def test_integration_branches_stop_before_staging_or_committing(self):
        for branch in ("main", "develop"):
            with self.subTest(branch=branch), \
                    patch.object(git_ops, "out", return_value=branch), \
                    patch.object(git_ops, "run") as run, \
                    patch.object(git_ops, "_read_pending_rows") as rows:
                with self.assertRaises(SystemExit) as raised:
                    git_ops.cmd_push([])
                self.assertEqual(raised.exception.code, 65)
                run.assert_not_called()
                rows.assert_not_called()

    def test_push_uses_explicit_same_branch_ref_despite_upstream_config(self):
        branch = "codex/release/1.0.0"
        def output(command, **kwargs):
            if command == ["git", "rev-parse", "--abbrev-ref", "HEAD"]:
                return branch
            return "origin/main"
        with patch.object(git_ops, "out", side_effect=output), \
                patch.object(git_ops, "run") as run, \
                patch.object(git_ops, "_read_pending_rows", return_value=[
                    _row("branch-guard", "fix(gitflow): guard publication")]), \
                patch.object(git_ops, "_already_committed_run_ids", return_value=set()), \
                patch.object(git_ops, "_working_tree_dirty", return_value=True):
            git_ops.cmd_push([])
        pushes = [c.args[0] for c in run.call_args_list if "push" in c.args[0]]
        self.assertEqual(pushes, [["git", "-c", "remote.origin.mirror=false",
                                  "-c", "push.followTags=false", "push",
                                  "--set-upstream", "origin",
                                  f"refs/heads/{branch}:refs/heads/{branch}"]])


if __name__ == "__main__":
    unittest.main()
