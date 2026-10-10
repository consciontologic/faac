import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  Store,
  Credentials,
  Redactor,
  acquireLock,
  atomicJson,
  defaultConfig,
  readJson,
} from "../src/storage.js";
import { fixture } from "./helpers.js";

test("state and append journal persist incrementally with private modes and independent application/workspace paths", (t) => {
  const f = fixture(t);
  f.session.messages.push({ role: "user", content: "durable task" });
  f.store.event(f.session, "task", { task: "durable task" });
  const reloaded = new Store(f.store.home).load(f.session.id);
  assert.equal(reloaded.workspace, f.workspace);
  assert.notEqual(reloaded.workspace, f.store.home);
  assert.deepEqual(reloaded.messages, f.session.messages);
  const dir = f.store.sessionDir(f.session.id);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "session.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "events.jsonl")).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim())
      .kind,
    "task",
  );
});
test("corrupt persisted files are preserved and reported instead of silently reset", (t) => {
  const f = fixture(t);
  const file = path.join(f.store.home, "config.json");
  fs.writeFileSync(file, "{incomplete");
  assert.throws(() => f.store.config(), /Preserve it for recovery/);
  assert.equal(fs.readFileSync(file, "utf8"), "{incomplete");
  assert.throws(
    () => f.store.sessionDir("../../private"),
    /Invalid session ID/,
  );
  assert.deepEqual(
    readJson(path.join(f.store.home, "absent.json"), { ok: true }),
    { ok: true },
  );
});
test("config validation rejects unsafe shapes and preserves prior working configuration", (t) => {
  const f = fixture(t);
  f.store.saveConfig(f.config);
  const prior = fs.readFileSync(path.join(f.store.home, "config.json"), "utf8");
  assert.throws(() => f.store.saveConfig({ ...f.config, route: [] }));
  assert.throws(() =>
    f.store.saveConfig({
      ...f.config,
      permissions: { ...f.config.permissions, shell: "allow" },
    } as never),
  );
  assert.equal(
    fs.readFileSync(path.join(f.store.home, "config.json"), "utf8"),
    prior,
  );
});
test("workspace locks prevent concurrent faac writers and can be released idempotently", (t) => {
  const f = fixture(t);
  const release = f.store.lockWorkspace(f.workspace);
  assert.throws(
    () => f.store.lockWorkspace(f.workspace),
    /Another faac process/,
  );
  release();
  release();
  const next = f.store.lockWorkspace(f.workspace);
  next();
});
test("stale owner lock is recovered only when its PID is gone", (t) => {
  const f = fixture(t);
  const dir = path.join(f.store.home, "locks", "dead");
  fs.mkdirSync(dir, { recursive: true });
  atomicJson(path.join(dir, "owner.json"), { pid: 2147483647 });
  const release = acquireLock(dir);
  assert.equal(
    readJson<{ pid: number }>(path.join(dir, "owner.json"), { pid: 0 }).pid,
    process.pid,
  );
  release();
});
test("registered credentials and provider key patterns are redacted from sessions, events and history", (t) => {
  const f = fixture(t);
  const key = "known-test-secret-123";
  f.store.redactor.add(key);
  f.session.messages.push({
    role: "user",
    content: `key ${key} sk-or-v1-abcdefghi Authorization: Bearer topsecret`,
  });
  f.store.event(f.session, "debug", { key });
  f.store.saveHistory([`secret ${key}`]);
  for (const file of [
    path.join(f.store.sessionDir(f.session.id), "session.json"),
    path.join(f.store.sessionDir(f.session.id), "events.jsonl"),
    path.join(f.store.home, "history.json"),
  ]) {
    const raw = fs.readFileSync(file, "utf8");
    assert(!raw.includes(key));
    assert(!raw.includes("sk-or-v1-abcdefghi"));
    assert(!raw.includes("topsecret"));
    assert(raw.includes("[REDACTED]"));
  }
});
test("credential vault encrypts at rest, rejects bad passwords, and supports deliberate removal", async (t) => {
  const f = fixture(t);
  const previous = Object.fromEntries(
    ["FAAC_VAULT_PASSWORD", "OPENROUTER_API_KEY", "GROQ_API_KEY"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  for (const key of Object.keys(previous)) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const password = "test-only-passphrase-long";
  const key = "test-only-secret-api-key";
  const credentials = new Credentials(f.store, async () => password);
  await credentials.set("openrouter", key);
  const file = path.join(f.store.home, "credentials.enc.json");
  const bytes = fs.readFileSync(file, "utf8");
  assert(!bytes.includes(key));
  assert(!bytes.includes(password));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(
    await new Credentials(f.store, async () => password).get("openrouter"),
    key,
  );
  await assert.rejects(
    () =>
      new Credentials(f.store, async () => "wrong-passphrase-long").get(
        "openrouter",
      ),
    /Unable to decrypt/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  await credentials.remove("openrouter");
  assert.equal(await credentials.get("openrouter"), undefined);
});

test("successful model verification persists and is tied to adapter version", (t) => {
  const f = fixture(t);
  const model = {
    provider: "openrouter" as const,
    id: "example:free",
  } as import("../src/types.js").Model;
  f.store.markTested(model, "adapter-1");
  const next = new Store(f.store.home);
  assert(next.testedAt(model, "adapter-1"));
  assert.equal(next.testedAt(model, "adapter-2"), undefined);
});
