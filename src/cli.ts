#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Application } from "./app.js";
import { Redactor } from "./storage.js";

const HELP = `faac — a durable terminal coding agent using hosted free models

Usage: faac [--cwd DIRECTORY] [--resume SESSION] [-p REQUEST]

  -C, --cwd DIRECTORY       Work here (default: launch directory)
  -p, --prompt REQUEST      Run one request or slash command, then exit
      --resume SESSION     Load and continue a saved task
      --allow-edit         Authorize reversible edits inside the workspace
      --allow-command CMD  Authorize this exact shell command (repeatable;
                           unsandboxed, may affect external files/services)
      --no-sync            Skip this launch's upstream check and polling
      --json               Emit newline-delimited JSON events
      --version            Print version
  -h, --help               Show this help

Interactive: /help lists all commands. /connect uses hidden credential input.
Input: Enter sends, Ctrl-J or Alt-Enter inserts newline, Tab completes slash
commands, Up/Down recalls history, Ctrl-C cancels, Ctrl-D exits an empty editor.

Noninteractive: pipe a request or use -p; unapproved actions are denied.
Credentials: OPENROUTER_API_KEY / GROQ_API_KEY, or encrypted /connect vault.
State: FAAC_HOME (default ~/.local/share/faac). NO_COLOR disables colors.
Example: faac -C ./project -p "Fix the failing unit test" --allow-edit
`;
let app: Application | undefined;
try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("faac requires Node.js 22 or newer.");
  const { values } = parseArgs({
    options: {
      cwd: { type: "string", short: "C" },
      prompt: { type: "string", short: "p" },
      resume: { type: "string" },
      "no-sync": { type: "boolean" },
      "allow-edit": { type: "boolean" },
      "allow-command": { type: "string", multiple: true },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) process.stdout.write(HELP);
  else if (values.version) {
    const metadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`faac ${metadata.version}\n`);
  } else {
    let prompt = values.prompt;
    if (!process.stdin.isTTY && prompt === undefined && !values.resume) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
        if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000)
          throw new Error("Input exceeds 1 MB");
      }
      prompt = Buffer.concat(chunks).toString().trim();
      if (!prompt)
        throw new Error(
          "No request supplied. Use -p REQUEST, pipe a request, or run faac in a terminal.",
        );
    }
    app = new Application({
      workspace: path.resolve(values.cwd || process.cwd()),
      resume: values.resume,
      noSync: values["no-sync"],
      allowEdit: values["allow-edit"],
      allowedCommands: values["allow-command"],
      json: values.json,
    });
    const stop = () => app?.controller.abort(new Error("Process interrupted"));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await app.initialize();
    if (prompt !== undefined) {
      await app.input(prompt);
      if (app.session.state === "blocked" || app.session.state === "cancelled")
        process.exitCode = 2;
    } else if (values.resume) {
      await app.work();
      if (process.stdin.isTTY) await app.interact();
      else if (app.session.state !== "complete") process.exitCode = 2;
    } else await app.interact();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
} catch (error) {
  const redactor = app?.store.redactor || new Redactor();
  for (const key of [
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "FAAC_VAULT_PASSWORD",
  ])
    redactor.add(process.env[key]);
  process.stderr.write(
    `faac: ${redactor.text(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exitCode = 1;
} finally {
  app?.close();
}
