// One-use test credential input. The key stays in this process/child environment.
// It is never echoed, put in command arguments, or written to a file.
import { spawn } from "node:child_process";
const target = process.argv[2] || "tests/live/smoke.ts";
if (!/^tests\/live\/[a-z0-9-]+\.ts$/.test(target))
  throw new Error("Invalid live test target");
let pending = "";
const raw = process.stdin.isTTY;
if (raw) process.stdin.setRawMode(true);
process.stdout.write("Waiting for the test API key (hidden input).\n");
process.stdin.setEncoding("utf8");
const receive = (chunk) => {
  if (chunk.includes("\x03")) process.exit(130);
  pending += chunk;
  const end = pending.search(/[\r\n]/);
  if (end === -1) return;
  const key = pending.slice(0, end).trim();
  pending = "";
  process.stdin.off("data", receive);
  if (raw) process.stdin.setRawMode(false);
  process.stdin.pause();
  if (!key || /\s/.test(key)) throw new Error("Invalid credential input");
  const child = spawn(process.execPath, ["--import", "tsx", target], {
    cwd: process.cwd(),
    env: { ...process.env, OPENROUTER_API_KEY: key, FAAC_LIVE_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // faac redacts its own output; an additional line buffer protects test failures.
  const redact = (stream, output) => {
    let line = "";
    stream.setEncoding("utf8");
    stream.on("data", (text) => {
      line += text;
      const last = line.lastIndexOf("\n");
      if (last !== -1) {
        output.write(
          line
            .slice(0, last + 1)
            .split(key)
            .join("[REDACTED]"),
        );
        line = line.slice(last + 1);
      }
    });
    stream.on("end", () => output.write(line.split(key).join("[REDACTED]")));
  };
  redact(child.stdout, process.stdout);
  redact(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  child.on("error", () => {
    process.stderr.write("Unable to start live test.\n");
    process.exitCode = 1;
  });
};
process.stdin.on("data", receive);
process.stdin.resume();
