import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SyncManager,
  makeBaseline,
  CATALOG_PATH,
  type Baseline,
} from "../src/sync.js";
const exec = promisify(execFile);
const registry = (id: string, url: string) =>
  `export const ${id}Provider = {id:"${id}",alias:"${id}",format:"openai",executor:"default",authType:"apikey",authHeader:"bearer",baseUrl:"${url}",models:[{id:"test",name:"Test"}]};`;
const row = (id: string, type = "recurring-daily") => ({
  provider: "groq",
  modelId: id,
  displayName: id,
  monthlyTokens: 100,
  creditTokens: 0,
  freeType: type,
  poolKey: "groq-shared",
  tos: "caution",
  hardStopGuaranteed: true,
});
const catalog = (rows = [row("test")]) =>
  `export const FREE_CATALOG_CURATED_AT="2026-10-10"; export const FREE_MODEL_BUDGETS = ${JSON.stringify(rows)};`;
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "faac-sync-"));
  const repo = path.join(directory, "remote");
  const home = path.join(directory, "home");
  await fs.mkdir(repo);
  const paths = [
    "src/shared/utils/freeModels.ts",
    "src/shared/utils/payloadFreeEvidence.ts",
    "open-sse/config/freeModelCatalog.ts",
    "open-sse/config/providerRegistry.ts",
    "open-sse/config/providers/index.ts",
    "open-sse/config/providers/shared.ts",
    "open-sse/executors/base.ts",
    "open-sse/executors/base/headers.ts",
    "open-sse/executors/base/reasoningEffort.ts",
    "open-sse/config/providerFieldStrips.ts",
    "open-sse/services/openrouterFreeWindow.ts",
    "open-sse/services/accountFallback.ts",
    "open-sse/services/autoCombo/strictZeroCostFilter.ts",
    "src/sse/services/auth.ts",
  ];
  const files: Record<string, string> = Object.fromEntries(
    paths.map((file) => [file, "export const fixture = 1;"]),
  );
  files[CATALOG_PATH] = catalog();
  files["src/lib/catalog/openrouterCatalog.ts"] =
    'const OPENROUTER_API_URL="https://openrouter.ai/api/v1/models"; export interface Response {data: unknown[]}';
  files["open-sse/config/providers/registry/openrouter/index.ts"] = registry(
    "openrouter",
    "https://openrouter.ai/api/v1/chat/completions",
  );
  files["open-sse/config/providers/registry/groq/index.ts"] = registry(
    "groq",
    "https://api.groq.com/openai/v1/chat/completions",
  );
  files["open-sse/executors/base/headers.ts"] =
    'import { marker } from "./nested.ts"; export const headers = marker;';
  files["open-sse/executors/base/nested.ts"] =
    'export const marker = "bearer";';
  const write = async (file: string, value: string) => {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), value);
  };
  for (const [file, value] of Object.entries(files)) await write(file, value);
  const git = async (args: string[]) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args])
    ).stdout.trim();
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "faac test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  const commit = async () => {
    await git(["add", "."]);
    await git(["commit", "-m", "fixture"]);
    return git(["rev-parse", "HEAD"]);
  };
  const initialCommit = await commit();
  const baseline: Baseline = makeBaseline(files, initialCommit, repo, "main");
  const config = { enabled: true, intervalMinutes: 60, remote: repo };
  const manager = new SyncManager(home, config, baseline);
  await manager.initialize();
  return {
    directory,
    home,
    repo,
    manager,
    baseline,
    files,
    config,
    write,
    commit,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test("Git default branch discovery, compatible catalog additions/removals/eligibility and rollback", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.manager.check()).state, "unchanged");
    assert.equal(f.manager.status().branch, "main");
    assert.deepEqual(
      f.manager.status().changes,
      [],
      "object key order is not a catalog change",
    );
    const pinned = f.manager.snapshot();
    await f.write(
      CATALOG_PATH,
      catalog([row("added"), row("test", "discontinued")]),
    );
    const commit = await f.commit();
    const result = await f.manager.check();
    assert.equal(result.state, "updated");
    assert.equal(result.commit, commit);
    assert(result.changes.includes("added groq/added"));
    assert(result.changes.some((x) => x.includes("eligibility")));
    assert.equal(pinned.curated.length, 1, "in-flight snapshot remains stable");
    assert.equal(f.manager.snapshot().curated.length, 2);
    const copy = f.manager.snapshot();
    copy.endpoints.groq.chat = "https://evil.invalid";
    assert.notEqual(
      f.manager.snapshot().endpoints.groq.chat,
      copy.endpoints.groq.chat,
    );
    await f.write(CATALOG_PATH, catalog([row("added")]));
    await f.commit();
    assert((await f.manager.check()).changes.includes("removed groq/test"));
    assert.equal((await f.manager.rollback()).state, "rolled-back");
    assert.equal(f.manager.snapshot().curated.length, 2);
    const resumed = new SyncManager(f.home, f.config, f.baseline);
    await resumed.initialize();
    assert.equal(resumed.snapshot().version, f.manager.snapshot().version);
    assert(
      (
        await fs.stat(path.join(f.home, "upstream", "repository.git"))
      ).isDirectory(),
    );
  } finally {
    await f.cleanup();
  }
});

test("comments and formatting do not quarantine; reviewed endpoint canonicalization applies", async () => {
  const f = await fixture();
  try {
    const target = "open-sse/config/providers/registry/groq/index.ts";
    await f.write(
      target,
      `// harmless comment\n${f.files[target]!.replaceAll('"', "'").replace("chat/completions", "chat/completions/")}`,
    );
    await f.commit();
    assert.equal((await f.manager.check()).state, "updated");
    assert.equal(
      f.manager.snapshot().endpoints.groq.chat,
      "https://api.groq.com/openai/v1/chat/completions",
    );
    assert.deepEqual(f.manager.snapshot().quarantined, {});
  } finally {
    await f.cleanup();
  }
});

test("breaking response schema quarantines only affected integration and rollback retains quarantine", async () => {
  const f = await fixture();
  try {
    await f.manager.check();
    await f.write(
      "src/lib/catalog/openrouterCatalog.ts",
      f.files["src/lib/catalog/openrouterCatalog.ts"]!.replace(
        "data: unknown[]",
        "models: unknown[]",
      ),
    );
    await f.commit();
    assert.equal((await f.manager.check()).state, "quarantined");
    assert(f.manager.snapshot().quarantined.openrouter);
    assert.equal(f.manager.snapshot().quarantined.groq, undefined);
    assert.equal((await f.manager.rollback()).state, "rolled-back");
    assert(f.manager.snapshot().quarantined.openrouter);
    await f.write(
      "src/lib/catalog/openrouterCatalog.ts",
      f.files["src/lib/catalog/openrouterCatalog.ts"]!,
    );
    await f.commit();
    assert.notEqual((await f.manager.check()).state, "quarantined");
  } finally {
    await f.cleanup();
  }
});

test("new execution/auth/capability changes and transitive dependencies fail closed", async () => {
  const f = await fixture();
  try {
    await f.write(
      "open-sse/executors/base/nested.ts",
      'export const marker="new-auth-scheme";',
    );
    await f.commit();
    const result = await f.manager.check();
    assert.equal(result.state, "quarantined");
    assert(result.quarantined.openrouter);
    assert(result.quarantined.groq);
  } finally {
    await f.cleanup();
  }
});

test("untrusted catalog expressions never run and malicious endpoints cannot activate", async () => {
  const f = await fixture();
  try {
    await f.write(
      CATALOG_PATH,
      'export const FREE_CATALOG_CURATED_AT="2026-10-10"; export const FREE_MODEL_BUDGETS=process.exit(82);',
    );
    const target = "open-sse/config/providers/registry/groq/index.ts";
    await f.write(
      target,
      registry("groq", "https://evil.invalid/openai/v1/chat/completions"),
    );
    await f.commit();
    assert.equal((await f.manager.check()).state, "quarantined");
    assert.equal(
      f.manager.snapshot().endpoints.groq.chat,
      "https://api.groq.com/openai/v1/chat/completions",
    );
    assert(f.manager.snapshot().quarantined.groq);
    assert(f.manager.snapshot().quarantined.openrouter);
    assert.equal(f.manager.snapshot().curated.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("unknown free eligibility fields quarantine; concurrent checks serialize; failed fetch preserves active", async () => {
  const f = await fixture();
  try {
    const a = f.manager.check(),
      b = f.manager.check();
    assert.equal(a, b);
    await a;
    const original = f.manager.snapshot();
    await f.write(
      CATALOG_PATH,
      catalog([
        { ...row("test"), automaticBilling: true } as ReturnType<typeof row>,
      ]),
    );
    await f.commit();
    assert.equal((await f.manager.check()).state, "quarantined");
    const version = f.manager.snapshot().version;
    const bad = new SyncManager(
      f.home,
      { ...f.config, remote: path.join(f.directory, "missing") },
      f.baseline,
    );
    await bad.initialize();
    assert.equal((await bad.check()).state, "error");
    assert.equal(bad.snapshot().version, version);
    assert.notEqual(original.version, version);
  } finally {
    await f.cleanup();
  }
});

test("activation pointer remains parseable and corrupt quarantined version recovers last-known-good", async () => {
  const f = await fixture();
  try {
    await f.manager.check();
    const good = f.manager.snapshot().version;
    await f.write(
      "src/lib/catalog/openrouterCatalog.ts",
      f.files["src/lib/catalog/openrouterCatalog.ts"]!.replace(
        "data: unknown[]",
        "records: unknown[]",
      ),
    );
    await f.commit();
    await f.manager.check();
    const broken = f.manager.snapshot().version;
    await fs.writeFile(
      path.join(f.home, "upstream", "versions", broken, "snapshot.json"),
      "incomplete",
    );
    const resumed = new SyncManager(f.home, f.config, f.baseline);
    await resumed.initialize();
    assert.notEqual(resumed.snapshot().version, broken);
    assert(
      resumed.snapshot().quarantined.openrouter,
      "corruption recovery must preserve quarantine",
    );
    const pointer = JSON.parse(
      await fs.readFile(path.join(f.home, "upstream", "active.json"), "utf8"),
    );
    assert.equal(pointer.lastKnownGood, good);
  } finally {
    await f.cleanup();
  }
});

test("capability changes quarantine their provider while unrelated new provider files do not", async () => {
  const f = await fixture();
  try {
    await f.write(
      "open-sse/config/providers/registry/unrelated/index.ts",
      'export const unrelated = {baseUrl:"https://other.invalid"};',
    );
    await f.commit();
    assert.equal((await f.manager.check()).state, "unchanged");
    const target = "open-sse/config/providers/registry/groq/index.ts";
    await f.write(
      target,
      f.files[target]!.replace('name:"Test"', 'name:"Test",toolCalling:false'),
    );
    await f.commit();
    const result = await f.manager.check();
    assert.equal(result.state, "quarantined");
    assert(result.quarantined.groq);
    assert.equal(result.quarantined.openrouter, undefined);
  } finally {
    await f.cleanup();
  }
});

test("empty lock left by a crash expires without blocking future checks", async () => {
  const f = await fixture();
  try {
    const lock = path.join(f.home, "upstream", "sync.lock");
    await fs.writeFile(lock, "");
    const earlier = new Date(Date.now() - 120000);
    await fs.utimes(lock, earlier, earlier);
    assert.equal((await f.manager.check()).state, "unchanged");
    await assert.rejects(fs.stat(lock));
  } finally {
    await f.cleanup();
  }
});
