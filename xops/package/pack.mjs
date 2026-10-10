#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
process.chdir(root);
const metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.match(
  metadata.version,
  /^\d+\.\d+\.\d+$/u,
  "Release version must be plain SemVer",
);
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
const directory = path.join(root, "build/package");
fs.mkdirSync(directory, { recursive: true });
const [packed] = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    { encoding: "utf8" },
  ),
);
for (const file of packed.files) {
  assert.match(
    file.path,
    /^(?:dist\/|data\/|docs\/(?:guides\/USAGE\.md|code\/SYNC\.md|project\/ATTRIBUTION\.md|(?:code|guides|project)\/README\.md|README\.md)$|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/u,
    `Unexpected package entry: ${file.path}`,
  );
  assert(
    !/(?:^|\/)\.env|credentials|vault|sessions|node_modules/u.test(file.path),
    `Private data in package: ${file.path}`,
  );
}
for (const required of [
  "dist/cli.js",
  "data/baseline.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
]) {
  assert(
    packed.files.some((file) => file.path === required),
    `Package is missing ${required}`,
  );
}
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const components = Object.entries(lock.packages)
  .filter(([location, value]) => location && !value.dev)
  .map(([location, value]) => {
    const name = location.split("node_modules/").at(-1);
    return {
      type: "library",
      "bom-ref": location,
      name,
      version: value.version,
      purl: `pkg:npm/${name.startsWith("@") ? "%40" + name.slice(1) : name}@${value.version}`,
      ...(value.license
        ? { licenses: [{ license: { id: value.license } }] }
        : {}),
      properties: [{ name: "faac:lockfile-location", value: location }],
    };
  });
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: metadata.name,
      version: metadata.version,
    },
    properties: [
      {
        name: "faac:scope",
        value:
          "Locked production npm dependency inventory; operating-system packages are not included",
      },
    ],
  },
  components,
};
const sbomName = `faac-${metadata.version}.cdx.json`;
fs.writeFileSync(
  path.join(directory, sbomName),
  JSON.stringify(sbom, null, 2) + "\n",
);
const assets = [packed.filename, sbomName];
const checksums =
  assets
    .map(
      (filename) =>
        `${createHash("sha256")
          .update(fs.readFileSync(path.join(directory, filename)))
          .digest("hex")}  ${filename}`,
    )
    .join("\n") + "\n";
fs.writeFileSync(path.join(directory, "SHA256SUMS"), checksums);
console.log(
  JSON.stringify(
    {
      version: metadata.version,
      directory,
      assets: [...assets, "SHA256SUMS"],
      files: packed.files.length,
    },
    null,
    2,
  ),
);
