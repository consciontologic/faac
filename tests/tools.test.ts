import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, hash } from "../src/storage.js";
import {
  ToolRunner,
  currentHash,
  resolveSafe,
  sessionDiff,
  workspaceInstructions,
} from "../src/tools.js";
import { fixture, tool } from "./helpers.js";
import type { PendingAction } from "../src/types.js";
const signal = () => new AbortController().signal;

test("missing edit hashes identify the field so hosted models can correct the call", async (t) => {
  const f = fixture(t);
  const result = await f.runner.execute(
    tool("missing-hash", "write_file", { path: "new.txt", content: "hello" }),
    signal(),
  );
  assert.match(result, /expectedHash/);
  assert.match(result, /null explicitly/);
  assert.equal(fs.existsSync(path.join(f.workspace, "new.txt")), false);
});

test("denied shell variants explain exact authorization without executing them", async (t) => {
  const f = fixture(t);
  const runner = new ToolRunner(
    f.store,
    f.session,
    f.config,
    async () => false,
    f.emit,
    ["node --version"],
  );
  const denied = await runner.execute(
    tool("prefixed", "shell", { command: "cd . && node --version" }),
    signal(),
  );
  assert.match(denied, /Permission not granted/);
  assert.match(denied, /Preapproved exact commands/);
  assert.match(denied, /without cd/);
  const allowed = await runner.execute(
    tool("exact", "shell", { command: "node --version" }),
    signal(),
  );
  assert.match(allowed, /Exit code: 0/);
});

test("read, search, write and unique patch perform real filesystem edits with durable hashes and diff", async (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "math.ts");
  fs.writeFileSync(file, "export const answer = 1;\n");
  const read = JSON.parse(
    await f.runner.execute(
      tool("read", "read_file", { path: "math.ts" }),
      signal(),
    ),
  );
  assert.equal(read.sha256, hash("export const answer = 1;\n"));
  const patch = await f.runner.execute(
    tool("patch", "patch_file", {
      path: "math.ts",
      oldText: "answer = 1",
      newText: "answer = 42",
      expectedHash: read.sha256,
    }),
    signal(),
  );
  assert.match(patch, /saved/);
  assert.equal(fs.readFileSync(file, "utf8"), "export const answer = 42;\n");
  assert.match(sessionDiff(f.session), /-export const answer = 1/);
  assert.match(sessionDiff(f.session), /\+export const answer = 42/);
  assert.match(
    await f.runner.execute(
      tool("search", "search", { query: "answer" }),
      signal(),
    ),
    /math.ts:1:/,
  );
  assert.equal(
    f.store.load(f.session.id).edits[0]!.afterHash,
    currentHash(file),
  );
});
test("concurrent edits are detected and never overwritten by stale write or undo", async (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "code.txt");
  fs.writeFileSync(file, "original");
  const old = currentHash(file);
  fs.writeFileSync(file, "another editor");
  const result = await f.runner.execute(
    tool("stale", "write_file", {
      path: "code.txt",
      expectedHash: old,
      content: "my change",
    }),
    signal(),
  );
  assert.match(result, /Concurrent edit conflict/);
  assert.equal(fs.readFileSync(file, "utf8"), "another editor");
  await f.runner.execute(
    tool("valid", "write_file", {
      path: "code.txt",
      expectedHash: currentHash(file),
      content: "deliberate merge",
    }),
    signal(),
  );
  fs.writeFileSync(file, "new concurrent work");
  await assert.rejects(() => f.runner.undo(signal()), /Undo conflict/);
  assert.equal(fs.readFileSync(file, "utf8"), "new concurrent work");
});
test("undo restores only faac-owned edits and never claims to undo shell side effects", async (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "created.txt");
  await f.runner.execute(
    tool("create", "write_file", {
      path: "created.txt",
      expectedHash: null,
      content: "mine",
    }),
    signal(),
  );
  assert.match(await f.runner.undo(signal()), /Undid/);
  assert(!fs.existsSync(file));
  assert.equal(f.session.edits[0]!.undone, true);
  assert.match(
    await f.runner.undo(signal()),
    /Shell and external side effects cannot be undone/,
  );
});
test("same completed tool identity returns durable result without re-execution", async (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "file.txt");
  const call = tool("write-once", "write_file", {
    path: "file.txt",
    expectedHash: null,
    content: "first",
  });
  const result = await f.runner.execute(call, signal());
  fs.writeFileSync(file, "external change");
  assert.equal(await f.runner.execute(call, signal()), result);
  assert.equal(fs.readFileSync(file, "utf8"), "external change");
  assert.equal(f.session.actions.length, 1);
});
test("new nested workspace instructions must be loaded before modifying that directory", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, "nested"));
  fs.writeFileSync(
    path.join(f.workspace, "nested", "AGENTS.md"),
    "Preserve special formatting.\n",
  );
  const call = tool("first", "write_file", {
    path: "nested/file.txt",
    expectedHash: null,
    content: "Respect instructions",
  });
  assert.match(
    await f.runner.execute(call, signal()),
    /New workspace instructions loaded/,
  );
  assert(!fs.existsSync(path.join(f.workspace, "nested", "file.txt")));
  assert(
    Object.values(f.session.instructions || {}).some((text) =>
      text.includes("Preserve special formatting"),
    ),
  );
  assert.match(
    await f.runner.execute({ ...call, id: "second" }, signal()),
    /saved/,
  );
  assert.match(
    workspaceInstructions(
      f.workspace,
      path.join(f.workspace, "nested/file.txt"),
    ),
    /Preserve special formatting/,
  );
});
test("outside workspace and symlink escapes are denied before access", async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside.txt");
  fs.writeFileSync(outside, "private");
  fs.symlinkSync(outside, path.join(f.workspace, "shortcut"));
  assert.equal(resolveSafe(f.workspace, "shortcut").outside, true);
  for (const p of ["../outside.txt", "shortcut"])
    assert.match(
      await f.runner.execute(
        tool(randomUUID(), "read_file", { path: p }),
        signal(),
      ),
      /Permission denied: outside/,
    );
});
test("edit intent and recovery data reach disk before filesystem activation", async (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "target.txt");
  const original = f.store.event.bind(f.store);
  let prepared = false;
  f.store.event = (session, kind, data) => {
    original(session, kind, data);
    if (kind === "edit_prepared") {
      prepared = true;
      const disk = f.store.load(session.id);
      assert.equal(disk.actions.at(-1)!.state, "running");
      assert.equal(disk.edits.at(-1)!.after, "persist intent first");
      assert(!fs.existsSync(file));
    }
  };
  await f.runner.execute(
    tool("write", "write_file", {
      path: "target.txt",
      expectedHash: null,
      content: "persist intent first",
    }),
    signal(),
  );
  assert(prepared);
  assert.equal(f.store.load(f.session.id).actions.at(-1)!.state, "completed");
});
for (const outcome of ["applied", "not-applied", "conflicted"] as const) {
  test(`crash recovery reconciles ${outcome} edit against actual file hashes`, (t) => {
    const f = fixture(t);
    const file = path.join(f.workspace, "file.txt");
    const before = "before";
    const after = "after";
    fs.writeFileSync(
      file,
      outcome === "applied"
        ? after
        : outcome === "not-applied"
          ? before
          : "concurrent",
    );
    const call = tool("interrupted-edit", "write_file", {
      path: "file.txt",
      content: after,
      expectedHash: hash(before),
    });
    const action: PendingAction = {
      id: "edit-id",
      call,
      state: "running",
      startedAt: new Date().toISOString(),
      path: file,
      beforeHash: hash(before),
      afterHash: hash(after),
    };
    f.session.messages.push({
      role: "assistant",
      content: "",
      toolCalls: [call],
    });
    f.session.actions.push(action);
    f.session.edits.push({
      id: action.id,
      path: file,
      before,
      after,
      beforeHash: hash(before),
      afterHash: hash(after),
      at: action.startedAt,
    });
    f.store.save(f.session);
    const recovered = f.store.load(f.session.id);
    const runner = new ToolRunner(
      f.store,
      recovered,
      f.config,
      async () => true,
      f.emit,
    );
    runner.reconcile();
    assert.equal(
      recovered.actions[0]!.state,
      outcome === "conflicted" ? "uncertain" : "completed",
    );
    assert.equal(
      Boolean(recovered.edits[0]!.undone),
      outcome === "not-applied",
    );
    assert.equal(recovered.messages.filter((m) => m.role === "tool").length, 1);
    runner.reconcile();
    assert.equal(recovered.messages.filter((m) => m.role === "tool").length, 1);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      outcome === "applied"
        ? after
        : outcome === "not-applied"
          ? before
          : "concurrent",
    );
  });
}
test("interrupted shell is uncertain and identical action cannot blindly execute again", async (t) => {
  const f = fixture(t);
  const call = tool("shell-timeout", "shell", {
    command: "printf started > side-effect.txt; sleep 5",
    timeoutMs: 60,
  });
  const result = await f.runner.execute(call, signal());
  assert.match(result, /UNCERTAIN OUTCOME/);
  assert.equal(f.session.actions[0]!.state, "uncertain");
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "side-effect.txt"), "utf8"),
    "started",
  );
  await assert.rejects(
    () => f.runner.execute(call, signal()),
    /uncertain outcome/,
  );
  const reloaded = f.store.load(f.session.id);
  new ToolRunner(
    f.store,
    reloaded,
    f.config,
    async () => true,
    f.emit,
  ).reconcile();
  assert.equal(reloaded.actions[0]!.state, "uncertain");
});
test("incomplete or schema-invalid tool JSON has no persisted execution intent", async (t) => {
  const f = fixture(t);
  for (const argumentsText of [
    '{"path":',
    '{"path":"file","content":"x","expectedHash":null,"shell":"rm -rf"}',
  ]) {
    assert.match(
      await f.runner.execute(
        { id: randomUUID(), name: "write_file", arguments: argumentsText },
        signal(),
      ),
      /Invalid tool arguments/,
    );
  }
  assert.equal(f.session.actions.length, 0);
});
test("shell strips credential-like environment variables and captures real exit status", async (t) => {
  const f = fixture(t);
  const before = process.env.FAAC_TEST_SECRET;
  process.env.FAAC_TEST_SECRET = "not-a-real-credential";
  t.after(() => {
    if (before === undefined) delete process.env.FAAC_TEST_SECRET;
    else process.env.FAAC_TEST_SECRET = before;
  });
  const result = await f.runner.execute(
    tool("shell", "shell", {
      command:
        "node -e \"console.log(process.env.FAAC_TEST_SECRET || 'credential absent');process.exit(7)\"",
    }),
    signal(),
  );
  assert.match(result, /credential absent/);
  assert.match(result, /Exit code: 7/);
  assert(!result.includes("not-a-real-credential"));
});

test("crash during undo of a newly-created file recovers deletion and marks original edit undone", (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "created-before-crash.txt");
  const contents = "created by faac";
  f.session.edits.push({
    id: "original-edit",
    path: file,
    before: null,
    after: contents,
    beforeHash: null,
    afterHash: hash(contents),
    at: new Date().toISOString(),
  });
  const action: PendingAction = {
    id: "undo-action",
    call: tool("undo-call", "undo", { editId: "original-edit" }),
    state: "running",
    startedAt: new Date().toISOString(),
    path: file,
    beforeHash: hash(contents),
    afterHash: null,
  };
  f.session.actions.push(action);
  f.store.save(f.session); // Deletion took place before state completion was committed.
  f.runner.reconcile();
  assert.equal(action.state, "completed");
  assert.equal(f.session.edits[0]!.undone, true);
  assert(!fs.existsSync(file));
});

test("recovery restores actual completed shell result when crash preceded conversation tool message", (t) => {
  const f = fixture(t);
  const call = tool("completed-shell-before-crash", "shell", {
    command: "publish-artifact",
  });
  f.session.messages.push({
    role: "assistant",
    content: "",
    toolCalls: [call],
  });
  f.session.actions.push({
    id: "completed-publish",
    call,
    state: "completed",
    startedAt: new Date().toISOString(),
    result: "Exit code: 0\nPublished artifact receipt 123",
  });
  f.store.save(f.session);
  f.runner.reconcile();
  const result = f.session.messages.find(
    (m) => m.role === "tool" && m.toolCallId === call.id,
  )!;
  assert.equal(result.content, "Exit code: 0\nPublished artifact receipt 123");
  assert(!result.content.includes("No action taken"));
});

test("crash before tool intent fills unexecuted results without inventing actions or replaying", (t) => {
  const f = fixture(t);
  const call = tool("never-started", "shell", { command: "publish-artifact" });
  f.session.messages.push({
    role: "assistant",
    content: "",
    toolCalls: [call],
  });
  f.runner.reconcile();
  const result = f.session.messages.find(
    (m) => m.role === "tool" && m.toolCallId === call.id,
  )!;
  assert.match(result.content, /unexecuted/);
  assert.equal(f.session.actions.length, 0);
  f.runner.reconcile();
  assert.equal(f.session.messages.filter((m) => m.role === "tool").length, 1);
});

test("credential-bearing source cannot be overwritten or copied into lossy reversible backups", async (t) => {
  const f = fixture(t);
  const secret = "registered-fake-source-key-123";
  f.store.redactor.add(secret);
  const file = path.join(f.workspace, "configuration.ts");
  const original = `export const key = "${secret}";\nexport const value = 1;\n`;
  fs.writeFileSync(file, original);
  const result = await f.runner.execute(
    tool("sensitive-patch", "patch_file", {
      path: "configuration.ts",
      oldText: "value = 1",
      newText: "value = 2",
      expectedHash: hash(original),
    }),
    signal(),
  );
  assert.match(result, /Protected credential-like content/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(f.session.edits.length, 0);
  assert(!JSON.stringify(f.store.load(f.session.id)).includes(secret));
});
