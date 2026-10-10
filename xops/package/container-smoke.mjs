#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const image = process.argv[2] || "faac:local";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "faac-container-"));
try {
  const workspace = path.join(temporary, "workspace");
  const state = path.join(temporary, "state");
  fs.mkdirSync(workspace);
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(workspace, "preserve.txt"),
    "existing user work\n",
  );
  const user = `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`;
  const base = [
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    user,
    "--mount",
    `type=bind,src=${workspace},dst=/workspace`,
    "--mount",
    `type=bind,src=${state},dst=/state`,
    "--env",
    "FAAC_HOME=/state",
    "--env",
    "NO_COLOR=1",
    image,
  ];
  const run = (args) =>
    execFileSync("docker", [...base, ...args], { encoding: "utf8" });
  const expected = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).version;
  assert.equal(run(["--version"]).trim(), `faac ${expected}`);
  const status = (args = []) =>
    JSON.parse(
      JSON.parse(
        run(["--no-sync", "--json", ...args, "-p", "/status"])
          .trim()
          .split("\n")
          .at(-1),
      ).text,
    );
  const first = status();
  assert.equal(first.workspace, "/workspace");
  run(["--no-sync", "--allow-edit", "-p", "/init"]);
  assert(fs.existsSync(path.join(workspace, "AGENTS.md")));
  assert.equal(status(["--resume", first.session]).session, first.session);
  assert.equal(
    fs.readFileSync(path.join(workspace, "preserve.txt"), "utf8"),
    "existing user work\n",
  );
  const configuredUser = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Config.User}}", image],
    { encoding: "utf8" },
  ).trim();
  assert(
    configuredUser && !["root", "0", "0:0"].includes(configuredUser),
    "Image must default to non-root",
  );
  console.log(
    "Container passed: non-root default, version, workspace edit, persistent state and resume across containers; network disabled.",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
