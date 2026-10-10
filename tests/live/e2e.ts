/** Authenticated CLI E2E. Run explicitly; never part of the deterministic suite. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { Redactor, Store, hash } from "../../src/storage.js";
import type { Session } from "../../src/types.js";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cli = path.join(project, "dist/cli.js");
const redactor = new Redactor();
for (const name of [
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "FAAC_VAULT_PASSWORD",
])
  redactor.add(process.env[name]);

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

async function runCli(
  cwd: string,
  home: string,
  args: string[],
): Promise<ProcessResult> {
  // This test intentionally exercises one credential, preserving production free-only rules.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAAC_HOME: home,
    NO_COLOR: "1",
  };
  delete env.GROQ_API_KEY;
  delete env.FAAC_VAULT_PASSWORD;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--json", ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      },
      8 * 60 * 1000,
    );
    const collect = (target: "stdout" | "stderr", data: Buffer) => {
      if (target === "stdout") stdout += data.toString();
      else stderr += data.toString();
      if (stdout.length + stderr.length > 8_000_000) {
        child.kill("SIGTERM");
        if (!escalation)
          escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      }
    };
    child.stdout.on("data", (data: Buffer) => collect("stdout", data));
    child.stderr.on("data", (data: Buffer) => collect("stderr", data));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: redactor.text(stdout),
        stderr: redactor.text(stderr),
      });
    });
  });
}

function independentChecks(workspace: string, withProduct: boolean): string {
  // Assertions are controlled by the test harness, independent of model-generated tests.
  const source = `
    const assert = require("node:assert/strict");
    const sum = require("./sum.cjs");
    assert.equal(typeof sum, "function", "sum.cjs must export the function itself");
    for (const [a, b, expected] of [[2, 7, 9], [-5, 2, -3], [-4, -6, -10], [0, 0, 0], [0.25, 0.5, 0.75]])
      assert.equal(sum(a, b), expected);
    ${
      withProduct
        ? `
    const product = require("./product.cjs");
    assert.equal(typeof product, "function", "product.cjs must export the function itself");
    for (const [a, b, expected] of [[2, 7, 14], [-5, 2, -10], [-4, -6, 24], [0, 7, 0], [0.5, 0.25, 0.125]])
      assert.equal(product(a, b), expected);
    `
        : ""
    }
    process.stdout.write("Independent ${withProduct ? "sum and product" : "sum"} assertions passed\\n");
  `;
  // Generated code sees no provider credentials, matching faac's shell environment policy.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/(KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
  return execFileSync(
    process.execPath,
    ["--input-type=commonjs", "-e", source],
    {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1_000_000,
    },
  );
}

function successfulShellCount(session: Session): number {
  return session.actions.filter(
    (action) =>
      action.call.name === "shell" &&
      JSON.parse(action.call.arguments).command ===
        "node --test sum.test.cjs" &&
      action.state === "completed" &&
      action.result?.startsWith("Exit code: 0\n"),
  ).length;
}

if (process.env.FAAC_LIVE_TEST !== "1" || !process.env.OPENROUTER_API_KEY) {
  process.stderr.write(
    "NOT RUN: Set FAAC_LIVE_TEST=1 and OPENROUTER_API_KEY through your environment or secret manager. This performs actual hosted inference.\n",
  );
  process.exitCode = 2;
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faac-live-e2e-"));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "state");
  fs.mkdirSync(workspace);
  const store = new Store(home, redactor);
  const config = store.config();
  config.maxSteps = 12;
  config.route = ["openrouter"];
  store.saveConfig(config);
  const artifacts: Record<string, unknown> = {
    type: "live_e2e_verification",
    result: "running",
    startedAt: new Date().toISOString(),
    workspace,
    home,
    processes: [],
    evidence:
      "Real CLI subprocesses and real authenticated hosted inference; no provider responses are mocked or injected in this test.",
    limitation:
      "Natural quota-triggered fallback is not required by this coding/resume test.",
  };
  const persist = () => {
    fs.writeFileSync(
      path.join(root, "report.json"),
      redactor.text(JSON.stringify(artifacts, null, 2)),
      { mode: 0o600 },
    );
  };
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const sentinel = "existing user work with uncommitted edits\n";
  const untracked = "existing untracked user note\n";
  const firstPrompt =
    "Implement and verify a tiny CommonJS arithmetic module. Read the workspace instructions. " +
    "Create sum.cjs with function sum(a, b) returning a + b and export the function itself as module.exports = sum. " +
    "Create sum.test.cjs using node:test and node:assert/strict, covering positive, negative, zero, and decimal inputs. " +
    "Use the file tools to create the files, then run exactly node --test sum.test.cjs. " +
    "Only sum.cjs and sum.test.cjs may be changed. Preserve existing.txt, user-note.txt, and AGENTS.md byte for byte. " +
    "Do not install dependencies or run other shell commands. Report actual results after running the tests.";
  const secondPrompt =
    "Continue this saved task from the actual workspace. Add product.cjs with function product(a, b) returning a * b, " +
    "exporting the function itself as module.exports = product. Add product test cases to the existing sum.test.cjs " +
    "while retaining the sum tests, covering positive, negative, zero, and decimal inputs. Read current file hashes before edits. " +
    "Run exactly node --test sum.test.cjs and report actual results. Preserve sum.cjs, existing.txt, user-note.txt, and AGENTS.md " +
    "byte for byte. Only product.cjs and sum.test.cjs may change. No dependencies or other shell commands.";
  try {
    assert(fs.existsSync(cli), "Build first: npm run build");
    git(["init", "-q"]);
    git(["config", "user.name", "faac isolated E2E"]);
    git(["config", "user.email", "faac-e2e@localhost"]);
    fs.writeFileSync(
      path.join(workspace, "existing.txt"),
      "committed baseline\n",
    );
    fs.writeFileSync(
      path.join(workspace, "AGENTS.md"),
      "# Isolated verification workspace\n\nPreserve existing.txt and user-note.txt exactly. " +
        "Use CommonJS without dependencies. Run only node --test sum.test.cjs. " +
        "Read existing files before changes and use their current hashes.\n",
    );
    git(["add", "existing.txt", "AGENTS.md"]);
    git([
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Isolated test baseline",
    ]);
    fs.writeFileSync(path.join(workspace, "existing.txt"), sentinel);
    fs.writeFileSync(path.join(workspace, "user-note.txt"), untracked);
    const initialCommit = git(["rev-parse", "HEAD"]).trim();
    const guidanceHash = hash(
      fs.readFileSync(path.join(workspace, "AGENTS.md")),
    );
    artifacts.gitBefore = git(["status", "--porcelain=v1"]);
    const preserve = () => {
      assert.equal(
        fs.readFileSync(path.join(workspace, "existing.txt"), "utf8"),
        sentinel,
      );
      assert.equal(
        fs.readFileSync(path.join(workspace, "user-note.txt"), "utf8"),
        untracked,
      );
      assert.equal(
        hash(fs.readFileSync(path.join(workspace, "AGENTS.md"))),
        guidanceHash,
      );
      assert.equal(git(["rev-parse", "HEAD"]).trim(), initialCommit);
      const status = git(["status", "--porcelain=v1"]);
      assert(
        status.includes(" M existing.txt"),
        "User dirty tracked file was altered or staged",
      );
      assert(
        status.includes("?? user-note.txt"),
        "User untracked file was altered or staged",
      );
      artifacts.gitAfter = status;
    };
    const recordProcess = (name: string, result: ProcessResult) => {
      fs.writeFileSync(
        path.join(root, `${name}.stdout.ndjson`),
        result.stdout,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(root, `${name}.stderr.txt`), result.stderr, {
        mode: 0o600,
      });
      (artifacts.processes as unknown[]).push({
        name,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: path.join(root, `${name}.stdout.ndjson`),
        stderr: path.join(root, `${name}.stderr.txt`),
      });
      persist();
      assert(!result.timedOut, `${name} exceeded the eight-minute bound`);
      assert.equal(
        result.exitCode,
        0,
        `${name} did not complete; inspect retained session/transcript`,
      );
      for (const line of result.stdout.trim().split("\n")) JSON.parse(line);
    };
    process.stdout.write(
      JSON.stringify({ type: "live_e2e_started", root, phase: "coding" }) +
        "\n",
    );
    persist();
    const first = await runCli(workspace, home, [
      "--allow-edit",
      "--allow-command",
      "node --test sum.test.cjs",
      "-p",
      firstPrompt,
    ]);
    recordProcess("coding", first);
    const sessions = store.list();
    assert.equal(
      sessions.length,
      1,
      "Expected one session from the first CLI launch",
    );
    const saved = sessions[0]!;
    artifacts.session = saved.id;
    artifacts.firstState = saved.state;
    assert.equal(saved.state, "complete");
    assert.equal(
      saved.workspace,
      workspace,
      "CLI did not use its launch directory",
    );
    assert(
      saved.messages.some(
        (message) => message.role === "user" && message.content === firstPrompt,
      ),
    );
    const firstShellCount = successfulShellCount(saved);
    assert(
      firstShellCount >= 1,
      "Agent did not run the exact approved test command successfully",
    );
    assert(saved.attempts.some((attempt) => attempt.outcome === "success"));
    preserve();
    artifacts.firstIndependentAssertions = independentChecks(workspace, false);
    const sumHash = hash(fs.readFileSync(path.join(workspace, "sum.cjs")));
    const initialActionIds = saved.actions.map((action) => action.id);
    const initialMessages = structuredClone(saved.messages);
    persist();

    process.stdout.write(
      JSON.stringify({
        type: "live_e2e_progress",
        root,
        session: saved.id,
        phase: "restart_and_resume",
      }) + "\n",
    );
    const second = await runCli(project, home, [
      "--no-sync",
      "--resume",
      saved.id,
      "--allow-edit",
      "--allow-command",
      "node --test sum.test.cjs",
      "-p",
      secondPrompt,
    ]);
    recordProcess("resumed", second);
    const resumed = store.load(saved.id);
    artifacts.resumedState = resumed.state;
    assert.equal(resumed.state, "complete");
    assert.equal(
      store.list().length,
      1,
      "Resume unexpectedly created another session",
    );
    assert.equal(
      resumed.workspace,
      workspace,
      "Resume lost the original workspace",
    );
    assert.deepEqual(
      resumed.messages.slice(0, initialMessages.length),
      initialMessages,
    );
    assert.deepEqual(
      resumed.actions
        .slice(0, initialActionIds.length)
        .map((action) => action.id),
      initialActionIds,
    );
    assert(
      resumed.messages.some(
        (message) =>
          message.role === "user" && message.content === secondPrompt,
      ),
    );
    assert(
      successfulShellCount(resumed) > firstShellCount,
      "Resumed agent did not run the tests again",
    );
    assert.equal(
      hash(fs.readFileSync(path.join(workspace, "sum.cjs"))),
      sumHash,
      "Resume replaced completed sum implementation",
    );
    preserve();
    artifacts.resumedIndependentAssertions = independentChecks(workspace, true);
    artifacts.models = [
      ...new Set(
        resumed.attempts.map(
          (attempt) => `${attempt.provider}/${attempt.model}`,
        ),
      ),
    ];
    artifacts.successfulResponses = resumed.attempts.filter(
      (attempt) => attempt.outcome === "success",
    ).length;
    artifacts.successfulShellTests = successfulShellCount(resumed);
    artifacts.completedEdits = resumed.edits.filter(
      (edit) => !edit.undone,
    ).length;
    artifacts.checkpoints = resumed.checkpoints.length;
    artifacts.result = "passed";
  } catch (error) {
    artifacts.result = "failed";
    artifacts.error = redactor.text(
      error instanceof Error ? error.message : String(error),
    );
    artifacts.sessions = store.list().map((session) => ({
      id: session.id,
      state: session.state,
      attempts: session.attempts,
      nextRetryAt: session.nextRetryAt,
    }));
    process.exitCode = 1;
  } finally {
    artifacts.finishedAt = new Date().toISOString();
    persist();
    process.stdout.write(
      redactor.text(
        JSON.stringify({
          type: "live_e2e_verification",
          result: artifacts.result,
          report: path.join(root, "report.json"),
          workspace,
          session: artifacts.session,
          error: artifacts.error,
        }),
      ) + "\n",
    );
  }
}
