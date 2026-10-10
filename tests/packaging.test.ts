import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("package artifacts use bare SemVer names and checksums while retaining npm identity", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "faac-package-names-"));
  try {
    for (const entry of [
      "src",
      "data",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      fs.cpSync(entry, path.join(fixture, entry), { recursive: true });
    }
    fs.symlinkSync(
      path.resolve("node_modules"),
      path.join(fixture, "node_modules"),
      "dir",
    );
    fs.mkdirSync(path.join(fixture, "xops/package"), { recursive: true });
    fs.copyFileSync(
      "xops/package/pack.mjs",
      path.join(fixture, "xops/package/pack.mjs"),
    );
    const metadata = JSON.parse(
      fs.readFileSync(path.join(fixture, "package.json"), "utf8"),
    );
    const directory = path.join(fixture, "build/package");
    fs.mkdirSync(directory, { recursive: true });
    for (const extension of ["tgz", "cdx.json"]) {
      fs.writeFileSync(
        path.join(directory, `faac-${metadata.version}.${extension}`),
        "stale generated artifact\n",
      );
    }
    execFileSync(process.execPath, ["xops/package/pack.mjs"], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      `${metadata.version}.cdx.json`,
      `${metadata.version}.tgz`,
      "SHA256SUMS",
    ]);
    const entries = fs
      .readFileSync(path.join(directory, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n");
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      const [digest, filename] = entry.split(/\s+/u);
      assert(
        [`${metadata.version}.tgz`, `${metadata.version}.cdx.json`].includes(
          filename,
        ),
      );
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(path.join(directory, filename)))
          .digest("hex"),
        digest,
      );
    }
    const packaged = JSON.parse(
      execFileSync(
        "tar",
        [
          "-xOf",
          path.join(directory, `${metadata.version}.tgz`),
          "package/package.json",
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(packaged.name, "faac");
    assert.equal(packaged.version, metadata.version);
    assert.equal(packaged.bin.faac, "dist/cli.js");
    const priorChecksums = fs.readFileSync(
      path.join(directory, "SHA256SUMS"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ ...metadata, version: "01.1.0" }),
    );
    const rejected = spawnSync(process.execPath, ["xops/package/pack.mjs"], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Release version must be plain SemVer/u);
    assert.equal(
      fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"),
      priorChecksums,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
