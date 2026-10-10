import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  Store,
  Credentials,
  atomicJson,
  readJson,
  configSchema,
} from "./storage.js";
import { Terminal } from "./terminal.js";
import { parseCommand, commandHelp, COMMANDS } from "./commands.js";
import {
  HostedProviders,
  CATALOG_MAX_AGE_MS,
  classifyFailure,
} from "./providers.js";
import { parameterHelp, validateParam, canonicalParam } from "./params.js";
import { SyncManager } from "./sync.js";
import { Router } from "./routing.js";
import { Engine } from "./engine.js";
import {
  ToolRunner,
  TOOL_DEFINITIONS,
  checkpoint,
  sessionDiff,
} from "./tools.js";
import type {
  AdapterSnapshot,
  Config,
  Session,
  ProviderId,
  Model,
  AgentEvent,
} from "./types.js";

export interface AppOptions {
  workspace: string;
  resume?: string;
  noSync?: boolean;
  allowEdit?: boolean;
  allowedCommands?: string[];
  json?: boolean;
  home?: string;
}
export class Application {
  readonly store: Store;
  readonly terminal: Terminal;
  readonly credentials: Credentials;
  readonly client = new HostedProviders();
  readonly router: Router;
  readonly sync: SyncManager;
  config: Config;
  session: Session;
  controller = new AbortController();
  private release: () => void;
  private stopPoll?: () => void;
  private modelsCache: Model[] = [];
  private modelsVersion = "";
  private exit = false;
  constructor(readonly options: AppOptions) {
    this.store = new Store(options.home);
    this.terminal = new Terminal({ interactive: !options.json });
    this.config = this.store.config();
    for (const provider of ["openrouter", "groq"] as const) {
      if (
        process.env[`${provider.toUpperCase()}_API_KEY`] &&
        !this.config.connections[provider]
      )
        this.config.connections[provider] = {
          provider,
          enabled: true,
          connectedAt: new Date().toISOString(),
        };
    }
    const workspace = options.resume
      ? this.store.load(options.resume).workspace
      : fs.realpathSync(options.workspace);
    this.release = this.store.lockWorkspace(workspace);
    this.session = options.resume
      ? this.store.load(options.resume)
      : this.store.newSession(workspace);
    this.credentials = new Credentials(this.store, (prompt) =>
      this.terminal.secret(prompt),
    );
    this.router = new Router(this.store.home);
    this.sync = new SyncManager(this.store.home, this.config.sync);
    this.terminal.onCancel = () =>
      this.controller.abort(new Error("Cancelled by user"));
  }
  print(text: string): void {
    const value = this.store.redactor.text(text);
    if (this.options.json)
      process.stdout.write(
        JSON.stringify({ type: "info", text: value }) + "\n",
      );
    else this.terminal.print(value);
  }
  emit = (event: AgentEvent): void => {
    const value = { ...event, text: this.store.redactor.text(event.text) };
    if (this.options.json) process.stdout.write(JSON.stringify(value) + "\n");
    else this.terminal.event(value);
  };
  header(): void {
    if (!this.options.json)
      this.terminal.header({
        workspace: this.session.workspace,
        session: this.session.id,
        model: this.session.activeModel || "auto · free only",
        state: this.session.state,
      });
  }
  async initialize(): Promise<void> {
    await this.sync.initialize();
    this.header();
    if (!this.options.noSync && this.config.sync.enabled) {
      this.emit({
        type: "status",
        text: "Checking upstream adapter/catalog updates…",
      });
      const status = await this.sync.check();
      this.emit({
        type:
          status.state === "error" || status.state === "quarantined"
            ? "warning"
            : "status",
        text: status.message,
      });
      this.stopPoll = this.sync.startPolling((status) => {
        this.modelsVersion = "";
        this.emit({ type: "status", text: `Upstream: ${status.message}` });
      });
    }
    if (
      this.session.state === "running" ||
      this.session.actions.some((a) => a.state !== "completed")
    ) {
      this.runner()
        .reconcile()
        .forEach((text) => this.emit({ type: "warning", text }));
      this.session.state = "blocked";
      this.store.save(this.session);
    }
  }
  private runner(): ToolRunner {
    return new ToolRunner(
      this.store,
      this.session,
      {
        ...this.config,
        permissions: {
          ...this.config.permissions,
          ...(this.options.allowEdit ? { edit: "allow" as const } : {}),
        },
      },
      (request) => this.terminal.confirm(request.description),
      this.emit,
      this.options.allowedCommands,
    );
  }
  async models(
    snapshot = this.sync.snapshot(),
    force = false,
  ): Promise<Model[]> {
    if (
      !force &&
      this.modelsVersion === snapshot.version &&
      this.modelsCache.length &&
      this.modelsCache.every(
        (m) => Date.now() - Date.parse(m.free.checkedAt) < 300000,
      )
    )
      return this.modelsCache;
    const result: Model[] = [];
    for (const provider of this.config.route) {
      if (snapshot.quarantined[provider]) {
        this.emit({
          type: "warning",
          text: `${provider} quarantined: ${snapshot.quarantined[provider]}`,
        });
        continue;
      }
      let key: string | undefined;
      try {
        if (this.config.connections[provider]?.enabled)
          key = await this.credentials.get(provider);
      } catch (error) {
        this.emit({ type: "warning", text: (error as Error).message });
      }
      if (provider === "groq" && !key) continue;
      const file = path.join(this.store.home, `catalog-${provider}.json`);
      try {
        const rows = await this.client.discover(
          provider,
          key,
          snapshot,
          this.config.connections[provider],
        );
        for (const model of rows)
          model.testedAt = this.store.testedAt(model, snapshot.version);
        result.push(...rows);
        atomicJson(file, { version: snapshot.version, rows });
      } catch (error) {
        this.emit({
          type: "warning",
          text: `${provider} catalog discovery failed: ${(error as Error).message}`,
        });
        const cached = readJson<{ version: string; rows: Model[] } | null>(
          file,
          null,
        );
        if (cached && cached.version === snapshot.version) {
          result.push(
            ...cached.rows.map((m) => ({
              ...m,
              free: {
                ...m.free,
                eligible:
                  m.free.eligible &&
                  Date.now() - Date.parse(m.free.checkedAt) <
                    CATALOG_MAX_AGE_MS,
                reason: `Cached discovery (${m.free.checkedAt}): ${m.free.reason}`,
              },
            })),
          );
        }
      }
    }
    this.modelsCache = result;
    this.modelsVersion = snapshot.version;
    return result;
  }
  async work(prompt?: string): Promise<void> {
    this.controller = new AbortController();
    this.header();
    const engine = new Engine({
      store: this.store,
      session: this.session,
      config: this.config,
      client: this.client,
      runner: this.runner(),
      router: this.router,
      models: (snapshot) => this.models(snapshot),
      key: (provider) => this.credentials.get(provider),
      snapshot: () => this.sync.snapshot(),
      emit: this.emit,
    });
    await engine.run(prompt, this.controller.signal);
    this.header();
  }
  async input(text: string): Promise<boolean> {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    const command = parseCommand(text);
    if (!command) {
      await this.work(text);
      return true;
    }
    const { name, args } = command;
    if (!COMMANDS.some((c) => c.name === name))
      throw new Error(`Unknown command /${name}. Use /help.`);
    const provider = (value: string | undefined): ProviderId => {
      if (value !== "openrouter" && value !== "groq")
        throw new Error("Provider must be openrouter or groq.");
      return value;
    };
    const noArgs = () => {
      if (args.length) throw new Error(commandHelp(name));
    };
    switch (name) {
      case "help":
        this.print(commandHelp(args[0]));
        break;
      case "exit":
        noArgs();
        this.exit = true;
        return false;
      case "init": {
        noArgs();
        const file = path.join(this.session.workspace, "AGENTS.md");
        if (fs.existsSync(file)) {
          this.print(
            "AGENTS.md already exists; preserved. Read it before modifying this workspace.",
          );
          break;
        }
        const content =
          "# Workspace guidance\n\n- Preserve existing and concurrent work. Read files before editing.\n- Follow the project's existing style and dependency choices.\n- Run the most focused relevant checks and report their actual results.\n- Ask before destructive changes or actions outside this workspace.\n\nAdd project-specific commands and conventions here.\n";
        this.print(
          await this.runner().execute(
            {
              id: randomUUID(),
              name: "write_file",
              arguments: JSON.stringify({
                path: "AGENTS.md",
                content,
                expectedHash: null,
              }),
            },
            this.controller.signal,
          ),
        );
        break;
      }
      case "cd": {
        if (args.length !== 1) throw new Error(commandHelp(name));
        const workspace = fs.realpathSync(
          path.resolve(this.session.workspace, args[0]!),
        );
        if (!fs.statSync(workspace).isDirectory())
          throw new Error("Workspace must be a directory.");
        if (workspace === this.session.workspace) break;
        const release = this.store.lockWorkspace(workspace);
        this.store.save(this.session);
        this.release();
        this.release = release;
        this.session = this.store.newSession(workspace);
        this.header();
        break;
      }
      case "status":
        noArgs();
        this.print(
          JSON.stringify(
            {
              workspace: this.session.workspace,
              session: this.session.id,
              state: this.session.state,
              model: this.session.activeModel || "auto",
              adapter: this.sync.snapshot().version,
              objective: this.session.objective,
              remaining: this.session.remaining,
              nextRetryAt: this.session.nextRetryAt,
              attempts: this.session.attempts.slice(-8),
              quota: this.router.status(),
              uncertain: this.session.actions
                .filter((a) => a.state === "uncertain")
                .map((a) => ({
                  id: a.id,
                  tool: a.call.name,
                  result: a.result,
                })),
            },
            null,
            2,
          ),
        );
        break;
      case "models": {
        if (args.length > 1) throw new Error(commandHelp(name));
        if (args[0] === "auto") {
          delete this.config.preferredModel;
          this.store.saveConfig(this.config);
          this.print("Automatic free-only model selection enabled.");
          break;
        }
        const models = await this.models(
          this.sync.snapshot(),
          args[0] === "refresh",
        );
        if (args[0] && args[0] !== "refresh") {
          const selected = models.find(
            (m) => `${m.provider}/${m.id}` === args[0] || m.id === args[0],
          );
          if (!selected?.free.eligible)
            throw new Error(
              "Unknown or ineligible model; /models refresh lists eligible choices.",
            );
          this.config.preferredModel = selected.id;
          this.store.saveConfig(this.config);
          this.print(
            `Preferred ${selected.provider}/${selected.id}; free fallback stays enabled.`,
          );
          break;
        }
        this.print(
          models
            .filter((m) => m.free.eligible)
            .map(
              (m) =>
                `${m.provider}/${m.id}\n  context ${m.contextWindow} · ${m.free.kind} · ${m.testedAt ? `tested ${m.testedAt}` : "listed free; inference not tested"}\n  evidence checked ${m.free.checkedAt}: ${m.free.evidence.join(", ")}\n  ${m.free.reason}`,
            )
            .join("\n\n") ||
            "No eligible models found. /connect and /doctor explain requirements.",
        );
        const rejected = models.filter((m) => !m.free.eligible);
        this.print(
          `${rejected.length} live models excluded by pricing, capability, or account requirements. /providers shows integration rules.`,
        );
        break;
      }
      case "providers":
        noArgs();
        for (const id of ["openrouter", "groq"] as const)
          this.print(
            `${id} · official HTTPS API · ${this.config.connections[id]?.enabled ? "connected/configured (not proof of authentication)" : "disconnected"}\n${id === "openrouter" ? "Only :free variants with live zero pricing and tool support. One shared free account allowance; no paid fallback." : "Requires a confirmed Free-plan organization with billing/automatic overage disabled; curated recurring hard-stop allowance and reviewed model capabilities."}\n${this.sync.snapshot().quarantined[id] ? `QUARANTINED: ${this.sync.snapshot().quarantined[id]}` : "Adapter available"}`,
          );
        break;
      case "connect": {
        if (args.length !== 1)
          throw new Error(
            "Usage: /connect <openrouter|groq>. Never paste API keys in commands; the hidden prompt stores them encrypted.",
          );
        const id = provider(args[0]);
        let freePlanConfirmed = false;
        if (id === "groq") {
          freePlanConfirmed = await this.terminal.confirm(
            "Confirm this Groq organization uses the Free plan, has no paid billing/automatic overage, and stops requests at its free limits. faac cannot determine billing plan through /models.",
          );
          if (!freePlanConfirmed)
            throw new Error(
              "Groq remains ineligible until its free plan and hard spending stop are confirmed.",
            );
        }
        const env = process.env[`${id.toUpperCase()}_API_KEY`];
        if (!env) {
          const secret = await this.terminal.secret(`${id} API key (hidden): `);
          if (!secret)
            throw new Error(
              `No key entered. Set ${id.toUpperCase()}_API_KEY in the environment or use interactive /connect.`,
            );
          await this.credentials.set(id, secret.trim());
        }
        this.config.connections[id] = {
          provider: id,
          enabled: true,
          freePlanConfirmed,
          connectedAt: new Date().toISOString(),
        };
        this.store.saveConfig(this.config);
        await this.router.resetAccount(id);
        this.modelsVersion = "";
        this.print(
          `${id} credential configured securely. /doctor live verifies authenticated inference separately.`,
        );
        break;
      }
      case "disconnect": {
        if (args.length !== 1) throw new Error(commandHelp(name));
        const id = provider(args[0]);
        await this.credentials.remove(id);
        this.config.connections[id] = {
          provider: id,
          enabled: false,
          connectedAt: new Date().toISOString(),
        };
        this.store.saveConfig(this.config);
        this.modelsVersion = "";
        this.print(
          `${id} disabled; stored credential removed. If set, unset ${id.toUpperCase()}_API_KEY in your shell too.`,
        );
        break;
      }
      case "route":
        if (!args.length) {
          this.print(
            `Strict free-only: ${this.config.route.join(" → ")}; priority fallback, max 8 attempts per response, bounded jittered retries. OpenRouter daily pool conservatively capped at 50. Paid routing cannot be enabled.`,
          );
        } else {
          const next = configSchema.parse({
            ...this.config,
            route: args.map(provider),
          }) as Config;
          this.store.saveConfig(next);
          this.config = next;
          this.modelsVersion = "";
          this.print(`Priority: ${this.config.route.join(" → ")}`);
        }
        break;
      case "params": {
        const active = this.modelsCache.find(
          (m) =>
            `${m.provider}/${m.id}` === this.session.activeModel ||
            m.id === this.config.preferredModel,
        );
        if (!args.length) {
          this.print(parameterHelp(active));
          this.print(
            JSON.stringify(
              {
                persistent: this.config.params,
                session: this.session.params,
                essential: [
                  ...this.config.essentialParams,
                  ...this.session.essentialParams,
                ],
              },
              null,
              2,
            ),
          );
          break;
        }
        const [action, param, ...valueParts] = args;
        if (!param) throw new Error(commandHelp(name));
        const key = canonicalParam(param);
        if (action === "reset") {
          delete this.session.params[key];
          delete this.config.params[key];
          this.session.essentialParams = this.session.essentialParams.filter(
            (p) => p !== key,
          );
          this.config.essentialParams = this.config.essentialParams.filter(
            (p) => p !== key,
          );
        } else if (action === "essential") {
          const value = JSON.parse(valueParts.join(" "));
          if (typeof value !== "boolean")
            throw new Error("essential requires true or false");
          if (value)
            validateParam(
              key,
              this.session.params[key] ?? this.config.params[key],
              active,
            );
          this.session.essentialParams = this.session.essentialParams.filter(
            (p) => p !== key,
          );
          if (value) this.session.essentialParams.push(key);
        } else if (action === "set" || action === "default") {
          let value: unknown;
          try {
            value = JSON.parse(valueParts.join(" "));
          } catch {
            throw new Error(
              'Parameter value must be JSON. Quote objects with single quotes, for example \'{"effort":"low"}\'.',
            );
          }
          const checked = validateParam(key, value, active);
          (action === "set" ? this.session.params : this.config.params)[key] =
            checked;
        } else throw new Error(commandHelp(name));
        this.store.saveConfig(this.config);
        this.store.save(this.session);
        this.print(
          `Parameter ${key} updated. Essential settings exclude incompatible fallback models.`,
        );
        break;
      }
      case "tools":
        noArgs();
        this.print(
          TOOL_DEFINITIONS.map(
            (t) =>
              `${t.name}\n  ${t.description}\n  ${JSON.stringify(t.parameters)}`,
          ).join("\n\n"),
        );
        break;
      case "permissions":
        if (!args.length)
          this.print(
            JSON.stringify(this.config.permissions, null, 2) +
              "\nShell is unsandboxed; every command needs approval. Outside access and potentially sensitive files require confirmation.",
          );
        else {
          if (args.length !== 2) throw new Error(commandHelp(name));
          const [kind, value] = args;
          if (!["read", "edit", "shell", "outside"].includes(kind!))
            throw new Error(commandHelp(name));
          const next = {
            ...this.config,
            permissions: { ...this.config.permissions, [kind!]: value },
          };
          this.config = configSchema.parse(next) as Config;
          this.store.saveConfig(this.config);
          this.print(`${kind}: ${value}`);
        }
        break;
      case "sessions":
        noArgs();
        this.print(
          this.store
            .list()
            .map(
              (s) =>
                `${s.id} · ${s.state}\n  ${s.workspace}\n  ${s.objective.slice(0, 120)}`,
            )
            .join("\n\n") || "No saved sessions.",
        );
        break;
      case "resume": {
        if (args.length > 1) throw new Error(commandHelp(name));
        if (args[0] && args[0] !== this.session.id) {
          const next = this.store.load(args[0]);
          if (next.workspace !== this.session.workspace) {
            const release = this.store.lockWorkspace(next.workspace);
            this.release();
            this.release = release;
          }
          this.store.save(this.session);
          this.session = next;
        }
        await this.work();
        break;
      }
      case "checkpoint":
        if (args[0] === "list")
          this.print(JSON.stringify(this.session.checkpoints, null, 2));
        else if (args[0] === "resolve") {
          const action = this.session.actions.find(
            (a) => a.id === args[1] && a.state === "uncertain",
          );
          if (!action)
            throw new Error(
              "Use /status to find an uncertain action, then /checkpoint resolve <action-id>.",
            );
          if (
            !(await this.terminal.confirm(
              `Mark the outcome of ${action.call.name} reconciled? Confirm you inspected actual filesystem/external state. faac will not replay it.`,
            ))
          )
            throw new Error("Action remains uncertain.");
          action.state = "completed";
          action.result =
            (action.result || "") +
            "\nUser explicitly acknowledged and reconciled outcome; no replay.";
          this.session.messages.push({
            role: "system",
            content: `User reconciled uncertain action ${action.id}. Inspect current state before further work.`,
          });
          this.store.event(this.session, "user_reconciliation", {
            id: action.id,
          });
        } else {
          const id = checkpoint(this.session, args.join(" ") || "manual");
          this.store.save(this.session);
          this.print(
            `Checkpoint ${id} saved (file hashes, not a backup of arbitrary shell changes).`,
          );
        }
        break;
      case "diff":
        noArgs();
        this.emit({ type: "diff", text: sessionDiff(this.session) });
        break;
      case "undo":
        noArgs();
        this.print(await this.runner().undo(this.controller.signal));
        break;
      case "sync": {
        if (args.length > 1) throw new Error(commandHelp(name));
        const sub = args[0] || "check";
        if (!["check", "status", "rollback"].includes(sub))
          throw new Error(commandHelp(name));
        const status =
          sub === "status"
            ? this.sync.status()
            : sub === "rollback"
              ? await this.sync.rollback()
              : await this.sync.check();
        this.modelsVersion = "";
        this.print(JSON.stringify(status, null, 2));
        break;
      }
      case "doctor": {
        if (args.length > 1 || (args[0] && args[0] !== "live"))
          throw new Error(commandHelp(name));
        let git = "unavailable";
        try {
          git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
        } catch {}
        this.print(
          `Node ${process.version} · ${git}\nWorkspace: ${this.session.workspace}\nState: ${this.store.home}\nVault: encrypted AES-256-GCM with user passphrase; environment keys supported\nAdapter: ${this.sync.snapshot().version}\nStrict free-only routing enabled; no local models or OmniRoute server needed.`,
        );
        const probeSnapshot = this.sync.snapshot();
        const models = await this.models(probeSnapshot, true);
        this.print(
          `Catalog discovery: ${models.filter((m) => m.free.eligible).length} eligible, ${models.length} total live/cached rows. This is not authenticated generation proof.`,
        );
        for (const id of this.config.route) {
          if (!this.config.connections[id]?.enabled) {
            this.print(`${id}: no enabled credential. /connect ${id}`);
            continue;
          }
          const key = await this.credentials.get(id);
          if (!key) {
            this.print(`${id}: credential missing`);
            continue;
          }
          if (args[0] !== "live") {
            this.print(
              `${id}: credential present, inference NOT tested (use /doctor live)`,
            );
            continue;
          }
          const model = models.find(
            (m) => m.provider === id && m.free.eligible,
          );
          if (!model) {
            this.print(`${id}: no eligible tool-capable model`);
            continue;
          }
          if (!(await this.router.reserve(model))) {
            this.print(`${id}: quota/cooldown prevents live test`);
            continue;
          }
          try {
            let done = false;
            for await (const event of this.client.complete({
              model,
              messages: [{ role: "user", content: "Reply exactly FAAC_OK." }],
              tools: TOOL_DEFINITIONS,
              params: { max_tokens: 64, temperature: 0 },
              key,
              snapshot: probeSnapshot,
              signal: this.controller.signal,
            })) {
              if (event.type === "done") done = true;
            }
            if (!done) throw new Error("No complete response");
            model.testedAt = new Date().toISOString();
            this.store.markTested(model, probeSnapshot.version);
            await this.router.success(model);
            this.print(
              `${id}/${model.id}: authenticated inference completed at ${model.testedAt}. This small probe does not verify a coding task.`,
            );
          } catch (error) {
            await this.router.failure(
              model,
              classifyFailure(error, this.controller.signal),
            );
            this.print(
              `${id}: live inference failed: ${(error as Error).message}`,
            );
          }
        }
        break;
      }
      case "config":
        if (!args.length) this.print(JSON.stringify(this.config, null, 2));
        else {
          if (args[0] !== "set" || args.length < 3)
            throw new Error(commandHelp(name));
          const value = JSON.parse(args.slice(2).join(" "));
          const next = structuredClone(this.config);
          if (args[1] === "maxSteps") next.maxSteps = value;
          else if (args[1] === "sync.enabled") next.sync.enabled = value;
          else if (args[1] === "sync.intervalMinutes")
            next.sync.intervalMinutes = value;
          else
            throw new Error(
              "Editable keys: maxSteps, sync.enabled, sync.intervalMinutes. Use /params, /route, /permissions for other settings.",
            );
          this.config = configSchema.parse(next) as Config;
          this.store.saveConfig(this.config);
          this.print(
            "Configuration saved. Sync scheduling changes take effect on the next launch.",
          );
        }
        break;
    }
    return !this.exit;
  }
  async interact(): Promise<void> {
    const history = this.store.history();
    while (!this.exit) {
      const text = await this.terminal.input(history);
      if (text === null) break;
      if (!text.trim()) continue;
      if (!/^\/connect\s/i.test(text)) {
        history.push(text);
        this.store.saveHistory(history);
      }
      try {
        if (!(await this.input(text))) break;
      } catch (error) {
        this.emit({ type: "warning", text: (error as Error).message });
      }
    }
  }
  close(): void {
    this.controller.abort();
    this.stopPoll?.();
    this.store.save(this.session);
    this.terminal.close();
    this.release();
  }
}
