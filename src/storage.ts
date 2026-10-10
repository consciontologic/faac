import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createHash,
  randomUUID,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { z } from "zod";
import type { Config, Session, ProviderId, Model } from "./types.js";

export const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
export function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
export function atomicJson(file: string, value: unknown): void {
  privateDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const parent = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(
      `Invalid state file: ${file}. Preserve it for recovery; do not reset automatically.`,
    );
  }
}
export class Redactor {
  private values = new Set<string>();
  add(value: string | undefined): void {
    if (value && value.length >= 6) this.values.add(value);
  }
  get maxSecretLength(): number {
    return Math.max(0, ...[...this.values].map((value) => value.length));
  }
  /** Keep complete and partial credential matches on one side of a streaming cut. */
  streamingBoundary(input: string, desired: number): number {
    const spans: Array<[number, number]> = [];
    for (const secret of this.values) {
      let from = 0;
      let at: number;
      while ((at = input.indexOf(secret, from)) !== -1) {
        spans.push([at, at + secret.length]);
        from = at + 1;
      }
    }
    const patterns = [
      /\b(?:sk-or-v1-|gsk_|sk-proj-)[a-zA-Z0-9_-]+/g,
      /(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi,
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi,
      /Authorization\s*[:=]\s*[A-Za-z]{0,6}\s*$/gi,
      /(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*$/gi,
    ];
    for (const pattern of patterns)
      for (const match of input.matchAll(pattern))
        spans.push([match.index!, match.index! + match[0].length]);
    let cut = desired;
    let previous: number;
    do {
      previous = cut;
      for (const [start, end] of spans)
        if (start < cut && end >= cut) cut = start;
    } while (cut !== previous);
    return cut;
  }
  text(input: string): string {
    let result = input;
    for (const secret of this.values) {
      result = result.split(secret).join("[REDACTED]");
      const encoded = JSON.stringify(secret).slice(1, -1);
      if (encoded !== secret) result = result.split(encoded).join("[REDACTED]");
    }
    return result
      .replace(/\b(?:sk-or-v1-|gsk_|sk-proj-)[a-zA-Z0-9_-]+/g, "[REDACTED]")
      .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi,
        "$1[REDACTED]",
      );
  }
}
export const configSchema = z
  .object({
    schema: z.literal(1),
    connections: z.record(
      z.enum(["openrouter", "groq"]),
      z.object({
        provider: z.enum(["openrouter", "groq"]),
        enabled: z.boolean(),
        freePlanConfirmed: z.boolean().optional(),
        connectedAt: z.string(),
      }),
    ),
    route: z
      .array(z.enum(["openrouter", "groq"]))
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    preferredModel: z.string().optional(),
    params: z.record(z.unknown()),
    essentialParams: z.array(z.string()),
    permissions: z.object({
      read: z.enum(["allow", "ask", "deny"]),
      edit: z.enum(["allow", "ask", "deny"]),
      shell: z.enum(["ask", "deny"]),
      outside: z.enum(["ask", "deny"]),
    }),
    sync: z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().int().min(1).max(10080),
      remote: z.string().url(),
      branch: z.string().optional(),
    }),
    maxSteps: z.number().int().min(1).max(200),
  })
  .strict();
export const defaultConfig: Config = {
  schema: 1,
  connections: {},
  route: ["openrouter", "groq"],
  params: { max_tokens: 4096, temperature: 0.2 },
  essentialParams: [],
  permissions: { read: "allow", edit: "ask", shell: "ask", outside: "ask" },
  sync: {
    enabled: true,
    intervalMinutes: 60,
    remote: "https://github.com/diegosouzapw/OmniRoute.git",
  },
  maxSteps: 40,
};
export class Store {
  readonly home: string;
  constructor(
    home = process.env.FAAC_HOME ||
      path.join(os.homedir(), ".local", "share", "faac"),
    readonly redactor = new Redactor(),
  ) {
    this.home = path.resolve(home);
    privateDir(this.home);
    privateDir(path.join(this.home, "sessions"));
  }
  config(): Config {
    return configSchema.parse(
      readJson(path.join(this.home, "config.json"), defaultConfig),
    ) as Config;
  }
  saveConfig(config: Config): void {
    atomicJson(path.join(this.home, "config.json"), configSchema.parse(config));
  }
  newSession(workspace: string): Session {
    const now = new Date().toISOString();
    const s: Session = {
      schema: 1,
      id: randomUUID(),
      workspace: fs.realpathSync(workspace),
      createdAt: now,
      updatedAt: now,
      messages: [],
      objective: "",
      progress: [],
      remaining: [],
      state: "idle",
      params: {},
      essentialParams: [],
      actions: [],
      edits: [],
      checkpoints: [],
      attempts: [],
      compactions: [],
    };
    this.save(s);
    return s;
  }
  sessionDir(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid session ID");
    return path.join(this.home, "sessions", id);
  }
  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    atomicJson(
      path.join(this.sessionDir(session.id), "session.json"),
      JSON.parse(this.redactor.text(JSON.stringify(session))),
    );
  }
  load(id: string): Session {
    const value = readJson<Session | null>(
      path.join(this.sessionDir(id), "session.json"),
      null,
    );
    if (
      !value ||
      value.schema !== 1 ||
      !Array.isArray(value.messages) ||
      !Array.isArray(value.actions)
    )
      throw new Error("Session is absent or has an unsupported schema");
    return value;
  }
  list(): Session[] {
    return fs
      .readdirSync(path.join(this.home, "sessions"))
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .flatMap((id) => {
        try {
          return [this.load(id)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  event(session: Session, kind: string, data: unknown): void {
    this.save(session);
    const fd = fs.openSync(
      path.join(this.sessionDir(session.id), "events.jsonl"),
      "a",
      0o600,
    );
    try {
      fs.writeSync(
        fd,
        this.redactor.text(
          JSON.stringify({ at: new Date().toISOString(), kind, data }),
        ) + "\n",
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  history(): string[] {
    return readJson(path.join(this.home, "history.json"), []);
  }
  saveHistory(history: string[]): void {
    atomicJson(
      path.join(this.home, "history.json"),
      history.slice(-500).map((v) => this.redactor.text(v)),
    );
  }
  markTested(model: Model, version: string): void {
    const file = path.join(this.home, "verified-models.json");
    const entries = readJson<Record<string, { at: string; version: string }>>(
      file,
      {},
    );
    entries[`${model.provider}/${model.id}`] = {
      at: new Date().toISOString(),
      version,
    };
    atomicJson(file, entries);
  }
  testedAt(model: Model, version: string): string | undefined {
    const entries = readJson<Record<string, { at: string; version: string }>>(
      path.join(this.home, "verified-models.json"),
      {},
    );
    const entry = entries[`${model.provider}/${model.id}`];
    return entry?.version === version ? entry.at : undefined;
  }
  lockWorkspace(workspace: string): () => void {
    return acquireLock(
      path.join(this.home, "locks", hash(fs.realpathSync(workspace))),
    );
  }
}
export function acquireLock(dir: string): () => void {
  privateDir(path.dirname(dir));
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = readJson<{ pid: number } | null>(
      path.join(dir, "owner.json"),
      null,
    );
    if (!owner)
      throw new Error("State lock is being initialized; retry shortly.");
    try {
      process.kill(owner.pid, 0);
      throw new Error(
        `Another faac process (${owner.pid}) owns this workspace/state lock.`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  atomicJson(path.join(dir, "owner.json"), { pid: process.pid });
  let released = false;
  return () => {
    if (!released) {
      released = true;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
interface VaultData {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
export class Credentials {
  private password?: string;
  constructor(
    private store: Store,
    private secret: (prompt: string) => Promise<string | null>,
  ) {
    for (const id of [
      "OPENROUTER_API_KEY",
      "GROQ_API_KEY",
      "FAAC_VAULT_PASSWORD",
    ])
      store.redactor.add(process.env[id]);
  }
  private async unlock(create = false): Promise<Record<string, string>> {
    const vault = readJson<VaultData | null>(
      path.join(this.store.home, "credentials.enc.json"),
      null,
    );
    if (!vault && !create) return {};
    this.password ||=
      process.env.FAAC_VAULT_PASSWORD ||
      (await this.secret(
        create
          ? "Vault passphrase (12+ characters; not stored): "
          : "Unlock faac vault: ",
      )) ||
      undefined;
    if (!this.password || this.password.length < 12) {
      this.password = undefined;
      throw new Error(
        "A vault passphrase of at least 12 characters is required. Environment API keys also work.",
      );
    }
    this.store.redactor.add(this.password);
    if (!vault) return {};
    try {
      const key = scryptSync(this.password, Buffer.from(vault.salt, "hex"), 32);
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(vault.iv, "hex"),
      );
      cipher.setAuthTag(Buffer.from(vault.tag, "hex"));
      const values = JSON.parse(
        Buffer.concat([
          cipher.update(Buffer.from(vault.ciphertext, "hex")),
          cipher.final(),
        ]).toString(),
      ) as Record<string, string>;
      Object.values(values).forEach((v) => this.store.redactor.add(v));
      return values;
    } catch {
      this.password = undefined;
      throw new Error(
        "Unable to decrypt credential vault; check the passphrase. Existing vault preserved.",
      );
    }
  }
  async get(provider: ProviderId): Promise<string | undefined> {
    const env = process.env[provider.toUpperCase() + "_API_KEY"];
    this.store.redactor.add(env);
    return env || (await this.unlock())[provider];
  }
  async set(provider: ProviderId, value: string): Promise<void> {
    const values = await this.unlock(true);
    values[provider] = value;
    this.store.redactor.add(value);
    this.write(values);
  }
  async remove(provider: ProviderId): Promise<void> {
    const values = await this.unlock();
    delete values[provider];
    if (this.password) this.write(values);
  }
  private write(values: Record<string, string>): void {
    const salt = randomBytes(16),
      iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      scryptSync(this.password!, salt, 32),
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(values)),
      cipher.final(),
    ]);
    atomicJson(path.join(this.store.home, "credentials.enc.json"), {
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    });
  }
}
