/** Real hosted inference only. Never included in the deterministic test command. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Application } from "../../src/app.js";

if (process.env.FAAC_LIVE_TEST !== "1" || !process.env.OPENROUTER_API_KEY) {
  process.stderr.write(
    "NOT RUN: Set FAAC_LIVE_TEST=1 and provide OPENROUTER_API_KEY through your environment/secret manager. This command performs real hosted inference; deterministic tests do not.\n",
  );
  process.exitCode = 2;
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faac-live-coding-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, "preserve.txt"),
    "existing user work\n",
  );
  const app = new Application({
    workspace,
    home: path.join(root, "state"),
    allowEdit: true,
    allowedCommands: ["node --test sum.test.cjs"],
    json: true,
    noSync: false,
  });
  try {
    await app.initialize();
    await app.work(
      "Create sum.cjs exporting a function sum(a,b) that returns a+b. Create sum.test.cjs using node:test and node:assert/strict with assertions for positive and negative inputs. Use file tools, then run exactly node --test sum.test.cjs and report actual results. Preserve preserve.txt. You may only need these two new files.",
    );
    assert.equal(
      app.session.state,
      "complete",
      "Agent did not complete; inspect saved session",
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, "preserve.txt"), "utf8"),
      "existing user work\n",
    );
    assert(
      fs.existsSync(path.join(workspace, "sum.cjs")) &&
        fs.existsSync(path.join(workspace, "sum.test.cjs")),
      "Expected generated files absent",
    );
    const output = execFileSync(process.execPath, ["--test", "sum.test.cjs"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15000,
    });
    const loaded = app.store.load(app.session.id);
    assert(
      loaded.actions.some(
        (a) =>
          a.call.name === "shell" &&
          a.state === "completed" &&
          a.result?.includes("Exit code: 0"),
      ),
      "No completed successful agent shell test",
    );
    assert(
      loaded.attempts.some((a) => a.outcome === "success"),
      "No authenticated response recorded",
    );
    process.stdout.write(
      JSON.stringify({
        type: "live_verification",
        result: "passed",
        workspace,
        session: loaded.id,
        provider: "openrouter",
        models: [...new Set(loaded.attempts.map((a) => a.model))],
        testOutput: output,
        limitation:
          "Real authenticated coding task; not proof of a real quota-triggered fallback.",
      }) + "\n",
    );
  } finally {
    app.close();
  }
}
