import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { Store, defaultConfig } from "../src/storage.js";
import { ToolRunner } from "../src/tools.js";
import { Router } from "../src/routing.js";
import { ENDPOINTS } from "../src/providers.js";
import type {
  AdapterSnapshot,
  AgentEvent,
  CompletionRequest,
  Model,
  ProviderClient,
  ProviderId,
  StreamEvent,
  ToolCall,
} from "../src/types.js";
export function testModel(
  provider: ProviderId = "openrouter",
  id = provider === "openrouter" ? "fixture/coder:free" : "fixture-groq",
): Model {
  return {
    provider,
    id,
    name: id,
    contextWindow: 32000,
    maxOutput: 4096,
    supportedParameters: [
      "tools",
      "max_tokens",
      "temperature",
      "tool_choice",
      "stream",
    ],
    inputModalities: ["text"],
    outputModalities: ["text"],
    free: {
      eligible: true,
      kind: "deterministic-test-fixture",
      evidence: ["MOCK ONLY; not live API access"],
      checkedAt: new Date().toISOString(),
      reason: "test fixture",
    },
    pool: provider === "openrouter" ? "openrouter:free-account" : "shared-groq",
  };
}
export function testSnapshot(): AdapterSnapshot {
  const now = new Date().toISOString();
  return {
    version: "fixture-v1",
    commit: "fixture-commit",
    createdAt: now,
    endpoints: ENDPOINTS,
    curatedAt: now,
    curated: [],
    quarantined: {},
    fileHashes: {},
  };
}
export function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faac-test-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "state"));
  const session = store.newSession(workspace);
  const config = structuredClone(defaultConfig);
  config.permissions = {
    read: "allow",
    edit: "allow",
    shell: "ask",
    outside: "deny",
  };
  config.params = { max_tokens: 512, temperature: 0.2 };
  config.maxSteps = 12;
  for (const provider of ["openrouter", "groq"] as const)
    config.connections[provider] = {
      provider,
      enabled: true,
      freePlanConfirmed: true,
      connectedAt: new Date().toISOString(),
    };
  const events: AgentEvent[] = [];
  const approvals: string[] = [];
  const emit = (event: AgentEvent) => events.push(event);
  const runner = new ToolRunner(
    store,
    session,
    config,
    async (request) => {
      approvals.push(request.kind);
      return true;
    },
    emit,
  );
  const router = new Router(store.home, Date.now, () => 0.5);
  return {
    root,
    workspace,
    store,
    session,
    config,
    events,
    approvals,
    emit,
    runner,
    router,
  };
}
export function tool(id: string, name: string, args: unknown): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}
export class ScriptedClient implements ProviderClient {
  readonly requests: CompletionRequest[] = [];
  constructor(
    private script: (
      request: CompletionRequest,
      index: number,
    ) => AsyncIterable<StreamEvent>,
  ) {}
  async discover(): Promise<Model[]> {
    return [];
  }
  complete(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const index = this.requests.length;
    this.requests.push(
      structuredClone({ ...request, signal: undefined }) as CompletionRequest,
    );
    return this.script(request, index);
  }
}
export async function* answer(text: string): AsyncIterable<StreamEvent> {
  yield { type: "text", text };
  yield { type: "done", finishReason: "stop" };
}
