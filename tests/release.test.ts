import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const curatedChangelog = `# Changelog

## [Unreleased]

### Added

- This unreleased change must stay out of release notes.

## [0.1.0] - 2026-10-10

### Added

- Keep completed work when switching free models. (#12)
  Resume from the saved workspace after interruption.

### Fixed

- Preserve concurrent file edits.

## [0.0.9] - 2026-10-09

### Added

- This older change must stay out of release notes.
`;

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
    const blob = git(["hash-object", "-w", "--stdin"], curatedChangelog);
    const tree = git(["mktree"], `100644 blob ${blob}\tCHANGELOG.md\n`);
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
    assert.match(valid.stdout, /tag=0\.1\.0/u);
    assert.match(valid.stdout, /image=ghcr\.io\/consciontologic\/faac/u);
    const evidence = {
      release_sha: sha,
      tree_sha: tree,
      source_pr: 12,
      source_head_sha: sha,
      run_ids: [41, 42, 41],
      promotion_pr: 13,
    };
    const summary = path.join(fixture, "summary.md");
    const summarize = (data: unknown) => {
      fs.writeFileSync(
        path.join(fixture, "evidence.json"),
        JSON.stringify(data),
      );
      return spawnSync(
        process.execPath,
        ["xops/package/release.mjs", "summary-evidence", "evidence.json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: {
            ...env,
            GITHUB_SHA: sha,
            GITHUB_REPOSITORY: "consciontologic/faac",
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
    };
    const reused = summarize(evidence);
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, /consciontologic\/faac\/pull\/12/u);
    assert.equal(reused.stdout.match(/actions\/runs\/41/gu)?.length, 1);
    assert.equal(fs.readFileSync(summary, "utf8"), reused.stdout);
    for (const invalid of [
      { ...evidence, release_sha: "0".repeat(40) },
      { ...evidence, run_ids: [] },
      { ...evidence, run_ids: ["41"] },
      { ...evidence, run_ids: { Quality: 41 } },
    ]) {
      assert.notEqual(summarize(invalid).status, 0);
      assert.equal(
        fs.readFileSync(summary, "utf8"),
        reused.stdout,
        "Invalid evidence must not be appended to the release summary",
      );
    }
    for (const [overrides, reason] of [
      [{ FAAC_RELEASE_VERSION: "0.2.0" }, /Dispatch version must match/u],
      [{ GITHUB_REF: "refs/heads/develop" }, /Only main/u],
      [{ GITHUB_REF: "refs/tags/v0.1.0" }, /Only main/u],
      [{ GITHUB_REF: "refs/tags/faac-0.1.0" }, /Only main/u],
      [{ GITHUB_SHA: "0".repeat(40) }, /Checkout differs/u],
    ] as [Record<string, string>, RegExp][]) {
      const rejected = validate(overrides);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, reason);
    }
    git(["update-ref", "refs/tags/0.1.0", sha]);
    const tagged = validate({ GITHUB_REF: "refs/tags/0.1.0" });
    assert.notEqual(tagged.status, 0);
    assert.match(tagged.stderr, /Only main may dispatch/u);
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "faac", version: "01.1.0", type: "module" }),
    );
    const invalidSemVer = validate({ FAAC_RELEASE_VERSION: "01.1.0" });
    assert.notEqual(invalidSemVer.status, 0);
    assert.match(invalidSemVer.stderr, /plain SemVer/u);
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "faac", version: "0.1.0", type: "module" }),
    );
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
    fs.writeFileSync(recorder, "");
    const invalidVersion = spawnSync(
      process.execPath,
      [path.resolve("xops/package/publish-container.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: fixture + path.delimiter + process.env.PATH,
          RECORD: recorder,
          CASE: "absent",
          RELEASE_IMAGE: "ghcr.io/consciontologic/faac",
          RELEASE_VERSION: "01.1.0",
          RELEASE_SHA: "d".repeat(40),
        },
      },
    );
    assert.notEqual(invalidVersion.status, 0);
    assert.equal(
      fs.readFileSync(recorder, "utf8"),
      "",
      "Invalid SemVer must fail before Docker is called",
    );
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
        assert.deepEqual(
          calls.filter((call) => call[0] === "push"),
          [["push", "ghcr.io/consciontologic/faac:0.1.0"]],
        );
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("release publication uses bare SemVer for its tag, title and asset filenames", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "faac-release-names-"));
  try {
    fs.mkdirSync(path.join(fixture, "xops/package"), { recursive: true });
    fs.mkdirSync(path.join(fixture, "bin"));
    fs.copyFileSync(
      "xops/package/release.mjs",
      path.join(fixture, "xops/package/release.mjs"),
    );
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "faac", version: "0.1.0", type: "module" }),
    );
    fs.writeFileSync(
      path.join(fixture, "bin/git"),
      `#!${process.execPath}\nimport fs from 'node:fs';
console.log(process.argv[2]==='show'?fs.readFileSync('committed-changelog.md','utf8'):process.env.GITHUB_SHA);\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fixture, "committed-changelog.md"),
      curatedChangelog,
    );
    const recorder = path.join(fixture, "calls.jsonl");
    fs.writeFileSync(
      path.join(fixture, "bin/gh"),
      `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(process.env.RECORD,JSON.stringify(args)+'\\n');
if(args[0]==='api' && args[1].endsWith('/git/ref/heads/main'))console.log(process.env.GITHUB_SHA);
else if((args[0]==='api' && args[1].includes('/git/ref/tags/')) || (args[0]==='release' && args[1]==='view')) {console.error('HTTP 404: not found');process.exitCode=1;}
else if(args[0]==='release' && args[1]==='create'){fs.writeFileSync('captured-notes.md',fs.readFileSync(args[args.indexOf('--notes-file')+1]));console.log('{}');}
else console.log('{}');
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      ["xops/package/release.mjs", "publish"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: path.join(fixture, "bin") + path.delimiter + process.env.PATH,
          RECORD: recorder,
          GITHUB_SHA: "d".repeat(40),
          GITHUB_REPOSITORY: "consciontologic/faac",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = fs
      .readFileSync(recorder, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const tag = calls.find(
      (args) => args[0] === "api" && args.includes("POST"),
    );
    assert(tag?.includes("ref=refs/tags/0.1.0"));
    const release = calls.find(
      (args) => args[0] === "release" && args[1] === "create",
    );
    assert(release);
    assert.deepEqual(release.slice(0, 6), [
      "release",
      "create",
      "0.1.0",
      "build/package/0.1.0.tgz",
      "build/package/0.1.0.cdx.json",
      "build/package/SHA256SUMS",
    ]);
    assert.equal(release[release.indexOf("--title") + 1], "0.1.0");
    assert(!release.includes("--generate-notes"));
    assert(release.includes("--notes-file"));
    const notes = fs.readFileSync(
      path.join(fixture, "captured-notes.md"),
      "utf8",
    );
    assert(notes.startsWith("## [0.1.0] - 2026-10-10\n"));
    assert.match(
      notes,
      /Keep completed work[\s\S]+Resume from the saved workspace/u,
    );
    assert.match(notes, /### Fixed\n\n- Preserve concurrent file edits\./u);
    assert(!notes.includes("This unreleased change"));
    assert(!notes.includes("This older change"));
    assert.match(
      notes,
      /npm install -g https:\/\/github.com\/consciontologic\/faac\/releases\/download\/0.1.0\/0.1.0.tgz/u,
    );
    assert.match(notes, /ghcr.io\/consciontologic\/faac:0.1.0/u);
    assert(
      notes.includes(
        `https://github.com/consciontologic/faac/commit/${"d".repeat(40)}`,
      ),
    );
    assert(
      !fs.existsSync(release[release.indexOf("--notes-file") + 1]),
      "Temporary notes must be removed after publication",
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("release notes use committed curated changes and reject invalid sections before GitHub calls", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "faac-changelog-"));
  try {
    fs.mkdirSync(path.join(fixture, "xops/package"), { recursive: true });
    fs.mkdirSync(path.join(fixture, "bin"));
    fs.copyFileSync(
      "xops/package/release.mjs",
      path.join(fixture, "xops/package/release.mjs"),
    );
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ version: "0.1.0", type: "module" }),
    );
    const recorder = path.join(fixture, "calls.jsonl");
    const env = {
      ...process.env,
      PATH: path.join(fixture, "bin") + path.delimiter + process.env.PATH,
      RECORD: recorder,
      GIT_AUTHOR_NAME: "faac test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "faac test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "consciontologic/faac",
      FAAC_RELEASE_VERSION: "0.1.0",
    };
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, {
        cwd: fixture,
        env,
        input,
        encoding: "utf8",
      }).trim();
    git(["init", "--quiet", "--initial-branch=main"]);
    const commit = (changelog: string | undefined) => {
      const blob =
        changelog === undefined
          ? undefined
          : git(["hash-object", "-w", "--stdin"], changelog);
      const tree = git(
        ["mktree"],
        blob ? `100644 blob ${blob}\tCHANGELOG.md\n` : "",
      );
      const sha = git(["commit-tree", tree], "changelog fixture\n");
      git(["update-ref", "refs/heads/main", sha]);
      git(["update-ref", "refs/remotes/origin/main", sha]);
      return sha;
    };
    fs.writeFileSync(
      path.join(fixture, "bin/gh"),
      `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(process.env.RECORD,JSON.stringify(args)+'\\n');
if(args[0]==='api' && args[1].endsWith('/git/ref/heads/main'))console.log(process.env.GITHUB_SHA);
else if(args[0]==='api' && args[1].includes('/git/ref/tags/') && process.env.EXISTING) console.log(JSON.stringify({object:{type:'commit',sha:process.env.GITHUB_SHA}}));
else if(args[0]==='release' && args[1]==='view' && process.env.EXISTING) console.log(JSON.stringify({isDraft:true,body:process.env.EXISTING==='match'?fs.readFileSync('captured-notes.md','utf8'):'unreviewed generated notes'}));
else if((args[0]==='api' && args[1].includes('/git/ref/tags/')) || (args[0]==='release' && args[1]==='view')) {console.error('HTTP 404: not found');process.exitCode=1;}
else if(args[0]==='release' && args[1]==='create'){fs.writeFileSync('captured-notes.md',fs.readFileSync(args[args.indexOf('--notes-file')+1]));console.log('{}');}
else console.log('{}');\n`,
      { mode: 0o755 },
    );
    const invoke = (
      mode: string,
      sha: string,
      extra: Record<string, string> = {},
    ) =>
      spawnSync(process.execPath, ["xops/package/release.mjs", mode], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...env, GITHUB_SHA: sha, ...extra },
      });
    const validSha = commit(curatedChangelog);
    fs.writeFileSync(
      path.join(fixture, "CHANGELOG.md"),
      "Uncommitted content must never appear in release notes.",
    );
    const published = invoke("publish", validSha);
    assert.equal(published.status, 0, published.stderr);
    const notes = fs.readFileSync(
      path.join(fixture, "captured-notes.md"),
      "utf8",
    );
    assert.match(notes, /Keep completed work when switching free models/u);
    assert(!notes.includes("Uncommitted content"));
    assert(notes.includes(`/commit/${validSha}`));
    for (const mode of ["publish", "finish"]) {
      fs.writeFileSync(recorder, "");
      const mismatch = invoke(mode, validSha, { EXISTING: "mismatch" });
      assert.notEqual(mismatch.status, 0);
      assert.match(mismatch.stderr, /Existing release notes differ/u);
      const calls = fs
        .readFileSync(recorder, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert(
        !calls.some(
          (args) =>
            args.includes("POST") ||
            ["create", "edit", "upload"].includes(args[1]),
        ),
        "Mismatched notes must not mutate a release",
      );
    }
    const finished = invoke("finish", validSha, { EXISTING: "match" });
    assert.equal(finished.status, 0, finished.stderr);
    const sections: [string | undefined, RegExp][] = [
      [undefined, /CHANGELOG.md/u],
      [
        "## [Unreleased]\n\n### Added\n\n- Not released.\n",
        /exactly one section/u,
      ],
      ["## [0.1.0] - 2026-10-10\n", /is empty/u],
      ["## [0.1.0] - 2026-10-10\n\n### Added\n\n", /needs a curated entry/u],
      [
        curatedChangelog +
          "\n## [0.1.0] - 2026-10-10\n\n### Fixed\n\n- Duplicate.\n",
        /exactly one section/u,
      ],
      [
        curatedChangelog.replace("[0.1.0] - 2026-10-10", "[0.1.0]"),
        /valid YYYY-MM-DD/u,
      ],
      [
        curatedChangelog.replace(
          "[0.1.0] - 2026-10-10",
          "[0.1.0] - 2026-02-30",
        ),
        /valid YYYY-MM-DD/u,
      ],
      [
        curatedChangelog.replace("### Fixed", "### Commit subjects"),
        /unsupported or duplicate category/u,
      ],
      [
        curatedChangelog.replace("### Fixed", "### Added"),
        /unsupported or duplicate category/u,
      ],
    ];
    for (const [section, reason] of sections) {
      const sha = commit(section);
      for (const mode of ["validate", "publish", "finish"]) {
        fs.writeFileSync(recorder, "");
        const result = invoke(mode, sha);
        assert.notEqual(result.status, 0, `${mode} accepted invalid changelog`);
        assert.match(result.stderr, reason);
        assert.equal(
          fs.readFileSync(recorder, "utf8"),
          "",
          "Invalid release notes must fail before any GitHub call",
        );
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
