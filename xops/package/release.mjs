#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.chdir(path.resolve(import.meta.dirname, "../.."));
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
assert.match(
  version,
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u,
  "package.json must contain plain SemVer",
);
const sha = process.env.GITHUB_SHA || run("git", ["rev-parse", "HEAD"]);
assert.match(sha, /^[a-f0-9]{40}$/u, "Release commit must be a complete SHA");
const tag = version;
const repository = process.env.GITHUB_REPOSITORY || "consciontologic/faac";
assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const image = `ghcr.io/${repository.toLowerCase()}`;
const supplied = process.env.FAAC_RELEASE_VERSION;
if (supplied)
  assert.equal(supplied, version, "Dispatch version must match package.json");
assert.equal(
  run("git", ["rev-parse", "HEAD"]),
  sha,
  "Checkout differs from workflow commit",
);

if (process.argv[2] === "validate") {
  const ref = process.env.GITHUB_REF;
  assert(
    ref === "refs/heads/main" || ref === `refs/tags/${tag}`,
    "Only main or a matching version tag may release",
  );
  assert.equal(
    run("git", ["rev-parse", "origin/main"]),
    sha,
    "Release commit must be current main",
  );
  if (ref.startsWith("refs/tags/"))
    assert.equal(run("git", ["rev-parse", `${tag}^{commit}`]), sha);
  const output = `version=${version}\ntag=${tag}\nsha=${sha}\nimage=${image}\n`;
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
} else if (process.argv[2] === "publish") {
  assert.equal(
    run("gh", [
      "api",
      `repos/${repository}/git/ref/heads/main`,
      "--jq",
      ".object.sha",
    ]),
    sha,
    "main moved after validation; rerun the release",
  );
  const tagResult = spawnSync(
    "gh",
    ["api", `repos/${repository}/git/ref/tags/${tag}`],
    { encoding: "utf8" },
  );
  if (tagResult.status === 0) {
    let object = JSON.parse(tagResult.stdout).object;
    // Resolve annotated tags without treating tag messages as instructions.
    for (let depth = 0; object.type === "tag" && depth < 5; depth++)
      object = JSON.parse(
        run("gh", ["api", `repos/${repository}/git/tags/${object.sha}`]),
      ).object;
    assert.equal(object.type, "commit", "Tag does not resolve to a commit");
    assert.equal(object.sha, sha, "Existing tag identifies another commit");
  } else {
    assert.match(
      tagResult.stderr,
      /HTTP 404/u,
      "Could not inspect existing release tag",
    );
    run("gh", [
      "api",
      `repos/${repository}/git/refs`,
      "--method",
      "POST",
      "-f",
      `ref=refs/tags/${tag}`,
      "-f",
      `sha=${sha}`,
    ]);
  }
  const existing = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "isDraft,url"],
    { encoding: "utf8" },
  );
  const assets = [
    `build/package/${version}.tgz`,
    `build/package/${version}.cdx.json`,
    "build/package/SHA256SUMS",
  ];
  if (existing.status === 0) {
    if (JSON.parse(existing.stdout).isDraft) {
      const downloaded = fs.mkdtempSync(
        path.join(os.tmpdir(), "faac-release-assets-"),
      );
      try {
        run("gh", [
          "release",
          "download",
          tag,
          "--repo",
          repository,
          "--dir",
          downloaded,
        ]);
        for (const asset of assets) {
          const target = path.join(downloaded, path.basename(asset));
          if (fs.existsSync(target))
            assert(
              fs.readFileSync(target).equals(fs.readFileSync(asset)),
              `Existing release asset differs: ${asset}`,
            );
          else
            run("gh", ["release", "upload", tag, asset, "--repo", repository]);
        }
      } finally {
        fs.rmSync(downloaded, { recursive: true, force: true });
      }
    } else {
      const downloaded = fs.mkdtempSync(
        path.join(os.tmpdir(), "faac-release-assets-"),
      );
      try {
        run("gh", [
          "release",
          "download",
          tag,
          "--repo",
          repository,
          "--dir",
          downloaded,
        ]);
        for (const asset of assets)
          assert(
            fs
              .readFileSync(path.join(downloaded, path.basename(asset)))
              .equals(fs.readFileSync(asset)),
            `Published release asset differs: ${asset}`,
          );
      } finally {
        fs.rmSync(downloaded, { recursive: true, force: true });
      }
    }
  } else {
    assert.match(
      existing.stderr,
      /not found|HTTP 404/u,
      "Could not inspect existing release",
    );
    run("gh", [
      "release",
      "create",
      tag,
      ...assets,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--generate-notes",
      "--title",
      version,
    ]);
  }
  console.log(
    `Draft ${tag} prepared. Container publication and provenance must pass before publication.`,
  );
} else if (process.argv[2] === "finish") {
  run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    "--latest",
  ]);
} else
  throw new Error(
    "Usage: node xops/package/release.mjs validate|publish|finish",
  );
