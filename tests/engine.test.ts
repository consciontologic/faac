import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Engine, contextFor } from "../src/engine.js";
import { ProviderFailure } from "../src/providers.js";
import { Router } from "../src/routing.js";
import { Store } from "../src/storage.js";
import { ToolRunner } from "../src/tools.js";
import {
  answer,
  fixture,
  ScriptedClient,
  testModel,
  testSnapshot,
  tool,
} from "./helpers.js";
import type { EngineOptions } from "../src/engine.js";
import type { Model } from "../src/types.js";
function engine(
  f: ReturnType<typeof fixture>,
  client: ScriptedClient,
  models = [testModel(), testModel("groq")],
  overrides: Partial<EngineOptions> = {},
) {
  return new Engine({
    ...f,
    client,
    models: async () => models,
    key: async () => "mock-credential",
    snapshot: testSnapshot,
    ...overrides,
  });
}

test("repeated permission denials pause instead of exhausting provider quota", async (t) => {
  const f = fixture(t);
  const runner = new ToolRunner(
    f.store,
    f.session,
    f.config,
    async () => false,
    f.emit,
    ["node --version"],
  );
  const client = new ScriptedClient(async function* (request, index) {
    assert(
      request.messages.some(
        (message) =>
          message.content.includes("allowedCommands") &&
          message.content.includes("node --version"),
      ),
    );
    yield {
      type: "tool",
      call: tool(`denied-${index}`, "shell", { command: "pwd" }),
    };
    yield { type: "done", finishReason: "tool_calls" };
  });
  await engine(f, client, undefined, { runner }).run(
    "Check runtime",
    new AbortController().signal,
  );
  assert.equal(client.requests.length, 3);
  assert.equal(f.session.state, "blocked");
  assert(
    f.events.some(
      (event) =>
        event.type === "warning" && event.text.includes("three denied"),
    ),
  );
  assert(f.session.remaining.includes("Check runtime"));
});

test("mock vertical coding task writes file, runs actual shell test, survives fallback with tool results and workspace hashes", async (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "answer.cjs");
  const client = new ScriptedClient(async function* (req, index) {
    if (index === 0) {
      yield {
        type: "tool",
        call: tool("write-1", "write_file", {
          path: "answer.cjs",
          content: "module.exports = 42;\n",
          expectedHash: null,
        }),
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    if (index === 1) {
      assert.equal(fs.readFileSync(file, "utf8"), "module.exports = 42;\n");
      yield {
        type: "tool",
        call: tool("test-1", "shell", {
          command:
            "node -e \"if(require('./answer.cjs')!==42)process.exit(1)\"",
        }),
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    if (index === 2) {
      yield { type: "text", text: "Tests passed, preparing report" };
      throw new ProviderFailure("Quota exhausted", 429, "account", {
        retryAfterMs: 60000,
      });
    }
    assert.equal(req.model.provider, "groq");
    assert(
      req.messages.some(
        (m) => m.role === "tool" && m.content.includes("Exit code: 0"),
      ),
    );
    assert(
      req.messages.some(
        (m) => m.role === "tool" && m.content.includes('"saved":true'),
      ),
    );
    assert(req.messages.some((m) => m.content.includes("actual=")));
    assert(
      req.messages.some((m) =>
        m.content.includes("Tests passed, preparing report"),
      ),
    );
    yield* answer("Created answer.cjs and verified it returns 42.");
  });
  await engine(f, client).run(
    "Create an answer module and verify 42",
    new AbortController().signal,
  );
  assert.equal(f.session.state, "complete");
  assert.equal(fs.readFileSync(file, "utf8"), "module.exports = 42;\n");
  assert.equal(f.session.edits.length, 1);
  assert.deepEqual(f.approvals, ["shell"]);
  assert.equal(f.store.load(f.session.id).state, "complete");
  assert(
    f.store
      .load(f.session.id)
      .toolDefinitions?.some(
        (definition) =>
          definition.name === "write_file" &&
          definition.parameters.type === "object",
      ),
    "Resumed sessions retain the exact provider-neutral tool definitions used for the task",
  );
  assert.equal(
    f.session.attempts.filter((a) => a.outcome === "failed").length,
    1,
  );
  assert(f.events.some((event) => event.type === "fallback"));
});

for (const failure of [
  new ProviderFailure("HTTP 503", 503, "provider", { retryAfterMs: 60000 }),
  new ProviderFailure("Connection reset", 0, "provider", {
    retryAfterMs: 60000,
  }),
  new ProviderFailure("Rate limited", 429, "account", { retryAfterMs: 60000 }),
]) {
  test(`mock interrupted ${failure.status} response preserves partial context and falls back`, async (t) => {
    const f = fixture(t);
    const client = new ScriptedClient(async function* (req, index) {
      if (index === 0) {
        yield { type: "text", text: "Inspected approach before disruption" };
        throw failure;
      }
      assert.equal(req.model.provider, "groq");
      assert(
        req.messages.some((m) =>
          m.content.includes("Inspected approach before disruption"),
        ),
      );
      yield* answer("Continued");
    });
    await engine(f, client).run(
      "Continue after disruption",
      new AbortController().signal,
    );
    assert.equal(client.requests.length, 2);
    assert.equal(f.session.state, "complete");
  });
}

test("incomplete streamed tool followed by failure never reaches ToolRunner", async (t) => {
  const f = fixture(t);
  const client = new ScriptedClient(async function* (_req, index) {
    if (!index) {
      yield {
        type: "tool",
        call: {
          id: "incomplete",
          name: "write_file",
          arguments: '{"path":"unsafe"',
        },
      };
      throw new ProviderFailure("Interrupted", 503, "provider", {
        retryAfterMs: 60000,
      });
    }
    yield* answer("No action taken");
  });
  await engine(f, client).run("Safe task", new AbortController().signal);
  assert.equal(f.session.actions.length, 0);
  assert(!fs.existsSync(path.join(f.workspace, "unsafe")));
  assert.equal(f.session.state, "complete");
});

test("cancellation stops inference without provider fallback and retains interrupted state", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const client = new ScriptedClient(async function* () {
    yield { type: "text", text: "Partial" };
    controller.abort();
    throw new Error("aborted");
  });
  await engine(f, client).run("Work", controller.signal);
  assert.equal(f.session.state, "cancelled");
  assert.equal(client.requests.length, 1);
  assert.equal(f.store.load(f.session.id).interrupted?.text, "Partial");
  assert.deepEqual(f.router.status().gates, {});
});

test("invalid request requires diagnosis rather than sending same payload to another provider", async (t) => {
  const f = fixture(t);
  const client = new ScriptedClient(async function* () {
    throw new ProviderFailure("Invalid parameter", 400, "request");
  });
  await engine(f, client).run("Work", new AbortController().signal);
  assert.equal(client.requests.length, 1);
  assert.equal(f.session.state, "blocked");
  assert(f.events.some((event) => /diagnosis/.test(event.text)));
});

test("all models unavailable retains resumable state and next retry hint", async (t) => {
  const f = fixture(t);
  const client = new ScriptedClient(async function* () {
    throw new ProviderFailure("Quota", 429, "account", { retryAfterMs: 60000 });
  });
  await engine(f, client).run("Saved objective", new AbortController().signal);
  const saved = f.store.load(f.session.id);
  assert.equal(saved.state, "blocked");
  assert.equal(saved.objective, "Saved objective");
  assert(saved.nextRetryAt);
  assert.equal(client.requests.length, 2);
  assert(saved.messages.some((m) => m.content === "Saved objective"));
});

test("unknown or paid free classification and quarantined providers never dispatch", async (t) => {
  const f = fixture(t);
  const paid = testModel();
  paid.free.eligible = false;
  const client = new ScriptedClient(() => answer("unexpected"));
  await engine(f, client, [paid, testModel("groq")], {
    snapshot: () => ({
      ...testSnapshot(),
      quarantined: { groq: "breaking schema" },
    }),
  }).run("No paid fallback", new AbortController().signal);
  assert.equal(client.requests.length, 0);
  assert.equal(f.session.state, "blocked");
});

test("smaller-context fallback persists explicit compaction and keeps tool call/result groups coherent", async (t) => {
  const f = fixture(t);
  f.session.objective = "Finish the coding task";
  f.session.messages.push({
    role: "user",
    content: "Keep my original instructions",
  });
  for (let i = 0; i < 20; i++) {
    const call = tool(`read-${i}`, "read_file", { path: `file-${i}` });
    f.session.messages.push(
      {
        role: "assistant",
        content: "Old reasoning ".repeat(50),
        toolCalls: [call],
      },
      {
        role: "tool",
        toolCallId: call.id,
        content: "Old file content ".repeat(80),
      },
    );
  }
  f.session.progress.push("Implemented core file");
  f.session.remaining = ["Verify core tests"];
  const large = testModel();
  const small = { ...testModel("groq"), contextWindow: 6000, maxOutput: 512 };
  const client = new ScriptedClient(async function* (req, index) {
    if (!index)
      throw new ProviderFailure("Unavailable", 503, "provider", {
        retryAfterMs: 60000,
      });
    assert.equal(req.model.provider, "groq");
    assert(
      req.messages.some((m) => m.content === "Keep my original instructions"),
    );
    assert(
      req.messages.some((m) => m.content.includes("Implemented core file")),
    );
    assert(req.messages.some((m) => m.content.includes("Verify core tests")));
    for (const message of req.messages.filter((m) => m.role === "tool"))
      assert(
        req.messages.some((m) =>
          m.toolCalls?.some((call) => call.id === message.toolCallId),
        ),
      );
    yield* answer("Verified");
  });
  await engine(f, client, [large, small]).run(
    undefined,
    new AbortController().signal,
  );
  assert.equal(f.session.state, "complete");
  assert(f.session.compactions.some((c) => c.model === small.id));
  assert(f.store.load(f.session.id).compactions.length);
  assert(f.session.messages.length > client.requests[1]!.messages.length);
});

test("critical instructions too large block rather than silently lose user requirements", (t) => {
  const f = fixture(t);
  const model = { ...testModel(), contextWindow: 4000, maxOutput: 512 };
  f.session.messages.push({
    role: "user",
    content: "Critical instructions ".repeat(2000),
  });
  assert.throws(
    () => contextFor(f.session, model, 512, f.store, f.emit),
    /critical instructions/,
  );
});

test("crash recovery resumes saved task while ambiguous shell replay is blocked", async (t) => {
  const f = fixture(t);
  const call = tool("old-shell", "shell", { command: "printf original" });
  f.session.objective = "Continue safely";
  f.session.state = "running";
  f.session.messages.push(
    { role: "user", content: "Continue safely" },
    { role: "assistant", content: "", toolCalls: [call] },
  );
  f.session.actions.push({
    id: "uncertain-action",
    call,
    state: "running",
    startedAt: new Date().toISOString(),
  });
  f.store.save(f.session);
  const store = new Store(f.store.home);
  const session = store.load(f.session.id);
  const runner = new ToolRunner(
    store,
    session,
    f.config,
    async () => {
      throw new Error("Must not ask to replay shell");
    },
    f.emit,
  );
  const client = new ScriptedClient(async function* (req, index) {
    if (!index) {
      assert(req.messages.some((m) => m.content.includes("Do not repeat")));
      yield {
        type: "tool",
        call: tool("new-shell", "shell", { command: "touch replayed" }),
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    assert(req.messages.some((m) => m.content.includes("Shell blocked")));
    yield* answer("Needs reconciliation");
  });
  await engine(f, client, [testModel()], { store, session, runner }).run(
    undefined,
    new AbortController().signal,
  );
  assert.equal(session.actions[0]!.state, "uncertain");
  assert(!fs.existsSync(path.join(f.workspace, "replayed")));
  assert.equal(session.actions.length, 1);
});

test("shared quotas and scoped cooldowns are persisted and don't multiply across models", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const router = new Router(
    f.store.home,
    () => now,
    () => 0.5,
  );
  const a = testModel();
  const b = testModel("openrouter", "other:free");
  const c = testModel("groq");
  for (let i = 0; i < 20; i++) assert(await router.reserve(i % 2 ? a : b));
  assert.equal(await router.reserve(b), false);
  assert.equal(router.availability(a).available, false);
  assert.equal(router.availability(c).available, true);
  assert.equal(router.status().pools["openrouter:free-account"]!.attempts, 20);
  now += 60001;
  assert(await router.reserve(a));
  await router.failure(
    a,
    new ProviderFailure("model limited", 429, "model", { retryAfterMs: 60000 }),
  );
  assert.equal(router.availability(a).available, false);
  assert.equal(router.availability(b).available, true);
  await router.failure(
    b,
    new ProviderFailure("account limited", 429, "account", {
      retryAfterMs: 60000,
    }),
  );
  assert.equal(router.availability(a).available, false);
  assert.equal(router.availability(b).available, false);
  assert.equal(router.availability(c).available, true);
  now += 60001;
  assert.equal(
    new Router(f.store.home, () => now).availability(b).available,
    true,
  );
});

test("adapter snapshot remains fixed during an active request and transitions on next request", async (t) => {
  const f = fixture(t);
  let active = testSnapshot();
  const client = new ScriptedClient(async function* (req, index) {
    if (!index) {
      assert.equal(req.snapshot.version, "fixture-v1");
      active = { ...active, version: "fixture-v2" };
      yield {
        type: "tool",
        call: tool("progress", "progress", {
          summary: "First request done",
          remaining: ["Report"],
        }),
      };
      assert.equal(req.snapshot.version, "fixture-v1");
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    assert.equal(req.snapshot.version, "fixture-v2");
    yield* answer("Done");
  });
  await engine(f, client, [testModel()], { snapshot: () => active }).run(
    "Work",
    new AbortController().signal,
  );
  assert.deepEqual(
    f.session.attempts.map((a) => a.version),
    ["fixture-v1", "fixture-v2"],
  );
});

test("a concurrent successful request cannot clear an unexpired account Retry-After gate", async (t) => {
  const f = fixture(t);
  const a = testModel();
  const b = testModel("openrouter", "other:free");
  await f.router.reserve(b); // B was already in flight when A was rate-limited.
  await f.router.failure(
    a,
    new ProviderFailure("shared quota", 429, "account", {
      retryAfterMs: 60000,
    }),
  );
  await f.router.success(b);
  assert.equal(f.router.availability(a).available, false);
  assert.equal(f.router.availability(b).available, false);
});

test("unresolved uncertain actions keep task resumable rather than falsely complete", async (t) => {
  const f = fixture(t);
  f.session.objective = "Resolve interrupted operation";
  f.session.actions.push({
    id: "unresolved",
    call: tool("shell-before-crash", "shell", { command: "publish-artifact" }),
    state: "uncertain",
    startedAt: new Date().toISOString(),
    result: "Outcome unknown",
  });
  f.session.remaining = ["Reconcile previous publish result"];
  const client = new ScriptedClient(() =>
    answer("An earlier action needs your reconciliation."),
  );
  await engine(f, client).run(undefined, new AbortController().signal);
  assert.equal(f.session.state, "blocked");
  assert(f.session.remaining.length);
  assert.equal(f.session.actions[0]!.state, "uncertain");
});

test("one malformed call in a multi-tool response prevents execution of every call", async (t) => {
  const f = fixture(t);
  const client = new ScriptedClient(async function* (_req, index) {
    if (!index) {
      yield {
        type: "tool",
        call: tool("valid-first", "write_file", {
          path: "should-not-exist",
          content: "unsafe partial batch",
          expectedHash: null,
        }),
      };
      yield {
        type: "tool",
        call: { id: "bad-second", name: "write_file", arguments: '{"path":' },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield* answer("Recovered without executing partial batch");
  });
  await engine(f, client).run(
    "Preserve response atomicity",
    new AbortController().signal,
  );
  assert(!fs.existsSync(path.join(f.workspace, "should-not-exist")));
  assert.equal(f.session.actions.length, 0);
});

test("output length continues from persisted response while content filtering blocks", async (t) => {
  const f = fixture(t);
  const client = new ScriptedClient(async function* (req, index) {
    if (!index) {
      yield { type: "text", text: "partial output up to limit" };
      yield { type: "done", finishReason: "length" };
      return;
    }
    assert(
      req.messages.some((m) =>
        m.content.includes("partial output up to limit"),
      ),
    );
    yield { type: "done", finishReason: "content_filter" };
  });
  await engine(f, client).run("Finish response", new AbortController().signal);
  assert.equal(client.requests.length, 2);
  assert.equal(f.session.state, "blocked");
  assert(f.events.some((event) => /Output limit/.test(event.text)));
  assert(f.session.remaining.length);
});

test("local failure after accepting a response does not dispatch a replacement model", async (t) => {
  const f = fixture(t);
  const original = f.store.event.bind(f.store);
  let throwOnce = true;
  f.store.event = (session, kind, data) => {
    if (kind === "response_completed" && throwOnce) {
      throwOnce = false;
      throw new Error(
        "simulated persistence failure after response acceptance",
      );
    }
    original(session, kind, data);
  };
  const client = new ScriptedClient(() => answer("Completed response"));
  await assert.rejects(
    () => engine(f, client).run("Persist safely", new AbortController().signal),
    /persistence failure/,
  );
  assert.equal(client.requests.length, 1);
  assert.equal(f.session.state, "blocked");
});

test("response attempts stay bounded at eight even with a large model catalog", async (t) => {
  const f = fixture(t);
  const models = Array.from({ length: 12 }, (_, i) =>
    testModel("openrouter", `fixture-${i}:free`),
  );
  const client = new ScriptedClient(async function* () {
    throw new ProviderFailure("retired model", 404, "model", {
      retryAfterMs: 60000,
    });
  });
  await engine(f, client, models).run(
    "Use a healthy model",
    new AbortController().signal,
  );
  assert(
    client.requests.length <= 8,
    `dispatched ${client.requests.length} attempts, expected at most 8`,
  );
  assert.equal(f.session.state, "blocked");
});

test("known credentials in prompts and objective never reach outbound model context", async (t) => {
  const f = fixture(t);
  const secret = "registered-fake-credential-123";
  f.store.redactor.add(secret);
  const client = new ScriptedClient(async function* (req) {
    assert(!JSON.stringify(req.messages).includes(secret));
    yield* answer("Handled redacted request");
  });
  await engine(f, client).run(
    `Inspect configuration without exposing ${secret}`,
    new AbortController().signal,
  );
  assert(!f.session.objective.includes(secret));
  assert(!JSON.stringify(f.store.load(f.session.id)).includes(secret));
});
