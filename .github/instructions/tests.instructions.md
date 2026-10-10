---
name: 'Test authoring'
description: 'TDD rules for the xops shell test suite'
applyTo: 'xops/test/**/*.sh'
---

# Test authoring

- Write the test before the implementation, and run it to confirm it fails for the reason you expect. A test that passes before the change proves nothing.
- Make the smallest change that turns it green, then re-run the whole suite: `bash xops/test/run_tests.sh`.
- New test files must be named `test_*.sh` and live in `xops/test/` — the runner discovers them by that glob and will silently ignore anything else.
- Never comment out or early-`return` a test case to clear a red bar — a silently skipped test is a regression nobody sees.
- Never weaken an assertion to make a failing test pass. Fix the script or fix the test's premise.
- Follow the existing harness: `set -euo pipefail`, `PASS`/`FAIL` counters, one `test_*` function per behaviour, assertions via the `ok_if` helper.
- Assert on observable output and exit codes, not on internal variables, so refactors don't break the suite.
- Every bug fix gets a regression test that reproduces the bug before the fix.
- Stage the test and the code it covers in the same commit.

Full procedure and tracking rows: [test-driven-development skill](../../.agents/skills/test-driven-development/SKILL.md).
