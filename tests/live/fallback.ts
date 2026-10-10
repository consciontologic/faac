/** Live continuation with ONE explicitly injected model failure, never a fake success. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Application } from "../../src/app.js";
import { ProviderFailure } from "../../src/providers.js";
import { Redactor, Store, hash } from "../../src/storage.js";
import type { CompletionRequest, StreamEvent } from "../../src/types.js";

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
    "NOT RUN: Requires FAAC_LIVE_TEST=1, OPENROUTER_API_KEY, FAAC_RESUME_HOME, and FAAC_RESUME_SESSION from a successful authenticated coding test. Uses real API responses with one labeled injected model interruption.\n",
  );
  process.exitCode = 2;
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faac-live-fallback-"));
  fs.chmodSync(root, 0o700);
  const report: Record<string, unknown> = {
    type: "live_fallback_verification",
    result: "running",
    session: sessionId,
    home,
    startedAt: new Date().toISOString(),
    evidence:
      "All successful inference is real authenticated hosted inference. One test-injected model-scoped 429 interrupts a real response before tool acceptance; this is NOT evidence of a naturally occurring quota event or cross-provider fallback.",
  };
  const save = () =>
    fs.writeFileSync(
      path.join(root, "report.json"),
      redactor.text(JSON.stringify(report, null, 2)),
      { mode: 0o600 },
    );
  let app: Application | undefined;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const store = new Store(home, redactor);
    const original = store.load(sessionId);
    assert.equal(
      original.state,
      "complete",
      "First finish the authenticated coding/resume test",
    );
    assert(
      original.edits.some((edit) => !edit.undone),
      "Requires a previously completed persisted edit",
    );
    assert(
      original.attempts.some((attempt) => attempt.outcome === "success"),
      "Requires previous authenticated inference evidence",
    );
    assert(
      original.actions.some(
        (action) =>
          action.call.name === "shell" &&
          action.result?.startsWith("Exit code: 0\n"),
      ),
      "Requires a previously successful shell test",
    );
    const workspace = original.workspace;
    report.workspace = workspace;
    const protectedFiles = ["sum.cjs", "sum.test.cjs", "preserve.txt"];
    const hashes = Object.fromEntries(
      protectedFiles.map((name) => [
        name,
        hash(fs.readFileSync(path.join(workspace, name))),
      ]),
    );
    app = new Application({
      workspace,
      home,
      resume: sessionId,
      noSync: true,
      json: true,
      allowedCommands: ["node --test sum.test.cjs"],
    });
    app.config.route = ["openrouter"];
    app.config.maxSteps = 8;
    const events: unknown[] = [];
    const actualEmit = app.emit.bind(app);
    app.emit = (event) => {
      events.push(event);
      fs.writeFileSync(
        path.join(root, "events.ndjson"),
        redactor.text(
          events.map((item) => JSON.stringify(item)).join("\n") + "\n",
        ),
        { mode: 0o600 },
      );
      actualEmit(event);
    };
    await app.initialize();
    const snapshot = app.sync.snapshot();
    const eligible = (await app.models(snapshot, true)).filter(
      (model) =>
        model.provider === "openrouter" &&
        model.free.eligible &&
        app!.router.availability(model).available,
    );
    assert(
      eligible.length >= 2,
      "Requires at least two currently available eligible free models; no eligibility override is allowed",
    );
    report.eligibleModelCount = eligible.length;
    const actualComplete = app.client.complete.bind(app.client);
    let injected = false;
    let failedModel: string | undefined;
    let interruptedKind: string | undefined;
    let actionsAtInterrupt: number | undefined;
    const realRequests: string[] = [];
    let transferVerified = false;
    const activeApp = app;
    app.client.complete = async function* (
      request: CompletionRequest,
    ): AsyncIterable<StreamEvent> {
      if (realRequests.length >= 8) {
        activeApp.controller.abort(
          new Error("Live fallback reached its eight-request limit"),
        );
        throw new Error("Live fallback reached its eight-request limit");
      }
      realRequests.push(request.model.id);
      if (injected && !transferVerified) {
        assert.notEqual(
          request.model.id,
          failedModel,
          "Model cooldown failed to select another free model",
        );
        assert.equal(
          activeApp.session.actions.length,
          actionsAtInterrupt,
          "An interrupted response executed tools before completion",
        );
        assert(
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              message.content.includes("Exit code: 0"),
          ),
          "Fallback lost previous successful test output",
        );
        assert(
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              (message.content.includes('"saved":true') ||
                message.content.includes("Recovered completed edit")),
          ),
          "Fallback lost previous completed edit results",
        );
        assert(
          request.messages.some(
            (message) =>
              message.content.includes("actual=") &&
              message.content.includes(hashes["sum.cjs"]!),
          ),
          "Fallback did not include actual workspace hashes",
        );
        assert(
          request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content ===
                original.messages.find((item) => item.role === "user")?.content,
          ),
          "Fallback lost the original user request",
        );
        for (const name of protectedFiles)
          assert.equal(
            hash(fs.readFileSync(path.join(workspace, name))),
            hashes[name],
          );
        transferVerified = true;
      }
      for await (const event of actualComplete(request)) {
        if (!injected && (event.type === "text" || event.type === "tool")) {
          injected = true;
          failedModel = request.model.id;
          interruptedKind = event.type;
          actionsAtInterrupt = activeApp.session.actions.length;
          // Deliver actual provider output, then interrupt before its terminal event.
          // A tool event is never followed by done, so no tool from it may execute.
          yield event;
          throw new ProviderFailure(
            "TEST-INJECTED model interruption after real provider output",
            429,
            "model",
            { retryAfterMs: 60000 },
          );
        }
        yield event;
      }
    };
    const beforeAttempts = app.session.attempts.length;
    const beforeActions = app.session.actions.length;
    process.stdout.write(
      JSON.stringify({
        type: "live_fallback_started",
        root,
        session: sessionId,
      }) + "\n",
    );
    save();
    timer = setTimeout(
      () => {
        timedOut = true;
        activeApp.controller.abort(
          new Error("Live fallback test reached eight-minute bound"),
        );
      },
      8 * 60 * 1000,
    );
    // The same persisted objective is resumed. No user instruction is repeated or replaced.
    await app.work();
    report.injected = injected;
    report.injectedFailureModel = failedModel;
    report.interruptedEventType = interruptedKind;
    report.contextAndWorkspaceTransferVerified = transferVerified;
    report.realRequests = realRequests;
    report.newAttempts = app.session.attempts.slice(beforeAttempts);
    report.state = app.session.state;
    report.newToolActions = app.session.actions
      .slice(beforeActions)
      .map((action) => ({
        tool: action.call.name,
        state: action.state,
        result: action.result,
      }));
    report.nextRetryAt = app.session.nextRetryAt;
    assert(!timedOut, "Live fallback reached its bounded timeout");
    assert(injected, "No live response event was available to interrupt");
    assert(
      transferVerified,
      "No alternate model request received the persisted context",
    );
    assert.equal(
      app.session.state,
      "complete",
      "Fallback did not complete; retained session remains resumable",
    );
    assert(
      app.session.attempts
        .slice(beforeAttempts)
        .some(
          (attempt) =>
            attempt.outcome === "failed" &&
            attempt.reason?.includes("TEST-INJECTED"),
        ),
      "Injected failure was not durably recorded",
    );
    assert(
      app.session.attempts
        .slice(beforeAttempts)
        .some(
          (attempt) =>
            attempt.outcome === "success" && attempt.model !== failedModel,
        ),
      "No alternate free model completed real hosted inference",
    );
    assert.equal(app.session.objective, original.objective);
    assert.deepEqual(
      app.session.messages.filter((message) => message.role === "user"),
      original.messages.filter((message) => message.role === "user"),
      "Fallback required the original user request to be repeated",
    );
    for (const name of protectedFiles)
      assert.equal(
        hash(fs.readFileSync(path.join(workspace, name))),
        hashes[name],
        `Fallback changed ${name}`,
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
      process.stdout.write("Independent preserved sum assertions passed\\n");
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
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.error = redactor.text(
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  } finally {
    if (timer) clearTimeout(timer);
    app?.close();
    report.finishedAt = new Date().toISOString();
    save();
    process.stdout.write(
      redactor.text(
        JSON.stringify({
          type: "live_fallback_verification",
          result: report.result,
          report: path.join(root, "report.json"),
          error: report.error,
        }),
      ) + "\n",
    );
  }
}
