import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("release validation accepts exact main and rejects mismatched version, branch and commit", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "faac-release-"));
  try {
    fs.mkdirSync(path.join(fixture, "xops/package"), { recursive: true });
    fs.copyFileSync(
      "xops/package/release.mjs",
      path.join(fixture, "xops/package/release.mjs"),
    );
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "faac", version: "0.1.0", type: "module" }),
    );
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "faac test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "faac test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, {
        cwd: fixture,
        env,
        input,
        encoding: "utf8",
      }).trim();
    git(["init", "--quiet", "--initial-branch=main"]);
    const tree = git(["mktree"], "");
    const sha = git(["commit-tree", tree], "release fixture\n");
    git(["update-ref", "refs/heads/main", sha]);
    git(["update-ref", "refs/remotes/origin/main", sha]);
    const validate = (extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["xops/package/release.mjs", "validate"], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...env,
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: sha,
          GITHUB_REPOSITORY: "consciontologic/faac",
          FAAC_RELEASE_VERSION: "0.1.0",
          ...extra,
        },
      });
    const valid = validate();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /tag=v0\.1\.0/u);
    assert.match(valid.stdout, /image=ghcr\.io\/consciontologic\/faac/u);
    for (const [overrides, reason] of [
      [{ FAAC_RELEASE_VERSION: "0.2.0" }, /Dispatch version must match/u],
      [{ GITHUB_REF: "refs/heads/develop" }, /Only main/u],
      [{ GITHUB_SHA: "0".repeat(40) }, /Checkout differs/u],
    ] as [Record<string, string>, RegExp][]) {
      const rejected = validate(overrides);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, reason);
    }
    const next = git(["commit-tree", tree, "-p", sha], "main advanced\n");
    git(["update-ref", "refs/remotes/origin/main", next]);
    const stale = validate();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /Release commit must be current main/u);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("container publication refuses changed immutable tags and unresolved registry failures", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "faac-publish-"));
  try {
    const recorder = path.join(fixture, "calls.jsonl");
    const fakeDocker = `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(process.env.RECORD,JSON.stringify(args)+'\\n');
if(args[0]==='image'){console.log('sha256:'+'a'.repeat(64));}
else if(args[0]==='manifest'){
 if(process.env.CASE==='different') console.log(JSON.stringify({SchemaV2Manifest:{config:{digest:'sha256:'+'b'.repeat(64)}}}));
 else if(process.env.CASE==='same') console.log(JSON.stringify({SchemaV2Manifest:{config:{digest:'sha256:'+'a'.repeat(64)}}}));
 else {console.error(process.env.CASE==='absent'?'manifest unknown':'network timeout');process.exitCode=1;}
} else if(args[0]==='inspect'){console.log(process.env.RELEASE_IMAGE+'@sha256:'+'c'.repeat(64));}
`;
    fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(fixture, "docker"), fakeDocker, { mode: 0o755 });
    for (const scenario of ["different", "network", "same", "absent"]) {
      fs.writeFileSync(recorder, "");
      const result = spawnSync(
        process.execPath,
        [path.resolve("xops/package/publish-container.mjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: fixture + path.delimiter + process.env.PATH,
            RECORD: recorder,
            CASE: scenario,
            RELEASE_IMAGE: "ghcr.io/consciontologic/faac",
            RELEASE_VERSION: "0.1.0",
            RELEASE_SHA: "d".repeat(40),
          },
        },
      );
      const calls = fs
        .readFileSync(recorder, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      if (["different", "network"].includes(scenario)) {
        assert.notEqual(result.status, 0);
        assert(
          !calls.some((call) => ["tag", "push"].includes(call[0])),
          "Unsafe publication reached a mutation",
        );
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(calls.filter((call) => call[0] === "push").length, 2);
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
