/** Resume a previously retained live-test session through the actual CLI. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { Redactor, Store, hash } from "../../src/storage.js";

const redactor = new Redactor();
for (const name of [
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "FAAC_VAULT_PASSWORD",
])
  redactor.add(process.env[name]);
const home = process.env.FAAC_RESUME_HOME;
const sessionId = process.env.FAAC_RESUME_SESSION;
if (
  process.env.FAAC_LIVE_TEST !== "1" ||
  !process.env.OPENROUTER_API_KEY ||
  !home ||
  !sessionId
) {
  process.stderr.write(
    "NOT RUN: Requires FAAC_LIVE_TEST=1, OPENROUTER_API_KEY, FAAC_RESUME_HOME, and FAAC_RESUME_SESSION. Resumes the existing objective without submitting a replacement prompt.\n",
  );
  process.exitCode = 2;
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faac-live-resume-"));
  fs.chmodSync(root, 0o700);
  const report: Record<string, unknown> = {
    type: "live_resume_verification",
    result: "running",
    home: path.resolve(home),
    session: sessionId,
    startedAt: new Date().toISOString(),
    evidence:
      "Actual CLI process resumes the retained objective with actual authenticated hosted inference; no new user prompt or provider response injection.",
  };
  const save = () =>
    fs.writeFileSync(
      path.join(root, "report.json"),
      redactor.text(JSON.stringify(report, null, 2)),
      { mode: 0o600 },
    );
  try {
    const store = new Store(home, redactor);
    const before = store.load(sessionId);
    const workspace = before.workspace;
    report.workspace = workspace;
    report.previousState = before.state;
    assert(before.objective, "Selected session has no saved objective");
    const sentinel = fs.readFileSync(
      path.join(workspace, "preserve.txt"),
      "utf8",
    );
    const beforeSum = hash(fs.readFileSync(path.join(workspace, "sum.cjs")));
    const previousShellCount = before.actions.filter(
      (action) =>
        action.call.name === "shell" &&
        action.result?.startsWith("Exit code: 0\n"),
    ).length;
    const config = store.config();
    config.maxSteps = 12;
    config.route = ["openrouter"];
    store.saveConfig(config);
    const project = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const cli = path.join(project, "dist/cli.js");
    assert(fs.existsSync(cli), "Build first: npm run build");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FAAC_HOME: home,
      NO_COLOR: "1",
    };
    delete env.GROQ_API_KEY;
    delete env.FAAC_VAULT_PASSWORD;
    process.stdout.write(
      JSON.stringify({
        type: "live_resume_started",
        root,
        workspace,
        session: sessionId,
      }) + "\n",
    );
    save();
    const result = await new Promise<{
      code: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          cli,
          "--json",
          "--no-sync",
          "--resume",
          sessionId,
          "--allow-edit",
          "--allow-command",
          "node --test sum.test.cjs",
        ],
        {
          cwd: project,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "",
        timedOut = false;
      let escalation: NodeJS.Timeout | undefined;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGTERM");
          escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
        },
        8 * 60 * 1000,
      );
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        resolve({
          code,
          timedOut,
          stdout: redactor.text(stdout),
          stderr: redactor.text(stderr),
        });
      });
    });
    fs.writeFileSync(path.join(root, "resume.stdout.ndjson"), result.stdout, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(root, "resume.stderr.txt"), result.stderr, {
      mode: 0o600,
    });
    report.exitCode = result.code;
    report.timedOut = result.timedOut;
    const after = store.load(sessionId);
    report.resumedState = after.state;
    report.newAttempts = after.attempts.slice(before.attempts.length);
    report.nextRetryAt = after.nextRetryAt;
    assert(!result.timedOut, "CLI exceeded the eight-minute bound");
    assert.equal(
      result.code,
      0,
      "Resumed CLI did not complete; inspect retained state/transcript",
    );
    assert.equal(after.state, "complete");
    assert.equal(after.id, before.id);
    assert.equal(after.workspace, before.workspace);
    assert.equal(after.objective, before.objective);
    assert.deepEqual(
      after.messages.slice(0, before.messages.length),
      before.messages,
      "Previous conversation was replaced",
    );
    assert.deepEqual(
      after.messages.filter((message) => message.role === "user"),
      before.messages.filter((message) => message.role === "user"),
      "Resume should not repeat the user's request",
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, "preserve.txt"), "utf8"),
      sentinel,
    );
    assert.equal(
      hash(fs.readFileSync(path.join(workspace, "sum.cjs"))),
      beforeSum,
      "Resume replaced completed sum implementation",
    );
    const shellCount = after.actions.filter(
      (action) =>
        action.call.name === "shell" &&
        JSON.parse(action.call.arguments).command ===
          "node --test sum.test.cjs" &&
        action.state === "completed" &&
        action.result?.startsWith("Exit code: 0\n"),
    ).length;
    assert(
      shellCount > previousShellCount,
      "Resumed agent did not run the exact approved test successfully",
    );
    const independentEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/(KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH)/i.test(name),
      ),
    );
    report.independentAssertions = execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `
      const assert = require("node:assert/strict");
      const exported = require("./sum.cjs");
      const sum = typeof exported === "function" ? exported : exported.sum;
      assert.equal(typeof sum, "function");
      for (const [a,b,expected] of [[2,3,5],[-2,-3,-5],[-3,2,-1],[0,0,0],[0.25,0.5,0.75]]) assert.equal(sum(a,b),expected);
      process.stdout.write("Independent retained sum assertions passed\\n");
    `,
      ],
      {
        cwd: workspace,
        env: independentEnv,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1_000_000,
      },
    );
    report.agentSuccessfulTests = shellCount;
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.error = redactor.text(
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    process.stdout.write(
      redactor.text(
        JSON.stringify({
          type: "live_resume_verification",
          result: report.result,
          report: path.join(root, "report.json"),
          error: report.error,
        }),
      ) + "\n",
    );
  }
}
