import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("CI step groups output, summarizes status and preserves command failure", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "faac-ci-log-"));
  try {
    const summary = path.join(temporary, "summary.md");
    const env = {
      ...process.env,
      NO_COLOR: "1",
      FAAC_ASCII: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summary,
    };
    const failed = spawnSync(
      "bash",
      [
        "xops/ci/step.sh",
        "Package check",
        process.execPath,
        "-e",
        "console.log('real command output');process.exit(7)",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(failed.status, 7);
    assert.match(failed.stdout, /::group::Package check/u);
    assert.match(failed.stdout, /real command output/u);
    assert.match(failed.stdout, /::endgroup::/u);
    assert.match(failed.stderr, /\[failed\] Package check.*exit 7/u);
    assert(!failed.stdout.includes("\x1b") && !failed.stderr.includes("\x1b"));
    assert.match(
      fs.readFileSync(summary, "utf8"),
      /\[failed\].*Package check.*exit 7/u,
    );
    const passed = spawnSync(
      "bash",
      [
        "xops/ci/step.sh",
        "Build package",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /\[passed\] Build package/u);
    assert.match(
      fs.readFileSync(summary, "utf8"),
      /\[passed\].*Build package/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
