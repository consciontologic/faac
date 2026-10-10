import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { z } from "zod";
import type { AdapterSnapshot, Config, ProviderId } from "./types.js";

const exec = promisify(execFile);
const PROVIDERS: ProviderId[] = ["openrouter", "groq"];
export const CATALOG_PATH = "open-sse/config/freeModelCatalog.data.ts";
const OPENROUTER_CATALOG = "src/lib/catalog/openrouterCatalog.ts";
const registryPath = (provider: ProviderId) =>
  `open-sse/config/providers/registry/${provider}/index.ts`;
const ROOTS: Record<string, ProviderId[]> = {
  [CATALOG_PATH]: PROVIDERS,
  [OPENROUTER_CATALOG]: ["openrouter"],
  "src/shared/utils/freeModels.ts": PROVIDERS,
  "src/shared/utils/payloadFreeEvidence.ts": PROVIDERS,
  "open-sse/config/freeModelCatalog.ts": PROVIDERS,
  "open-sse/config/providerRegistry.ts": PROVIDERS,
  "open-sse/config/providers/index.ts": PROVIDERS,
  "open-sse/config/providers/shared.ts": PROVIDERS,
  [registryPath("openrouter")]: ["openrouter"],
  [registryPath("groq")]: ["groq"],
  "open-sse/executors/base.ts": PROVIDERS,
  "open-sse/executors/base/headers.ts": PROVIDERS,
  "open-sse/executors/base/reasoningEffort.ts": PROVIDERS,
  "open-sse/config/providerFieldStrips.ts": ["groq"],
  "open-sse/services/openrouterFreeWindow.ts": ["openrouter"],
  "open-sse/services/accountFallback.ts": PROVIDERS,
  "open-sse/services/autoCombo/strictZeroCostFilter.ts": PROVIDERS,
  "src/sse/services/auth.ts": PROVIDERS,
};

const rowSchema = z
  .object({
    provider: z.string().min(1).max(128),
    modelId: z.string().min(1).max(512),
    displayName: z.string().max(512),
    monthlyTokens: z.number().finite().nonnegative(),
    creditTokens: z.number().finite().nonnegative(),
    freeType: z.enum([
      "recurring-daily",
      "recurring-monthly",
      "recurring-credit",
      "recurring-uncapped",
      "one-time-initial",
      "keyless",
      "discontinued",
    ]),
    poolKey: z.string().max(512).nullable(),
    tos: z.enum(["ok", "safe", "caution", "avoid", "ambiguous", "unknown"]),
    trainsOnPrompts: z.boolean().optional(),
    hardStopGuaranteed: z.boolean().optional(),
    eligibilityGate: z.literal("regional-identity").optional(),
  })
  .strict();

interface Guard {
  hash: string;
  providers: ProviderId[];
}
export interface Baseline {
  schema: 1;
  source: string;
  branch: string;
  snapshot: AdapterSnapshot;
  guards: Record<string, Guard>;
}
export interface SyncStatus {
  state:
    | "idle"
    | "checking"
    | "updated"
    | "unchanged"
    | "quarantined"
    | "error"
    | "rolled-back";
  message: string;
  activeVersion: string;
  commit: string;
  remote: string;
  branch?: string;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  changedFiles: string[];
  changes: string[];
  quarantined: Partial<Record<ProviderId, string>>;
}
interface Pointer {
  active: string;
  previous?: string;
  lastKnownGood: string;
  quarantined?: Partial<Record<ProviderId, string>>;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function source(file: string, text: string): ts.SourceFile {
  if (text.length > 4_000_000)
    throw new Error(`Oversized monitored source: ${file}`);
  const parsed = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // Parser diagnostics are intentionally accessed without evaluating or transpiling source.
  const diagnostics = (
    parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics?.length)
    throw new Error(`Unparseable upstream TypeScript: ${file}`);
  return parsed;
}

function literal(node: ts.Expression, depth = 0): unknown {
  if (depth > 16) throw new Error("Upstream data nesting exceeds limit");
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return literal(node.expression, depth + 1);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((item) => literal(item, depth + 1));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !property.name ||
        ts.isComputedPropertyName(property.name)
      )
        throw new Error("Only explicit literal properties are supported");
      const name = property.name.getText().replace(/^["']|["']$/g, "");
      if (
        ["__proto__", "constructor", "prototype"].includes(name) ||
        name in result
      )
        throw new Error("Unsafe or duplicate data property");
      result[name] = literal(property.initializer, depth + 1);
    }
    return result;
  }
  throw new Error(
    `Unsupported executable expression in upstream data: ${ts.SyntaxKind[node.kind]}`,
  );
}
function variable(tree: ts.SourceFile, name: string): ts.Expression {
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      )
        return declaration.initializer;
    }
  }
  throw new Error(`Expected upstream declaration missing: ${name}`);
}

function propertyName(node: ts.PropertyName): string {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : "";
}

/** Structural hash ignores comments/formatting. Only reviewed data fields are masked. */
function semanticHash(file: string, text: string): string {
  const tree = source(file, text);
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (file === "open-sse/config/providers/index.ts") {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const provider = node.moduleSpecifier.text.match(
          /\/registry\/([^/]+)\//,
        )?.[1];
        if (provider && !PROVIDERS.includes(provider as ProviderId)) return;
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isObjectLiteralExpression(node.parent) &&
        ts.isVariableDeclaration(node.parent.parent) &&
        ts.isIdentifier(node.parent.parent.name) &&
        node.parent.parent.name.text === "REGISTRY" &&
        !PROVIDERS.includes(propertyName(node.name) as ProviderId)
      )
        return;
    }
    if (
      file === CATALOG_PATH &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ["FREE_MODEL_BUDGETS", "FREE_CATALOG_CURATED_AT"].includes(node.name.text)
    ) {
      parts.push(`reviewed-data:${node.name.text}`);
      return;
    }
    if (
      file === OPENROUTER_CATALOG &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "OPENROUTER_API_URL"
    ) {
      parts.push("reviewed-endpoint:OPENROUTER_API_URL");
      return;
    }
    if (
      PROVIDERS.some((provider) => file === registryPath(provider)) &&
      ts.isPropertyAssignment(node) &&
      ["baseUrl"].includes(propertyName(node.name))
    ) {
      parts.push(`reviewed-registry:${propertyName(node.name)}`);
      return;
    }
    parts.push(String(node.kind));
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      parts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return sha(parts.join("\0"));
}

function endpoint(
  provider: ProviderId,
  kind: "models" | "chat",
  value: unknown,
): string {
  if (typeof value !== "string")
    throw new Error(`${provider} ${kind} endpoint is not a literal URL`);
  const url = new URL(value);
  const host = provider === "openrouter" ? "openrouter.ai" : "api.groq.com";
  const prefix = provider === "openrouter" ? "/api/v1" : "/openai/v1";
  const expected = `${prefix}/${kind === "chat" ? "chat/completions" : "models"}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== expected
  )
    throw new Error(
      `${provider} endpoint outside reviewed official API contract`,
    );
  url.pathname = expected;
  return url.href;
}
function parseRegistry(
  provider: ProviderId,
  text: string,
): { models: string; chat: string } {
  const record = literal(
    variable(source(registryPath(provider), text), `${provider}Provider`),
  ) as Record<string, unknown>;
  if (
    record.id !== provider ||
    record.format !== "openai" ||
    record.executor !== "default" ||
    record.authType !== "apikey" ||
    record.authHeader !== "bearer"
  )
    throw new Error(`${provider} authentication or protocol contract changed`);
  const chat = endpoint(provider, "chat", record.baseUrl);
  if (!Array.isArray(record.models) || record.models.length > 10000)
    throw new Error(`${provider} registry model schema changed`);
  for (const model of record.models) {
    if (
      !model ||
      typeof model !== "object" ||
      typeof (model as Record<string, unknown>).id !== "string" ||
      typeof (model as Record<string, unknown>).name !== "string"
    )
      throw new Error(`${provider} registry model schema changed`);
  }
  return {
    chat,
    models: endpoint(
      provider,
      "models",
      chat.replace(/chat\/completions\/?$/, "models"),
    ),
  };
}
function parseCatalog(
  text: string,
): Pick<AdapterSnapshot, "curated" | "curatedAt"> {
  const tree = source(CATALOG_PATH, text);
  const entries = z
    .array(rowSchema)
    .max(20000)
    .parse(literal(variable(tree, "FREE_MODEL_BUDGETS")));
  const curatedAt = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .parse(literal(variable(tree, "FREE_CATALOG_CURATED_AT")));
  const seen = new Set<string>();
  for (const item of entries) {
    const id = `${item.provider}/${item.modelId}`;
    if (seen.has(id)) throw new Error(`Duplicate upstream model: ${id}`);
    seen.add(id);
  }
  return {
    curated: entries.map((item) => ({
      ...item,
      poolKey: item.poolKey ?? `${item.provider}:${item.modelId}`,
    })),
    curatedAt,
  };
}

function imports(file: string, text: string, available: Set<string>): string[] {
  const paths: string[] = [];
  const add = (name: string): void => {
    let resolved: string;
    if (name.startsWith("./") || name.startsWith("../"))
      resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), name),
      );
    else if (name.startsWith("@/")) resolved = `src/${name.slice(2)}`;
    else if (name.startsWith("@omniroute/open-sse/"))
      resolved = `open-sse/${name.slice("@omniroute/open-sse/".length)}`;
    else return;
    // Other providers' concrete implementations do not form either supported adapter.
    const registry = resolved.match(
      /^open-sse\/config\/providers\/registry\/([^/]+)/,
    )?.[1];
    if (registry && !PROVIDERS.includes(registry as ProviderId)) return;
    if (!/^(src|open-sse)\//.test(resolved)) return;
    // Follow the API, quota and authentication contracts adapted by faac. OmniRoute's
    // application DB, UI, other provider implementations and combo engines are not
    // runtime dependencies of these standalone clients. Changes to imports in any
    // monitored boundary module still change that module's semantic fingerprint.
    const contractDependency =
      /^open-sse\/executors\/base\//.test(resolved) ||
      /^open-sse\/config\/(freeModelCatalog|freeTierCatalog|providerRegistry|providerFieldStrips|constants|providers\/(shared|registry\/(openrouter|groq)))/.test(
        resolved,
      ) ||
      /^open-sse\/services\/(accountFallback|openrouter|apiKeyRotator|providerRequestDefaults|contextManager|provider\.|tokenRefresh|rateLimit|freeAccess)/.test(
        resolved,
      ) ||
      /^open-sse\/utils\/(error|sse|stream|fetch|retry|abort|network|timeout)/.test(
        resolved,
      ) ||
      /^src\/sse\/services\/(auth|credential|account|modelScoped|expiryFirst|connection|noAuth|quotaPreflight|compatibleNode)/.test(
        resolved,
      ) ||
      /^src\/shared\/(network|resilience)\//.test(resolved) ||
      /^src\/shared\/utils\/(freeModels|payloadFreeEvidence|globPattern|numeric|timingSafeCompare|upstreamError|apiKey)/.test(
        resolved,
      ) ||
      /^src\/lib\/resilience\//.test(resolved);
    if (!contractDependency) return;
    const candidates = [
      resolved,
      `${resolved}.ts`,
      `${resolved}.tsx`,
      `${resolved}/index.ts`,
      resolved.replace(/\.js$/, ".ts"),
    ];
    const found = candidates.find((candidate) => available.has(candidate));
    if (found) paths.push(found);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source(file, text));
  return paths;
}

export function makeBaseline(
  files: Record<string, string>,
  commit: string,
  remote: string,
  branch: string,
): Baseline {
  const guards: Record<string, Guard> = {};
  const available = new Set(Object.keys(files));
  const visit = (file: string, providers: ProviderId[]): void => {
    if (!(file in files)) throw new Error(`Required source missing: ${file}`);
    const current = guards[file];
    const additional = providers.filter(
      (provider) => !current?.providers.includes(provider),
    );
    if (current && !additional.length) return;
    guards[file] = {
      hash: semanticHash(file, files[file]!),
      providers: [...new Set([...(current?.providers ?? []), ...providers])],
    };
    for (const dependency of imports(file, files[file]!, available))
      visit(dependency, additional.length ? additional : providers);
  };
  for (const [file, providers] of Object.entries(ROOTS)) visit(file, providers);
  const endpoints = {
    openrouter: parseRegistry("openrouter", files[registryPath("openrouter")]!),
    groq: parseRegistry("groq", files[registryPath("groq")]!),
  };
  endpoints.openrouter.models = endpoint(
    "openrouter",
    "models",
    literal(
      variable(
        source(OPENROUTER_CATALOG, files[OPENROUTER_CATALOG]!),
        "OPENROUTER_API_URL",
      ),
    ),
  );
  const snapshot: AdapterSnapshot = {
    version: "baseline",
    commit,
    createdAt: new Date().toISOString(),
    endpoints,
    quarantined: {},
    ...parseCatalog(files[CATALOG_PATH]!),
    fileHashes: Object.fromEntries(
      Object.keys(guards).map((file) => [file, sha(files[file]!)]),
    ),
  };
  snapshot.version = `adapter-1-${sha(JSON.stringify(snapshot.fileHashes)).slice(0, 16)}`;
  return { schema: 1, source: remote, branch, snapshot, guards };
}

function validateSnapshot(value: unknown): AdapterSnapshot {
  const schema = z.object({
    version: z.string().regex(/^adapter-1-[a-f0-9]{16}$/),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    createdAt: z.string(),
    endpoints: z.object({
      openrouter: z.object({ models: z.string(), chat: z.string() }),
      groq: z.object({ models: z.string(), chat: z.string() }),
    }),
    quarantined: z.object({
      openrouter: z.string().optional(),
      groq: z.string().optional(),
    }),
    curated: z.array(
      z
        .object({
          provider: z.string(),
          modelId: z.string(),
          freeType: z.string(),
          poolKey: z.string(),
        })
        .passthrough(),
    ),
    curatedAt: z.string(),
    fileHashes: z.record(z.string()),
  });
  const parsed = schema.parse(value);
  for (const provider of PROVIDERS)
    for (const kind of ["models", "chat"] as const)
      endpoint(provider, kind, parsed.endpoints[provider][kind]);
  return parsed;
}

async function atomicJSON(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class SyncManager {
  private readonly directory: string;
  private baseline!: Baseline;
  private active!: AdapterSnapshot;
  private current!: SyncStatus;
  private running?: Promise<SyncStatus>;
  constructor(
    home: string,
    private readonly config: Config["sync"],
    private readonly trustedBaseline?: Baseline,
  ) {
    this.directory = path.join(home, "upstream");
  }

  async initialize(): Promise<AdapterSnapshot> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.baseline = this.trustedBaseline
      ? structuredClone(this.trustedBaseline)
      : (JSON.parse(
          await fs.readFile(
            new URL("../data/baseline.json", import.meta.url),
            "utf8",
          ),
        ) as Baseline);
    this.baseline.snapshot = validateSnapshot(this.baseline.snapshot);
    try {
      const pointer = await this.readPointer();
      try {
        this.active = await this.readVersion(pointer.active);
      } catch {
        this.active = await this.readVersion(pointer.lastKnownGood);
        this.active.quarantined = {
          ...this.active.quarantined,
          ...pointer.quarantined,
        };
        this.active.version = `adapter-1-${sha(JSON.stringify(this.active)).slice(0, 16)}`;
        await this.saveVersion(this.active);
        await atomicJSON(path.join(this.directory, "active.json"), {
          ...pointer,
          active: this.active.version,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Persisted adapter data is invalid; restore a backup of the faac data directory",
          { cause: error },
        );
      this.active = structuredClone(this.baseline.snapshot);
      await this.saveVersion(this.active);
      await atomicJSON(path.join(this.directory, "active.json"), {
        active: this.active.version,
        lastKnownGood: this.active.version,
      });
    }
    const initial: SyncStatus = {
      state: "idle",
      message: "Bundled or persisted adapter loaded; upstream check pending",
      activeVersion: this.active.version,
      commit: this.active.commit,
      remote: this.config.remote,
      branch: this.config.branch,
      changedFiles: [],
      changes: [],
      quarantined: this.active.quarantined,
    };
    try {
      this.current = {
        ...initial,
        ...JSON.parse(
          await fs.readFile(path.join(this.directory, "status.json"), "utf8"),
        ),
        activeVersion: this.active.version,
        commit: this.active.commit,
        quarantined: this.active.quarantined,
      };
    } catch {
      this.current = initial;
    }
    return this.snapshot();
  }
  snapshot(): AdapterSnapshot {
    if (!this.active) throw new Error("SyncManager not initialized");
    return structuredClone(this.active);
  }
  status(): SyncStatus {
    return structuredClone(this.current);
  }
  check(): Promise<SyncStatus> {
    if (this.running) return this.running;
    this.running = this.withLock(() => this.performCheck()).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async rollback(): Promise<SyncStatus> {
    if (this.running) await this.running;
    return this.withLock(async () => {
      const pointer = await this.readPointer();
      const target = pointer.previous ?? pointer.lastKnownGood;
      if (target === this.active.version)
        return this.update({
          state: "unchanged",
          message: "No earlier validated adapter version is available",
        });
      const reverted = await this.readVersion(target);
      reverted.quarantined = {
        ...reverted.quarantined,
        ...this.active.quarantined,
      };
      reverted.version = `adapter-1-${sha(JSON.stringify(reverted)).slice(0, 16)}`;
      await this.activate(reverted);
      return this.update({
        state: "rolled-back",
        message:
          "Restored prior validated adapter; unresolved upstream quarantines remain enforced",
        changes: ["manual rollback"],
        changedFiles: [],
      });
    });
  }
  startPolling(onChange: (status: SyncStatus) => void): () => void {
    if (!this.config.enabled) return () => {};
    const interval = Math.max(1, this.config.intervalMinutes) * 60000;
    const timer = setInterval(() => {
      void this.check().then(onChange, () => {});
    }, interval);
    timer.unref();
    return () => clearInterval(timer);
  }
  private async readPointer(): Promise<Pointer> {
    return z
      .object({
        active: z.string().regex(/^adapter-1-[a-f0-9]{16}$/),
        previous: z
          .string()
          .regex(/^adapter-1-[a-f0-9]{16}$/)
          .optional(),
        lastKnownGood: z.string().regex(/^adapter-1-[a-f0-9]{16}$/),
        quarantined: z
          .object({
            openrouter: z.string().optional(),
            groq: z.string().optional(),
          })
          .optional(),
      })
      .parse(
        JSON.parse(
          await fs.readFile(path.join(this.directory, "active.json"), "utf8"),
        ),
      );
  }
  private async readVersion(version: string): Promise<AdapterSnapshot> {
    return validateSnapshot(
      JSON.parse(
        await fs.readFile(
          path.join(this.directory, "versions", version, "snapshot.json"),
          "utf8",
        ),
      ),
    );
  }
  private async saveVersion(snapshot: AdapterSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    await atomicJSON(
      path.join(this.directory, "versions", snapshot.version, "snapshot.json"),
      snapshot,
    );
  }
  private async activate(snapshot: AdapterSnapshot): Promise<void> {
    await this.saveVersion(snapshot);
    const pointer = await this.readPointer();
    await atomicJSON(path.join(this.directory, "active.json"), {
      active: snapshot.version,
      previous: this.active.version,
      lastKnownGood: Object.keys(snapshot.quarantined).length
        ? pointer.lastKnownGood
        : snapshot.version,
      quarantined: snapshot.quarantined,
    });
    this.active = snapshot;
  }
  private async update(partial: Partial<SyncStatus>): Promise<SyncStatus> {
    this.current = {
      ...this.current,
      ...partial,
      activeVersion: this.active.version,
      commit: this.active.commit,
      quarantined: this.active.quarantined,
    };
    await atomicJSON(path.join(this.directory, "status.json"), this.current);
    return this.status();
  }
  private async withLock(
    action: () => Promise<SyncStatus>,
  ): Promise<SyncStatus> {
    const lock = path.join(this.directory, "sync.lock");
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs.open(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner = 0;
        try {
          owner = Number(await fs.readFile(lock, "utf8"));
        } catch {
          /* concurrent owner */
        }
        if (owner > 0) {
          try {
            process.kill(owner, 0);
            return this.status();
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code !== "ESRCH")
              return this.status();
          }
          await fs.unlink(lock).catch(() => {});
        } else {
          // A crash can occur between exclusive creation and writing the PID.
          // Do not steal a newly created lock from another process.
          const info = await fs.stat(lock).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 60_000) {
            await fs.unlink(lock).catch(() => {});
          } else return this.status();
        }
      }
    }
    if (!handle) return this.status();
    await handle.writeFile(String(process.pid));
    try {
      const pointer = await this.readPointer();
      if (pointer.active !== this.active.version)
        this.active = await this.readVersion(pointer.active);
      return await action();
    } finally {
      await handle.close();
      await fs.unlink(lock).catch(() => {});
    }
  }
  private async git(args: string[], cache = true): Promise<string> {
    let result;
    try {
      result = await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.ext.allow=never",
          "-c",
          "protocol.file.allow=always",
          ...(cache
            ? ["--git-dir", path.join(this.directory, "repository.git")]
            : []),
          ...args,
        ],
        {
          timeout: 45000,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        },
      );
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      const detail =
        failure.code === "ENOENT"
          ? "Git is not installed"
          : failure.killed
            ? "operation exceeded 45-second timeout"
            : `exit ${String(failure.code ?? "unknown")}`;
      throw new Error(`Git ${args[0]} failed: ${detail}`);
    }
    return result.stdout;
  }
  private async performCheck(): Promise<SyncStatus> {
    await this.update({
      state: "checking",
      message: "Fetching upstream into faac-owned Git cache",
      lastCheckedAt: new Date().toISOString(),
    });
    try {
      const remote = this.config.remote;
      if (!/^https:\/\//.test(remote) && !path.isAbsolute(remote))
        throw new Error(
          "Sync remote must be HTTPS or an explicit absolute local Git fixture path",
        );
      if (remote.startsWith("https:")) {
        const url = new URL(remote);
        if (url.username || url.password)
          throw new Error("Credential-bearing upstream URLs are forbidden");
      }
      let branch = this.config.branch;
      if (!branch) {
        const refs = await this.git(
          ["ls-remote", "--symref", remote, "HEAD"],
          false,
        );
        branch = refs.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
        if (!branch)
          throw new Error("Upstream default branch could not be resolved");
      }
      await this.git(["check-ref-format", `refs/heads/${branch}`], false);
      await this.git(
        ["init", "--bare", path.join(this.directory, "repository.git")],
        false,
      );
      await this.git(["config", "remote.origin.url", remote]);
      await this.git(["config", "remote.origin.promisor", "true"]);
      await this.git([
        "config",
        "remote.origin.partialclonefilter",
        "blob:none",
      ]);
      await this.git([
        "fetch",
        "--filter=blob:none",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        `refs/heads/${branch}`,
      ]);
      const commit = (
        await this.git(["rev-parse", "FETCH_HEAD^{commit}"])
      ).trim();
      const files = Object.keys(this.baseline.guards);
      const tree = await this.git(["ls-tree", "-r", commit, "--", ...files]);
      const blobs = [
        ...new Set(
          tree.split("\n").flatMap((line) => {
            const match = line.match(/^100[0-7]{3} blob ([a-f0-9]{40,64})\t/);
            return match ? [match[1]!] : [];
          }),
        ),
      ];
      // Request the reviewed source blobs explicitly in one transfer. This avoids
      // both downloading unrelated assets and one network round trip per source.
      if (blobs.length)
        await this.git([
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "origin",
          ...blobs,
        ]);
      const candidate = this.snapshot();
      candidate.commit = commit;
      candidate.createdAt = new Date().toISOString();
      candidate.quarantined = {};
      const changedFiles: string[] = [];
      const changes: string[] = [];
      const contents: Record<string, string> = {};
      // Bounded parallel read-only Git blob reads, never a checkout or repository script.
      for (let start = 0; start < files.length; start += 12) {
        await Promise.all(
          files.slice(start, start + 12).map(async (file) => {
            const guard = this.baseline.guards[file]!;
            try {
              const text = await this.git(["show", `${commit}:${file}`]);
              contents[file] = text;
              candidate.fileHashes[file] = sha(text);
              if (sha(text) !== this.active.fileHashes[file])
                changedFiles.push(file);
              if (semanticHash(file, text) !== guard.hash)
                for (const provider of guard.providers)
                  candidate.quarantined[provider] ??=
                    `Unreviewed request, response, authentication, capability or dependency change: ${file}`;
            } catch {
              changedFiles.push(file);
              delete candidate.fileHashes[file];
              for (const provider of guard.providers)
                candidate.quarantined[provider] ??=
                  `Missing or unparseable monitored dependency: ${file}`;
            }
          }),
        );
      }
      try {
        Object.assign(candidate, parseCatalog(contents[CATALOG_PATH]!));
      } catch {
        for (const provider of PROVIDERS)
          candidate.quarantined[provider] =
            "Free catalog schema changed; safe eligibility cannot be established";
      }
      for (const provider of PROVIDERS) {
        try {
          candidate.endpoints[provider] = parseRegistry(
            provider,
            contents[registryPath(provider)]!,
          );
          if (provider === "openrouter")
            candidate.endpoints.openrouter.models = endpoint(
              "openrouter",
              "models",
              literal(
                variable(
                  source(OPENROUTER_CATALOG, contents[OPENROUTER_CATALOG]!),
                  "OPENROUTER_API_URL",
                ),
              ),
            );
        } catch {
          candidate.quarantined[provider] =
            "Official endpoint, registry or authentication contract changed beyond supported transformations";
        }
      }
      const before = new Map(
        this.active.curated.map((item) => [
          `${item.provider}/${item.modelId}`,
          item,
        ]),
      );
      const after = new Map(
        candidate.curated.map((item) => [
          `${item.provider}/${item.modelId}`,
          item,
        ]),
      );
      for (const [id, row] of after) {
        if (!before.has(id)) changes.push(`added ${id}`);
        else if (!isDeepStrictEqual(before.get(id), row))
          changes.push(`eligibility or metadata changed ${id}`);
      }
      for (const id of before.keys())
        if (!after.has(id)) changes.push(`removed ${id}`);
      for (const provider of PROVIDERS)
        if (
          !isDeepStrictEqual(
            candidate.endpoints[provider],
            this.active.endpoints[provider],
          )
        )
          changes.push(`validated endpoint update ${provider}`);
      const compatible = !Object.keys(candidate.quarantined).length;
      candidate.version = `adapter-1-${sha(JSON.stringify({ commit, hashes: candidate.fileHashes, quarantined: candidate.quarantined })).slice(0, 16)}`;
      if (candidate.version !== this.active.version)
        await this.activate(candidate);
      const state = compatible
        ? changedFiles.length
          ? "updated"
          : "unchanged"
        : "quarantined";
      return this.update({
        state,
        branch,
        lastSuccessAt: new Date().toISOString(),
        changedFiles: changedFiles.sort(),
        changes,
        message: compatible
          ? `Validated upstream ${commit.slice(0, 12)}; ${changes.length} catalog/endpoint changes`
          : `Upstream checked; ${Object.keys(candidate.quarantined).join(", ")} quarantined. Healthy integrations remain available.`,
      });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message.slice(0, 400)
          : "unexpected validation failure";
      return this.update({
        state: "error",
        message: `Upstream synchronization failed: ${reason}. Active validated adapter retained.`,
      });
    }
  }
}
