#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

const image = process.env.RELEASE_IMAGE;
const version = process.env.RELEASE_VERSION;
const sha = process.env.RELEASE_SHA;
assert.match(image || "", /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/u);
assert.match(
  version || "",
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u,
);
assert.match(sha || "", /^[a-f0-9]{40}$/u);
const run = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const localConfig = run([
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  "faac:release",
]);
{
  const target = `${image}:${version}`;
  const remote = spawnSync(
    "docker",
    ["manifest", "inspect", "--verbose", target],
    { encoding: "utf8" },
  );
  if (remote.status === 0) {
    const manifest = JSON.parse(remote.stdout);
    const entries = Array.isArray(manifest) ? manifest : [manifest];
    assert(
      entries.some(
        (entry) => entry.SchemaV2Manifest?.config?.digest === localConfig,
      ),
      `Immutable container tag ${target} already contains different image content. Rerun only the failed publication job to reuse its tested artifact.`,
    );
  } else {
    if (!/manifest unknown|no such manifest|not found/u.test(remote.stderr)) {
      // GHCR can return denied before a package's first publication. Check
      // package absence through GitHub rather than treating all auth errors as absence.
      assert.match(
        remote.stderr,
        /denied|unauthorized/u,
        `Cannot inspect ${target}: ${remote.stderr}`,
      );
      const [owner, name] = image.slice("ghcr.io/".length).split("/");
      const ownerType = execFileSync(
        "gh",
        ["api", `repos/${owner}/${name}`, "--jq", ".owner.type"],
        { encoding: "utf8" },
      ).trim();
      const scope = ownerType === "Organization" ? "orgs" : "users";
      const packageProbe = spawnSync(
        "gh",
        ["api", `${scope}/${owner}/packages/container/${name}`],
        { encoding: "utf8" },
      );
      assert(
        packageProbe.status !== 0 && /HTTP 404/u.test(packageProbe.stderr),
        `Cannot confirm absent package ${target}; refusing to overwrite an unreadable image`,
      );
    }
  }
  run(["tag", "faac:release", target]);
  run(["push", target]);
}
const digest = run([
  "inspect",
  "--format",
  "{{index .RepoDigests 0}}",
  `${image}:${version}`,
]).split("@")[1];
assert.match(digest || "", /^sha256:[a-f0-9]{64}$/u);
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
console.log(`Published ${image}:${version} at ${digest}`);
