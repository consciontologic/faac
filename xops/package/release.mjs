#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.chdir(path.resolve(import.meta.dirname, "../.."));
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();

function changelogSection(markdown, version) {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  const headings = [];
  let fence;
  for (const [index, line] of lines.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
    } else if (!fence && /^## /u.test(line)) headings.push(index);
  }
  const matches = headings.filter((index) =>
    lines[index].startsWith(`## [${version}]`),
  );
  assert.equal(
    matches.length,
    1,
    `CHANGELOG.md must contain exactly one section for [${version}]`,
  );
  const start = matches[0];
  const date = /^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})\s*$/u.exec(
    lines[start],
  )?.[1];
  assert(
    date &&
      Number.isFinite(Date.parse(date)) &&
      new Date(date).toISOString().slice(0, 10) === date,
    `CHANGELOG.md [${version}] needs a valid YYYY-MM-DD release date`,
  );
  const end = headings.find((index) => index > start) ?? lines.length;
  const section = lines.slice(start, end).join("\n").trim();
  const categories = [...section.matchAll(/^### (.+)$/gmu)];
  assert(categories.length > 0, `CHANGELOG.md [${version}] is empty`);
  const allowed = new Set([
    "Added",
    "Changed",
    "Deprecated",
    "Removed",
    "Fixed",
    "Security",
  ]);
  const seen = new Set();
  for (const [index, category] of categories.entries()) {
    assert(
      allowed.has(category[1]) && !seen.has(category[1]),
      `CHANGELOG.md [${version}] has an unsupported or duplicate category: ${category[1]}`,
    );
    seen.add(category[1]);
    const content = section.slice(
      category.index + category[0].length,
      categories[index + 1]?.index ?? section.length,
    );
    assert(
      /^- \S/mu.test(content),
      `CHANGELOG.md [${version}] category ${category[1]} needs a curated entry`,
    );
  }
  return section;
}

function releaseNotes(version, sha, repository, image) {
  // Read immutable source, never an uncommitted local changelog or commit subjects.
  const section = changelogSection(
    run("git", ["show", `${sha}:CHANGELOG.md`]),
    version,
  );
  const release = `https://github.com/${repository}/releases/download/${version}`;
  return `${section}\n\n### Install\n\nRequires Node.js 22+ and Git.\n\n\`\`\`bash\nnpm install -g ${release}/${version}.tgz\n\`\`\`\n\n### Container\n\n\`\`\`text\n${image}:${version}\n\`\`\`\n\nSee the [container usage guide](https://github.com/${repository}/blob/${sha}/docs/guides/DEVOPS.md#run-the-container) for workspace and persistent-state mounts.\n\n### Source and integrity\n\n- Source: [\`${sha}\`](https://github.com/${repository}/commit/${sha}).\n- Curated changes: [CHANGELOG.md](https://github.com/${repository}/blob/${sha}/CHANGELOG.md).\n- [SHA256SUMS](${release}/SHA256SUMS) verifies the package and dependency inventory.\n- [${version}.cdx.json](${release}/${version}.cdx.json) lists locked production npm dependencies; container OS packages are outside this inventory.\n- Package and container provenance is published by the release workflow.\n`;
}

function assertNotes(actual, expected) {
  assert.equal(
    actual?.replace(/\r\n/gu, "\n").trim(),
    expected.trim(),
    "Existing release notes differ from the committed CHANGELOG.md; inspect the release before retrying",
  );
}

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
// Validate release notes before any tag, asset, or publication mutation.
const notes = ["validate", "publish", "finish"].includes(process.argv[2])
  ? releaseNotes(version, sha, repository, image)
  : undefined;

if (process.argv[2] === "validate") {
  const ref = process.env.GITHUB_REF;
  assert.equal(ref, "refs/heads/main", "Only main may dispatch a release");
  assert.equal(
    run("git", ["rev-parse", "origin/main"]),
    sha,
    "Release commit must be current main",
  );
  const output = `version=${version}\ntag=${tag}\nsha=${sha}\nimage=${image}\n`;
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
} else if (process.argv[2] === "summary-evidence") {
  const evidence = JSON.parse(
    fs.readFileSync(process.argv[3] || "build/release-evidence.json", "utf8"),
  );
  assert.equal(
    evidence.release_sha,
    sha,
    "Evidence identifies another release commit",
  );
  assert.match(evidence.tree_sha, /^[a-f0-9]{40}$/u);
  assert.match(evidence.source_head_sha, /^[a-f0-9]{40}$/u);
  assert(Number.isSafeInteger(evidence.source_pr) && evidence.source_pr > 0);
  assert(
    Array.isArray(evidence.run_ids),
    "Evidence must list successful run IDs",
  );
  const runIds = [...new Set(evidence.run_ids)];
  assert(
    runIds.length > 0 &&
      runIds.every((id) => Number.isSafeInteger(id) && id > 0),
  );
  const message = `### ♻️ Reused PR verification\n\nSource: [PR #${evidence.source_pr}](https://github.com/${repository}/pull/${evidence.source_pr}) at \`${evidence.source_head_sha}\`.\n\nExact Git tree: \`${evidence.tree_sha}\`.\n\nSuccessful checks: ${runIds.map((id) => `[run ${id}](https://github.com/${repository}/actions/runs/${id})`).join(", ")}.\n\n`;
  process.stdout.write(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
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
    [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "isDraft,url,body",
    ],
    { encoding: "utf8" },
  );
  const assets = [
    `build/package/${version}.tgz`,
    `build/package/${version}.cdx.json`,
    "build/package/SHA256SUMS",
  ];
  if (existing.status === 0) {
    assertNotes(JSON.parse(existing.stdout).body, notes);
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
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "faac-release-notes-"),
    );
    try {
      const notesFile = path.join(temporary, "notes.md");
      fs.writeFileSync(notesFile, notes, { mode: 0o600 });
      run("gh", [
        "release",
        "create",
        tag,
        ...assets,
        "--repo",
        repository,
        "--verify-tag",
        "--draft",
        "--notes-file",
        notesFile,
        "--title",
        version,
      ]);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  console.log(
    `Draft ${tag} prepared. Container publication and provenance must pass before publication.`,
  );
} else if (process.argv[2] === "finish") {
  const existing = JSON.parse(
    run("gh", ["release", "view", tag, "--repo", repository, "--json", "body"]),
  );
  assertNotes(existing.body, notes);
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
    "Usage: node xops/package/release.mjs validate|summary-evidence|publish|finish",
  );
