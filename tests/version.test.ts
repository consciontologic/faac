import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("CLI version follows installed package metadata", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "faac-version-"));
  try {
    cpSync("src", path.join(fixture, "src"), { recursive: true });
    symlinkSync(
      path.resolve("node_modules"),
      path.join(fixture, "node_modules"),
      "dir",
    );
    const metadata = JSON.parse(readFileSync("package.json", "utf8"));
    metadata.version = "9.8.7";
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify(metadata));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--version"],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "faac 9.8.7");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
