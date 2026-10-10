#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const metadata = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const archive = path.join(root, `build/package/faac-${metadata.version}.tgz`);
assert(fs.existsSync(archive), "Run npm run package first");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "faac-package-"));
const env = {
  ...process.env,
  FAAC_HOME: path.join(temporary, "state"),
  NO_COLOR: "1",
};
for (const key of [
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "FAAC_VAULT_PASSWORD",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
])
  delete env[key];
try {
  const install = path.join(temporary, "install");
  fs.mkdirSync(install);
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      install,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    { env, stdio: "inherit" },
  );
  const command = path.join(install, "node_modules/.bin/faac");
  const workspace = path.join(temporary, "workspace with spaces");
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, "preserve.txt"),
    "existing user work\n",
  );
  const run = (args, cwd = workspace) =>
    execFileSync(command, args, { env, cwd, encoding: "utf8" });
  assert.equal(run(["--version"]).trim(), `faac ${metadata.version}`);
  assert.match(run(["--help"]), /launch directory/u);
  const status = (args, cwd) =>
    JSON.parse(
      JSON.parse(
        run(["--json", "--no-sync", ...args, "-p", "/status"], cwd)
          .trim()
          .split("\n")
          .at(-1),
      ).text,
    );
  const initial = status([]);
  assert.equal(initial.workspace, workspace);
  assert.equal(initial.state, "idle");
  run(["--no-sync", "--allow-edit", "-p", "/init"]);
  assert(
    fs.existsSync(path.join(workspace, "AGENTS.md")),
    "Installed CLI did not create guidance",
  );
  const resumed = status(["--resume", initial.session], install);
  assert.equal(resumed.session, initial.session);
  assert.equal(resumed.workspace, workspace);
  const explicit = status(["--cwd", workspace], install);
  assert.equal(explicit.workspace, workspace);
  assert.equal(
    fs.readFileSync(path.join(workspace, "preserve.txt"), "utf8"),
    "existing user work\n",
  );
  assert(
    fs.existsSync(path.join(install, "node_modules/faac/data/baseline.json")),
  );
  console.log(
    "Installed package passed: version, help, launch directory, explicit cwd, init, durable resume, preservation; no provider calls.",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
