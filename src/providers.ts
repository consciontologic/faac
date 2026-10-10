/**
 * Official API adapters. Curated free classifications are adapted from OmniRoute
 * (MIT, Copyright (c) 2026 diegosouzapw; see THIRD_PARTY_NOTICES.md).
 * No upstream TypeScript is evaluated. Endpoint/schema changes require a reviewed adapter.
 */
import type {
  AdapterSnapshot,
  CompletionRequest,
  Connection,
  Message,
  Model,
  ProviderClient,
  ProviderId,
  StreamEvent,
  ToolCall,
} from "./types.js";
import { reconcileParams } from "./params.js";

export const ENDPOINTS = Object.freeze({
  openrouter: Object.freeze({
    models: "https://openrouter.ai/api/v1/models",
    chat: "https://openrouter.ai/api/v1/chat/completions",
  }),
  groq: Object.freeze({
    models: "https://api.groq.com/openai/v1/models",
    chat: "https://api.groq.com/openai/v1/chat/completions",
  }),
});
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CURATED_MAX_AGE_MS = 90 * CATALOG_MAX_AGE_MS;
export type FailureScope = "provider" | "account" | "model" | "request";
export class ProviderFailure extends Error {
  readonly status: number;
  readonly scope: FailureScope;
  readonly retryAfterMs?: number;
  readonly cancelled: boolean;
  readonly recoverable: boolean;
  constructor(
    message: string,
    status = 0,
    scope: FailureScope = "provider",
    options: {
      retryAfterMs?: number;
      cancelled?: boolean;
      recoverable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ProviderFailure";
    this.status = status;
    this.scope = scope;
    this.retryAfterMs = options.retryAfterMs;
    this.cancelled = options.cancelled ?? false;
    this.recoverable =
      options.recoverable ?? (scope !== "request" && !this.cancelled);
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}
function fresh(date: string, now: number, maxAge: number) {
  const age = now - Date.parse(date);
  return Number.isFinite(age) && age >= -300_000 && age <= maxAge;
}
function zero(value: unknown): boolean {
  return (
    (typeof value === "number" && value === 0) ||
    (typeof value === "string" &&
      /^(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/.test(value))
  );
}
export function retryHint(
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const retry = headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const ms = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retry) - now;
    if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  }
  const values: number[] = [];
  for (const key of [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ]) {
    const value = headers.get(key);
    if (!value) continue;
    let ms = 0;
    let parsed = "";
    for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
      ms +=
        Number(match[1]) *
        ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!] ?? 0);
      parsed += match[0];
    }
    if (parsed === value && ms > 0) values.push(ms);
  }
  return values.length ? Math.ceil(Math.max(...values)) : undefined;
}
/** Untrusted provider error text never appears in logs/transcripts. */
export function failureFromResponse(
  status: number,
  body: unknown,
  headers = new Headers(),
  now = Date.now(),
): ProviderFailure {
  const error = object(object(body).error ?? body);
  const code = String(error.code ?? error.type ?? "").toLowerCase();
  if ((!status || status === 200) && /^([45]\d\d)$/.test(code))
    status = Number(code);
  if (
    (!status || status === 200) &&
    ["invalid_request_error", "invalid_request", "bad_request"].includes(code)
  )
    status = 400;
  if (
    (!status || status === 200) &&
    ["authentication_error", "invalid_api_key"].includes(code)
  )
    status = 401;
  const metadata = object(error.metadata);
  let scope: FailureScope = "provider";
  let message = `Provider request failed (HTTP ${status || "unknown"})`;
  if (
    [
      "rate_limit_exceeded",
      "rate_limit_error",
      "rate_limit",
      "insufficient_quota",
    ].includes(code) &&
    (!status || status === 200)
  )
    status = 429;
  if (
    ["server_error", "service_unavailable", "overloaded_error"].includes(
      code,
    ) &&
    (!status || status === 200)
  )
    status = 503;
  if ([401, 402, 403].includes(status)) {
    scope = "account";
    message =
      status === 402
        ? "Account allowance exhausted; payment is disabled"
        : "Account authentication or access rejected";
  } else if (status === 429) {
    scope = metadata.scope === "model" ? "model" : "account";
    message =
      scope === "model"
        ? "Model quota or rate limit reached"
        : "Shared account quota or rate limit reached";
  } else if (
    status === 404 ||
    [
      "model_not_found",
      "model_decommissioned",
      "unsupported_model",
      "model_not_available",
    ].includes(code)
  ) {
    scope = "model";
    message = "Selected model is unavailable or unsupported";
  } else if (
    [400, 413, 422].includes(status) ||
    code === "context_length_exceeded"
  ) {
    scope = "request";
    message =
      code === "context_length_exceeded"
        ? "Request exceeds model context; compact before retrying"
        : "Invalid request; diagnose parameters or conversation before retrying";
  } else if ([408, 500, 502, 503, 504].includes(status))
    message = `Provider temporarily unavailable (HTTP ${status})`;
  else if (status >= 400 && status < 500) {
    scope = "request";
    message = `Request rejected (HTTP ${status}); automatic retry disabled`;
  }
  return new ProviderFailure(message, status, scope, {
    retryAfterMs: retryHint(headers, now),
  });
}
export function classifyFailure(
  error: unknown,
  signal?: AbortSignal,
): ProviderFailure {
  if (signal?.aborted)
    return new ProviderFailure("Cancelled by user", 0, "request", {
      cancelled: true,
      recoverable: false,
    });
  if (error instanceof ProviderFailure) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new ProviderFailure("Request cancelled", 0, "request", {
      cancelled: true,
      recoverable: false,
    });
  return new ProviderFailure(
    error instanceof Error && error.name === "TimeoutError"
      ? "Provider request timed out"
      : "Provider connection interrupted",
    0,
    "provider",
  );
}
const GROQ_BASE = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "seed",
  "tools",
  "tool_choice",
  "response_format",
  "stream",
];
// Explicit model-level evidence from https://console.groq.com/docs/tool-use/overview.
// Unknown/new models remain visible but ineligible until capabilities are reviewed.
const GROQ_CAPABILITIES: Record<string, string[]> = {
  "openai/gpt-oss-120b": [
    ...GROQ_BASE,
    "reasoning_effort",
    "include_reasoning",
    "structured_outputs",
  ],
  "openai/gpt-oss-20b": [
    ...GROQ_BASE,
    "reasoning_effort",
    "include_reasoning",
    "structured_outputs",
  ],
  "openai/gpt-oss-safeguard-20b": [...GROQ_BASE],
  "qwen/qwen3.8-27b": [
    ...GROQ_BASE,
    "parallel_tool_calls",
    "reasoning_effort",
    "reasoning_format",
    "include_reasoning",
  ],
};
export function parseCatalog(
  provider: ProviderId,
  payload: unknown,
  snapshot: AdapterSnapshot,
  connection?: Connection,
  now = Date.now(),
): Model[] {
  const rows = object(payload).data;
  if (!Array.isArray(rows) || rows.length > 20_000)
    throw new ProviderFailure(
      "Model discovery schema changed: expected bounded data array",
      0,
      "provider",
    );
  return rows
    .map((value): Model | undefined => {
      const row = object(value);
      if (
        typeof row.id !== "string" ||
        !row.id ||
        row.id.length > 300 ||
        /[\x00-\x20\x7f]/.test(row.id)
      )
        return undefined;
      const curated = snapshot.curated.find(
        (item) => item.provider === provider && item.modelId === row.id,
      );
      const architecture = object(row.architecture);
      const input =
        provider === "openrouter"
          ? strings(architecture.input_modalities)
          : ["text"];
      const output =
        provider === "openrouter"
          ? strings(architecture.output_modalities)
          : ["text"];
      const params =
        provider === "openrouter"
          ? strings(row.supported_parameters)
          : (GROQ_CAPABILITIES[row.id] ?? []);
      const evidence: string[] = [
        `Official live discovery: ${ENDPOINTS[provider].models}`,
      ];
      let eligible = true;
      let reason = "Listed as free with tool support; not yet inference-tested";
      const reject = (why: string) => {
        if (eligible) reason = why;
        eligible = false;
      };
      if (curated?.freeType === "discontinued") {
        reject(
          "Curated free eligibility was explicitly discontinued; live zero pricing is insufficient",
        );
        evidence.push(
          `OmniRoute discontinued classification ${snapshot.curatedAt}`,
        );
      }
      if (snapshot.quarantined[provider])
        reject(`Integration quarantined: ${snapshot.quarantined[provider]}`);
      if (
        !params.includes("tools") ||
        !input.includes("text") ||
        !output.includes("text")
      )
        reject("Text input/output and verified tool support are required");
      if (provider === "openrouter") {
        const pricing = object(row.pricing);
        if (!row.id.endsWith(":free"))
          reject(
            "No explicit :free model variant; paid or uncertain variants excluded",
          );
        if (
          !zero(pricing.prompt) ||
          !zero(pricing.completion) ||
          !Object.values(pricing).every(zero)
        )
          reject(
            "Pricing is paid, missing, or uncertain; every advertised price must explicitly equal zero",
          );
        evidence.push(
          "Requires :free suffix AND explicit numeric zero for prompt, completion and all advertised price fields",
          "https://openrouter.ai/docs/guides/routing/provider-selection#max-price",
        );
      } else {
        if (!connection?.freePlanConfirmed)
          reject(
            "Groq Free plan without payment method must be explicitly confirmed at /connect",
          );
        if (
          !curated ||
          !curated.freeType.startsWith("recurring-") ||
          curated.hardStopGuaranteed !== true
        )
          reject(
            "No curated recurring free allowance with verified billing hard stop",
          );
        if (!fresh(snapshot.curatedAt, now, CURATED_MAX_AGE_MS))
          reject(
            "Curated free-plan evidence older than 90 days; synchronize or review before use",
          );
        if (row.active !== true)
          reject("Model is not explicitly active in authenticated discovery");
        evidence.push(
          `OmniRoute curated ${snapshot.curatedAt}: ${curated?.freeType ?? "unknown"}`,
          "User attestation: Free plan with no payment method; API cannot verify billing configuration",
          "https://console.groq.com/docs/rate-limits",
          "https://console.groq.com/docs/billing-faqs",
        );
      }
      const contextWindow = integer(
        row.context_length ?? row.context_window,
        0,
      );
      if (!contextWindow) reject("Context limit is absent or invalid");
      const maxOutput = Math.min(
        contextWindow || 4096,
        integer(
          object(row.top_provider).max_completion_tokens ??
            row.max_completion_tokens,
          Math.min(contextWindow || 4096, 4096),
        ),
      );
      return {
        id: row.id,
        provider,
        name: typeof row.name === "string" ? row.name.slice(0, 300) : row.id,
        contextWindow,
        maxOutput,
        supportedParameters: [...params],
        inputModalities: input,
        outputModalities: output,
        free: {
          eligible,
          kind:
            provider === "openrouter"
              ? "recurring-rate-limited"
              : (curated?.freeType ?? "unknown"),
          evidence,
          checkedAt: new Date(now).toISOString(),
          reason,
        },
        // Account-scoped 429s gate all models regardless of their finer documented pools.
        pool:
          provider === "openrouter"
            ? "openrouter:free-account"
            : curated?.poolKey
              ? `groq:${curated.poolKey}`
              : `groq:model:${row.id}`,
      };
    })
    .filter((model): model is Model => Boolean(model));
}
function endpoint(
  snapshot: AdapterSnapshot,
  provider: ProviderId,
  kind: "models" | "chat",
): string {
  if (snapshot.quarantined[provider])
    throw new ProviderFailure(
      "Integration quarantined; inspect /sync status",
      0,
      "provider",
      { recoverable: true },
    );
  const url = snapshot.endpoints[provider]?.[kind];
  if (url !== ENDPOINTS[provider][kind])
    throw new ProviderFailure(
      "Unreviewed endpoint change blocked",
      0,
      "provider",
    );
  return url;
}
export function translateMessages(
  messages: Message[],
): Record<string, unknown>[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content || (m.toolCalls?.length ? null : ""),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.toolCalls?.length
      ? {
          tool_calls: m.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  }));
}
async function readJson(
  response: Response,
  limit = 16 * 1024 * 1024,
): Promise<unknown> {
  if (!response.body)
    throw new ProviderFailure("Empty API response", 0, "provider");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit)
        throw new ProviderFailure(
          "API response exceeds safety limit",
          0,
          "provider",
        );
      chunks.push(value);
    }
    const all = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all)) as unknown;
    } catch {
      throw new ProviderFailure("API returned malformed JSON", 0, "provider");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      total += value.byteLength;
      if (total > 16 * 1024 * 1024)
        throw new ProviderFailure(
          "Response stream exceeds safety limit",
          0,
          "provider",
        );
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length) {
            yield data.join("\n");
            data = [];
          }
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    // Even a valid-looking unterminated event cannot authorize tool execution.
    if (buffer.trim() || data.length)
      throw new ProviderFailure(
        "Truncated SSE frame; pending tools were not authorized",
        0,
        "provider",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function completeTools(
  calls: Map<number, ToolCall>,
  finish: string,
): ToolCall[] {
  if (!calls.size && finish === "tool_calls")
    throw new ProviderFailure("Tool completion has no tool calls", 0, "model");
  if (calls.size && finish !== "tool_calls")
    throw new ProviderFailure("Incomplete tool call discarded", 0, "model");
  const ids = new Set<string>();
  return [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => {
      if (
        !call.id ||
        ids.has(call.id) ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(call.id) ||
        !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(call.name)
      )
        throw new ProviderFailure(
          "Malformed tool identity; no tool executed",
          0,
          "model",
        );
      ids.add(call.id);
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        throw new ProviderFailure(
          "Incomplete tool arguments discarded",
          0,
          "model",
        );
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new ProviderFailure(
          "Tool arguments must be a JSON object",
          0,
          "model",
        );
      return call;
    });
}
export class HostedProviders implements ProviderClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  constructor(
    options: {
      fetch?: typeof fetch;
      timeoutMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }
  async discover(
    provider: ProviderId,
    key: string | undefined,
    snapshot: AdapterSnapshot,
    connection?: Connection,
  ): Promise<Model[]> {
    if (provider === "groq" && !key)
      throw new ProviderFailure(
        "Groq discovery requires a connected API key",
        401,
        "account",
      );
    const url = endpoint(snapshot, provider, "models");
    try {
      const response = await this.fetcher(url, {
        headers: {
          Accept: "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000)),
        redirect: "error",
      });
      const body = await readJson(response);
      if (!response.ok)
        throw failureFromResponse(
          response.status,
          body,
          response.headers,
          this.now(),
        );
      return parseCatalog(provider, body, snapshot, connection, this.now());
    } catch (error) {
      throw classifyFailure(error);
    }
  }
  async *complete(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const { model, key, snapshot } = request;
    if (request.signal.aborted) throw classifyFailure(null, request.signal);
    if (!key)
      throw new ProviderFailure(
        "Connect a provider API key before inference",
        401,
        "account",
      );
    if (
      !model.free.eligible ||
      !fresh(model.free.checkedAt, this.now(), CATALOG_MAX_AGE_MS)
    )
      throw new ProviderFailure(
        "Free eligibility is absent or stale; refresh /models before inference",
        0,
        "model",
      );
    if (model.provider === "openrouter" && !model.id.endsWith(":free"))
      throw new ProviderFailure(
        "Strict free routing rejected a non-free variant",
        0,
        "model",
      );
    if (
      snapshot.curated.some(
        (item) =>
          item.provider === model.provider &&
          item.modelId === model.id &&
          item.freeType === "discontinued",
      )
    )
      throw new ProviderFailure(
        "Curated free eligibility was discontinued; model disabled",
        0,
        "model",
      );
    if (model.provider === "groq") {
      const entry = snapshot.curated.find(
        (item) => item.provider === "groq" && item.modelId === model.id,
      );
      if (
        !entry?.freeType.startsWith("recurring-") ||
        entry.hardStopGuaranteed !== true ||
        !fresh(snapshot.curatedAt, this.now(), CURATED_MAX_AGE_MS) ||
        !GROQ_CAPABILITIES[model.id]
      )
        throw new ProviderFailure(
          "Groq free eligibility changed; refresh /models",
          0,
          "model",
        );
    }
    const url = endpoint(snapshot, model.provider, "chat");
    if (request.tools.length && !model.supportedParameters.includes("tools"))
      throw new ProviderFailure(
        "Model does not support required tools",
        0,
        "model",
      );
    const { params, warnings } = reconcileParams(model, request.params);
    if (warnings.length)
      throw new ProviderFailure(
        "Unsupported request settings; reconcile capabilities before inference",
        400,
        "request",
      );
    const stream = params.stream !== false;
    const body: Record<string, unknown> = {
      ...params,
      model: model.id,
      messages: translateMessages(request.messages),
      stream,
    };
    if (request.tools.length)
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    if (model.provider === "openrouter")
      body.provider = {
        max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
        require_parameters: true,
      };
    if (model.provider === "groq" && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
          ...(model.provider === "openrouter" ? { "X-Title": "faac" } : {}),
        },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        let payload: unknown = {};
        try {
          payload = await readJson(response, 64 * 1024);
        } catch {
          /* HTTP status remains authoritative; never expose raw upstream body. */
        }
        throw failureFromResponse(
          response.status,
          payload,
          response.headers,
          this.now(),
        );
      }
      if (!stream) {
        const payload = object(await readJson(response));
        if (payload.error)
          throw failureFromResponse(0, payload, response.headers, this.now());
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const choice = object(choices[0]);
        const message = object(choice.message);
        if (typeof choice.finish_reason !== "string")
          throw new ProviderFailure(
            "Completion schema changed: missing finish reason",
            0,
            "provider",
          );
        const calls = new Map<number, ToolCall>();
        if (Array.isArray(message.tool_calls))
          message.tool_calls.forEach((value, index) => {
            const tool = object(value);
            const fn = object(tool.function);
            calls.set(index, {
              id: typeof tool.id === "string" ? tool.id : "",
              name: typeof fn.name === "string" ? fn.name : "",
              arguments: typeof fn.arguments === "string" ? fn.arguments : "",
            });
          });
        if (
          !["stop", "tool_calls", "length", "content_filter"].includes(
            choice.finish_reason,
          )
        )
          throw new ProviderFailure(
            "Unknown completion reason; integration contract requires review",
            0,
            "provider",
          );
        const complete = completeTools(calls, choice.finish_reason);
        if (typeof message.content === "string" && message.content)
          yield { type: "text", text: message.content };
        for (const call of complete) yield { type: "tool", call };
        yield { type: "done", finishReason: choice.finish_reason };
        return;
      }
      if (
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        const payload = object(await readJson(response));
        if (payload.error)
          throw failureFromResponse(0, payload, response.headers, this.now());
        throw new ProviderFailure(
          "Streaming response schema changed; expected text/event-stream",
          0,
          "provider",
        );
      }
      const calls = new Map<number, ToolCall>();
      let finish = "";
      let done = false;
      for await (const data of sse(response.body)) {
        if (signal.aborted) throw signal.reason;
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let payload: Record<string, unknown>;
        try {
          payload = object(JSON.parse(data));
        } catch {
          throw new ProviderFailure(
            "Malformed SSE JSON; pending tools discarded",
            0,
            "provider",
          );
        }
        if (payload.error)
          throw failureFromResponse(0, payload, response.headers, this.now());
        if (!Array.isArray(payload.choices))
          throw new ProviderFailure(
            "Streaming response schema changed: choices missing",
            0,
            "provider",
          );
        for (const raw of payload.choices) {
          const choice = object(raw);
          if (choice.index !== undefined && choice.index !== 0) continue;
          const delta = object(choice.delta);
          if (choice.finish_reason === "error")
            throw new ProviderFailure(
              "Provider returned a midstream error",
              503,
              "provider",
            );
          if (typeof delta.content === "string" && delta.content) {
            if (finish)
              throw new ProviderFailure(
                "Content after terminal frame rejected",
                0,
                "provider",
              );
            yield { type: "text", text: delta.content };
          }
          if (Array.isArray(delta.tool_calls))
            for (const rawTool of delta.tool_calls) {
              if (finish)
                throw new ProviderFailure(
                  "Tool data after terminal frame rejected",
                  0,
                  "provider",
                );
              const tool = object(rawTool);
              const fn = object(tool.function);
              const index = tool.index;
              if (
                !Number.isSafeInteger(index) ||
                Number(index) < 0 ||
                Number(index) > 99
              )
                throw new ProviderFailure(
                  "Invalid streamed tool index",
                  0,
                  "model",
                );
              const previous = calls.get(Number(index)) ?? {
                id: "",
                name: "",
                arguments: "",
              };
              if (typeof tool.id === "string") {
                if (previous.id && previous.id !== tool.id)
                  throw new ProviderFailure(
                    "Tool identity changed midstream",
                    0,
                    "model",
                  );
                previous.id = tool.id;
              }
              if (typeof fn.name === "string") previous.name += fn.name;
              if (typeof fn.arguments === "string")
                previous.arguments += fn.arguments;
              calls.set(Number(index), previous);
            }
          if (typeof choice.finish_reason === "string") {
            if (finish && finish !== choice.finish_reason)
              throw new ProviderFailure(
                "Conflicting terminal frames",
                0,
                "provider",
              );
            finish = choice.finish_reason;
          }
        }
      }
      if (!done || !finish)
        throw new ProviderFailure(
          "Response interrupted before completion; pending tools discarded",
          0,
          "provider",
        );
      if (!["stop", "tool_calls", "length", "content_filter"].includes(finish))
        throw new ProviderFailure(
          "Unknown completion reason; integration contract requires review",
          0,
          "provider",
        );
      for (const call of completeTools(calls, finish))
        yield { type: "tool", call };
      yield { type: "done", finishReason: finish };
    } catch (error) {
      if (signal.aborted && !request.signal.aborted)
        throw new ProviderFailure(
          "Provider request timed out",
          408,
          "provider",
        );
      throw classifyFailure(error, request.signal);
    }
  }
}
