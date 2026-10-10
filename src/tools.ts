import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPatch } from "diff";
import { z } from "zod";
import { hash, Store } from "./storage.js";
import { createRedactedStream } from "./redactionStream.js";
import type {
  Session,
  Config,
  ToolDefinition,
  ToolCall,
  Approve,
  AgentEvent,
  PendingAction,
  EditRecord,
} from "./types.js";

const pathArg = z.string().min(1).max(4096);
const schemas = {
  read_file: z
    .object({
      path: pathArg,
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    })
    .strict(),
  list_files: z.object({ path: pathArg.optional() }).strict(),
  search: z
    .object({ query: z.string().min(1).max(1000), path: pathArg.optional() })
    .strict(),
  write_file: z
    .object({
      path: pathArg,
      content: z.string().max(1_000_000),
      expectedHash: z.string().length(64).nullable(),
    })
    .strict(),
  patch_file: z
    .object({
      path: pathArg,
      oldText: z.string().min(1).max(1_000_000),
      newText: z.string().max(1_000_000),
      expectedHash: z.string().length(64),
    })
    .strict(),
  shell: z
    .object({
      command: z.string().min(1).max(20000),
      timeoutMs: z.number().int().min(1).max(300000).optional(),
    })
    .strict(),
  progress: z
    .object({
      summary: z.string().max(20000),
      remaining: z.array(z.string().max(2000)).max(100),
    })
    .strict(),
};
const prop = (description: string, type = "string") => ({ type, description });
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 file and its SHA-256 hash. Read before editing; inspect instructions first.",
    parameters: object(
      {
        path: prop("Workspace-relative path"),
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      ["path"],
    ),
  },
  {
    name: "list_files",
    description:
      "List workspace files (bounded, excludes common build/secret paths and symlinks).",
    parameters: object({ path: prop("Directory, default .") }, []),
  },
  {
    name: "search",
    description:
      "Find a literal string in workspace text files. Returns path and line; bounded output.",
    parameters: object(
      {
        query: prop("Literal case-sensitive search"),
        path: prop("Directory, default ."),
      },
      ["query"],
    ),
  },
  {
    name: "write_file",
    description:
      "Create or replace a UTF-8 file. expectedHash must match read_file; null requires no existing file. Persisted reversible edit.",
    parameters: object(
      {
        path: prop("Path"),
        content: prop("Complete file content"),
        expectedHash: {
          type: ["string", "null"],
          description: "SHA-256 of current file, null for creation",
        },
      },
      ["path", "content", "expectedHash"],
    ),
  },
  {
    name: "patch_file",
    description:
      "Replace exactly one literal occurrence after checking whole-file hash. Read current file first.",
    parameters: object(
      {
        path: prop("Path"),
        oldText: prop("Exact unique text to replace"),
        newText: prop("Replacement text"),
        expectedHash: prop("SHA-256 from read_file"),
      },
      ["path", "oldText", "newText", "expectedHash"],
    ),
  },
  {
    name: "shell",
    description:
      "Execute a shell command in the workspace after explicit approval. May affect external systems; never automatically replay an uncertain command.",
    parameters: object(
      {
        command: prop("Full shell command to approve"),
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
      },
      ["command"],
    ),
  },
  {
    name: "progress",
    description:
      "Persist what has been achieved and what remains before continuing a task.",
    parameters: object(
      {
        summary: prop("Progress summary"),
        remaining: { type: "array", items: { type: "string" } },
      },
      ["summary", "remaining"],
    ),
  },
];
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".faac",
  ".ssh",
  ".aws",
  ".gnupg",
  ".venv",
  "__pycache__",
]);
const sensitive = (file: string) =>
  /(^|[/\\])(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|.*\.(?:pem|key))$/.test(
    file,
  );
export function currentHash(file: string): string | null {
  try {
    return hash(fs.readFileSync(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export function resolveSafe(
  workspace: string,
  input: string,
): { file: string; outside: boolean } {
  const candidate = path.resolve(workspace, input);
  let parent = candidate;
  const tail: string[] = [];
  while (!fs.existsSync(parent)) {
    tail.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const real = path.join(fs.realpathSync(parent), ...tail);
  const relative = path.relative(workspace, real);
  return {
    file: real,
    outside:
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative),
  };
}
export function workspaceInstructions(
  workspace: string,
  target?: string,
): string {
  const dirs: string[] = [];
  let cur = workspace;
  while (true) {
    dirs.unshift(cur);
    const p = path.dirname(cur);
    if (p === cur) break;
    cur = p;
  }
  if (target) {
    const relative = path.relative(workspace, path.dirname(target));
    if (!relative.startsWith("..")) {
      let next = workspace;
      for (const part of relative.split(path.sep).filter(Boolean)) {
        next = path.join(next, part);
        dirs.push(next);
      }
    }
  }
  const files = [
    ...new Set(
      dirs.flatMap((dir) =>
        ["AGENTS.md", "CLAUDE.md", "GEMINI.md"].map((name) =>
          path.join(dir, name),
        ),
      ),
    ),
  ];
  return files
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .map((file) => {
      if (fs.statSync(file).size > 1_000_000)
        throw new Error(`Workspace instructions exceed 1 MB: ${file}`);
      return `--- Workspace instructions: ${file} ---\n${fs.readFileSync(file, "utf8")}`;
    })
    .join("\n\n");
}
function filesUnder(root: string, limit = 1500): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= limit) return;
      if (SKIP.has(item.name) || sensitive(item.name) || item.isSymbolicLink())
        continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) files.push(file);
    }
  };
  walk(root);
  return files;
}
export function checkpoint(session: Session, label: string): string {
  const files: Record<string, string | null> = {};
  for (const file of filesUnder(session.workspace)) {
    try {
      if (fs.statSync(file).size <= 1_000_000)
        files[path.relative(session.workspace, file)] = currentHash(file);
    } catch {}
  }
  let git: string | undefined;
  try {
    git = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: session.workspace,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  const id = randomUUID();
  session.checkpoints.push({
    id,
    at: new Date().toISOString(),
    label,
    files,
    git,
  });
  return id;
}
export function sessionDiff(session: Session): string {
  return (
    session.edits
      .filter((e) => !e.undone)
      .map((e) =>
        createPatch(
          path.relative(session.workspace, e.path),
          e.before || "",
          e.after || "",
          "before faac edit",
          "after faac edit",
        ),
      )
      .join("\n") || "No faac-owned edits in this session."
  );
}
export class ToolRunner {
  constructor(
    readonly store: Store,
    readonly session: Session,
    readonly config: Config,
    readonly approve: Approve,
    readonly emit: (event: AgentEvent) => void,
    readonly allowedCommands: string[] = [],
  ) {}
  private async permission(
    kind: "read" | "edit" | "shell" | "outside",
    description: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error("Cancelled");
    const policy = this.config.permissions[kind];
    if (policy === "deny") throw new Error(`Permission denied: ${kind}`);
    if (policy !== "allow" && !(await this.approve({ kind, description })))
      throw new Error(
        `Permission not granted: ${kind}.${kind === "shell" ? ` The shell already runs in ${this.session.workspace}. ${this.allowedCommands.length ? `Preapproved exact commands: ${JSON.stringify(this.allowedCommands)}. Submit one verbatim, without cd, prefixes, or suffixes.` : "No shell commands are preapproved; ask the user for permission instead of retrying."}` : " Ask the user instead of retrying a denied action."}`,
      );
    if (signal.aborted) throw new Error("Cancelled");
  }
  private async location(input: string, signal: AbortSignal): Promise<string> {
    const result = resolveSafe(this.session.workspace, input);
    if (result.outside)
      await this.permission(
        "outside",
        `Access outside workspace: ${result.file}`,
        signal,
      );
    if (sensitive(result.file)) {
      if (
        !(await this.approve({
          kind: "read",
          description: `Access potentially sensitive file ${result.file}? Contents are sent to a hosted model.`,
        }))
      )
        throw new Error("Sensitive file access denied");
    }
    if (result.file.split(path.sep).includes(".git"))
      throw new Error(
        "Direct access to .git internals is disabled; use an approved git command.",
      );
    return result.file;
  }
  async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
    const previous = this.session.actions.find((a) => a.call.id === call.id);
    if (previous) {
      if (previous.state === "completed") return previous.result || "Completed";
      throw new Error(
        "Action already has an uncertain outcome; reconcile before any retry.",
      );
    }
    if (!Object.hasOwn(schemas, call.name)) return `Unknown tool: ${call.name}`;
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
      schemas[call.name as keyof typeof schemas].parse(args);
    } catch (error) {
      const details =
        error instanceof z.ZodError
          ? error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "arguments"}: ${issue.message}`,
              )
              .join("; ")
          : "Arguments must be a complete JSON object";
      return this.store.redactor.text(
        `Invalid tool arguments. No action executed. ${details}.${call.name === "write_file" ? " For a new file, include expectedHash: null explicitly; for an existing file, read it and supply its SHA-256." : ""}`,
      );
    }
    const action: PendingAction = {
      id: randomUUID(),
      call,
      state: "intent",
      startedAt: new Date().toISOString(),
    };
    this.session.actions.push(action);
    this.store.event(this.session, "tool_intent", action);
    try {
      if (signal.aborted) throw new Error("Cancelled");
      let result: string;
      if (call.name === "progress") {
        const a = schemas.progress.parse(args);
        this.session.progress.push(a.summary);
        this.session.remaining = a.remaining;
        result = "Progress saved.";
      } else if (call.name === "shell") {
        const a = schemas.shell.parse(args);
        if (!this.allowedCommands.includes(a.command))
          await this.permission(
            "shell",
            `Run in ${this.session.workspace}:\n${a.command}\nShell execution is unsandboxed and can access outside this workspace or external services.`,
            signal,
          );
        if (this.config.permissions.shell === "deny")
          throw new Error("Shell permission denied");
        action.state = "running";
        this.store.event(this.session, "tool_running", action);
        this.emit({ type: "tool", text: `$ ${a.command}` });
        result = await this.shell(
          a.command,
          a.timeoutMs || 120000,
          signal,
          action,
        );
      } else {
        const a = args as { path?: string };
        const file = await this.location(a.path || ".", signal);
        if (call.name === "write_file" || call.name === "patch_file") {
          await this.permission("edit", `Edit ${file}`, signal);
          const instructions = workspaceInstructions(
            this.session.workspace,
            file,
          );
          const known = Object.values(this.session.instructions || {}).includes(
            instructions,
          );
          if (instructions && !known) {
            this.session.instructions ||= {};
            this.session.instructions[path.dirname(file)] = instructions;
            throw new Error(
              `New workspace instructions loaded. Read these and request the edit again with a fresh tool ID:\n${instructions}`,
            );
          }
          const beforeHash = currentHash(file);
          const before =
            beforeHash === null ? null : fs.readFileSync(file, "utf8");
          let after: string;
          let expected: string | null;
          if (call.name === "write_file") {
            const v = schemas.write_file.parse(args);
            after = v.content;
            expected = v.expectedHash;
          } else {
            const v = schemas.patch_file.parse(args);
            expected = v.expectedHash;
            if (before === null || before.split(v.oldText).length !== 2)
              throw new Error(
                "Patch requires exactly one matching oldText; read current file.",
              );
            after = before.replace(v.oldText, v.newText);
          }
          if (beforeHash !== expected)
            throw new Error(
              "Concurrent edit conflict: file hash changed. Read the actual file and merge deliberately.",
            );
          if (
            (before !== null && this.store.redactor.text(before) !== before) ||
            this.store.redactor.text(after) !== after
          )
            throw new Error(
              "Protected credential-like content cannot be stored in reversible edits. No file changed; use a deliberately approved local command for sensitive files.",
            );
          action.path = file;
          action.beforeHash = beforeHash;
          action.afterHash = hash(after);
          action.state = "running";
          const edit: EditRecord = {
            id: action.id,
            path: file,
            before,
            after,
            beforeHash,
            afterHash: hash(after),
            at: new Date().toISOString(),
          };
          this.session.edits.push(edit);
          this.store.event(this.session, "edit_prepared", action);
          if (resolveSafe(this.session.workspace, a.path || ".").file !== file)
            throw new Error(
              "Concurrent path change before edit; access must be authorized again.",
            );
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = path.join(
            path.dirname(file),
            `.faac-${randomUUID()}.tmp`,
          );
          try {
            fs.writeFileSync(tmp, after, {
              mode: before === null ? 0o644 : fs.statSync(file).mode & 0o777,
              flag: "wx",
            });
            const fd = fs.openSync(tmp, "r");
            try {
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            if (currentHash(file) !== expected)
              throw new Error(
                "Concurrent edit conflict before activation; no file replaced.",
              );
            fs.renameSync(tmp, file);
          } catch (error) {
            edit.undone = true;
            throw error;
          } finally {
            fs.rmSync(tmp, { force: true });
          }
          this.emit({
            type: "diff",
            text: createPatch(
              path.relative(this.session.workspace, file),
              before || "",
              after,
            ),
          });
          result = JSON.stringify({
            path: file,
            sha256: hash(after),
            saved: true,
          });
        } else {
          await this.permission("read", `Read ${file}`, signal);
          if (call.name === "read_file") {
            const v = schemas.read_file.parse(args);
            if (fs.statSync(file).size > 1_000_000)
              throw new Error("File exceeds 1 MB read limit");
            const text = fs.readFileSync(file, "utf8");
            const lines = text.split("\n");
            result = JSON.stringify({
              path: file,
              sha256: hash(text),
              totalLines: lines.length,
              content: lines
                .slice((v.startLine || 1) - 1, v.endLine)
                .join("\n"),
            });
          } else if (call.name === "list_files") {
            result = filesUnder(file)
              .map((f) => path.relative(this.session.workspace, f))
              .join("\n");
          } else {
            const v = schemas.search.parse(args);
            const hits: string[] = [];
            for (const f of filesUnder(file)) {
              if (signal.aborted) throw new Error("Cancelled");
              if (fs.statSync(f).size > 500000) continue;
              const content = fs.readFileSync(f, "utf8");
              if (content.includes("\0")) continue;
              content.split("\n").forEach((line, i) => {
                if (line.includes(v.query) && hits.length < 200)
                  hits.push(
                    `${path.relative(this.session.workspace, f)}:${i + 1}:${line.slice(0, 1000)}`,
                  );
              });
            }
            result = hits.join("\n") || "No matches.";
          }
        }
      }
      action.state = "completed";
      action.result = this.store.redactor.text(
        result.length > 100000
          ? `${result.slice(0, 100000)}\n[Output truncated at 100000 characters; request a narrower file line range or search.]`
          : result,
      );
      this.store.event(this.session, "tool_result", action);
      return action.result;
    } catch (error) {
      if (action.state === "running" && call.name === "shell")
        action.state = "uncertain";
      else action.state = "completed";
      action.result = this.store.redactor.text(
        error instanceof Error ? error.message : String(error),
      );
      this.store.event(this.session, "tool_error", action);
      return `${action.state === "uncertain" ? "UNCERTAIN OUTCOME — do not repeat; inspect actual state" : "Tool did not complete"}: ${action.result}`;
    }
  }
  private shell(
    command: string,
    timeout: number,
    signal: AbortSignal,
    action: PendingAction,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !/(KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH)/i.test(k),
        ),
      );
      const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], {
        cwd: this.session.workspace,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        aborted = false;
      const stop = () => {
        aborted = true;
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {}
        const kill = setTimeout(() => {
          try {
            if (child.pid && process.platform !== "win32")
              process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {}
        }, 1000);
        kill.unref();
      };
      const timer = setTimeout(stop, timeout);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      let pending = "";
      const outputRedactor = createRedactedStream(this.store.redactor);
      const flush = (final = false) => {
        const end = final ? pending.length : pending.lastIndexOf("\n") + 1;
        if (!end) return;
        const text = this.store.redactor.text(pending.slice(0, end));
        pending = pending.slice(end);
        output = (output + text).slice(-100000);
        action.result = output;
        this.store.save(this.session);
        this.emit({ type: "tool", text });
      };
      const collect = (chunk: Buffer) => {
        pending += outputRedactor.push(chunk.toString());
        flush();
        if (pending.length > 1_000_000) {
          pending = "[overlong output line omitted]";
          stop();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        reject(
          new Error("Shell spawn failed; verify whether any child started."),
        );
      });
      child.on("close", (code) => {
        pending += outputRedactor.finish();
        flush(true);
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (aborted) {
          reject(
            new Error(
              `Shell interrupted or timed out; side effects may have occurred. Captured output:\n${output}`,
            ),
          );
        } else resolve(`Exit code: ${code}\n${output}`);
      });
    });
  }
  reconcile(): string[] {
    const notes: string[] = [];
    for (const action of this.session.actions.filter(
      (a) => a.state !== "completed",
    )) {
      if (action.path && action.afterHash !== undefined) {
        const actual = currentHash(action.path);
        if (actual === action.afterHash) {
          action.state = "completed";
          action.result = `Recovered completed edit ${action.path}; SHA-256 verified.`;
          if (action.call.name === "undo") {
            const id = (JSON.parse(action.call.arguments) as { editId: string })
              .editId;
            const edit = this.session.edits.find((e) => e.id === id);
            if (edit) edit.undone = true;
          }
        } else if (actual === action.beforeHash) {
          action.state = "completed";
          action.result =
            "Edit was not applied; actual file matches pre-edit hash.";
          const edit = this.session.edits.find((e) => e.id === action.id);
          if (edit) edit.undone = true;
        } else {
          action.state = "uncertain";
          action.result =
            "Concurrent change found during recovery; inspect current file before any new edit.";
        }
      } else if (action.call.name === "shell" && action.state !== "intent") {
        action.state = "uncertain";
        action.result ||=
          "Shell outcome unknown after interruption. Do not repeat automatically.";
      } else {
        action.state = "completed";
        action.result =
          "Action interrupted before execution; not automatically replayed.";
      }
      notes.push(action.result!);
      if (
        this.session.messages.some((m) =>
          m.toolCalls?.some((c) => c.id === action.call.id),
        ) &&
        !this.session.messages.some(
          (m) => m.role === "tool" && m.toolCallId === action.call.id,
        )
      )
        this.session.messages.push({
          role: "tool",
          toolCallId: action.call.id,
          content: action.result!,
        });
    }
    for (const message of this.session.messages) {
      for (const call of message.toolCalls || []) {
        if (
          !this.session.messages.some(
            (m) => m.role === "tool" && m.toolCallId === call.id,
          )
        ) {
          const action = this.session.actions.find(
            (a) => a.call.id === call.id,
          );
          this.session.messages.push({
            role: "tool",
            toolCallId: call.id,
            content:
              action?.result ||
              "Recovered response had an unexecuted tool call. No action taken; inspect state before deciding the next action.",
          });
        }
      }
    }
    this.store.event(this.session, "recovery", notes);
    return notes;
  }
  async undo(signal: AbortSignal): Promise<string> {
    const edit = [...this.session.edits].reverse().find((e) => !e.undone);
    if (!edit)
      return "No reversible faac edits remain. Shell and external side effects cannot be undone.";
    await this.location(edit.path, signal);
    await this.permission("edit", `Undo faac edit: ${edit.path}`, signal);
    if (currentHash(edit.path) !== edit.afterHash)
      throw new Error(
        "Undo conflict: file changed after faac's edit; no changes made.",
      );
    const call: ToolCall = {
      id: randomUUID(),
      name: "undo",
      arguments: JSON.stringify({ editId: edit.id }),
    };
    const action: PendingAction = {
      id: randomUUID(),
      call,
      state: "running",
      startedAt: new Date().toISOString(),
      path: edit.path,
      beforeHash: edit.afterHash,
      afterHash: edit.beforeHash,
    };
    this.session.actions.push(action);
    this.store.event(this.session, "undo_intent", action);
    if (edit.before === null) fs.unlinkSync(edit.path);
    else {
      const tmp = path.join(
        path.dirname(edit.path),
        `.faac-${randomUUID()}.tmp`,
      );
      try {
        fs.writeFileSync(tmp, edit.before, {
          mode: fs.statSync(edit.path).mode & 0o777,
          flag: "wx",
        });
        if (currentHash(edit.path) !== edit.afterHash)
          throw new Error("Undo conflict before activation");
        fs.renameSync(tmp, edit.path);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    edit.undone = true;
    action.state = "completed";
    action.result = `Undid ${path.relative(this.session.workspace, edit.path)}`;
    this.session.messages.push({
      role: "system",
      content: action.result + ". Inspect current files before continuing.",
    });
    this.store.event(this.session, "undo_result", action);
    return action.result;
  }
}
