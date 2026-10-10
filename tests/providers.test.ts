import test from "node:test";
import assert from "node:assert/strict";
import {
  ENDPOINTS,
  HostedProviders,
  ProviderFailure,
  classifyFailure,
  failureFromResponse,
  parseCatalog,
  retryHint,
} from "../src/providers.js";
import type {
  AdapterSnapshot,
  CompletionRequest,
  Model,
  StreamEvent,
} from "../src/types.js";
const now = Date.now();
const snapshot: AdapterSnapshot = {
  version: "test-v1",
  commit: "abc",
  createdAt: new Date(now).toISOString(),
  curatedAt: new Date(now).toISOString(),
  endpoints: ENDPOINTS,
  quarantined: {},
  curated: [
    {
      provider: "groq",
      modelId: "openai/gpt-oss-20b",
      freeType: "recurring-daily",
      poolKey: "organization",
      hardStopGuaranteed: true,
    },
  ],
  fileHashes: {},
};
const row = {
  id: "test/coder:free",
  name: "Coder",
  context_length: 32768,
  pricing: { prompt: "0", completion: "0", request: "0" },
  supported_parameters: ["tools", "max_tokens", "temperature"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
};
function model(): Model {
  return parseCatalog(
    "openrouter",
    { data: [row] },
    snapshot,
    undefined,
    now,
  )[0]!;
}
function request(): CompletionRequest {
  return {
    model: model(),
    key: "secret-key-never-log",
    snapshot,
    messages: [
      { role: "system", content: "Keep work" },
      { role: "user", content: "Implement tests" },
    ],
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object" },
      },
    ],
    params: {},
    signal: new AbortController().signal,
  };
}
const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const final = chunk({}, "stop") + "data: [DONE]\n\n";
function streamResponse(text: string, fragment = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index >= bytes.length) controller.close();
        else {
          controller.enqueue(bytes.slice(index, index + fragment));
          index += fragment;
        }
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function fake(
  fn: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch {
  return fn as typeof fetch;
}
async function collect(
  client: HostedProviders,
  req = request(),
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.complete(req)) events.push(event);
  return events;
}

test("OpenRouter free classification rejects paid, unknown, ancillary prices, false coercions, and absent tools", () => {
  const rows = [
    row,
    { ...row, id: "paid" },
    { ...row, pricing: {} },
    { ...row, pricing: { prompt: false, completion: "0" } },
    { ...row, pricing: { prompt: "0", completion: "0", image: "0.01" } },
    { ...row, supported_parameters: [] },
  ];
  const models = parseCatalog(
    "openrouter",
    { data: rows },
    snapshot,
    undefined,
    now,
  );
  assert.deepEqual(
    models.map((m) => m.free.eligible),
    [true, false, false, false, false, false],
  );
  assert.equal(models[0]!.testedAt, undefined);
  assert.match(models[0]!.free.reason, /not yet inference-tested/);
  assert.equal(models[0]!.pool, models[1]!.pool);
});
test("Groq requires free account attestation, active known capabilities, hard stop, fresh recurring evidence", () => {
  const entry = {
    id: "openai/gpt-oss-20b",
    active: true,
    context_window: 131072,
  };
  const connection = {
    provider: "groq" as const,
    enabled: true,
    freePlanConfirmed: true,
    connectedAt: new Date(now).toISOString(),
  };
  const discover = (s = snapshot, c = connection, r = entry) =>
    parseCatalog("groq", { data: [r] }, s, c, now)[0]!;
  assert(discover().free.eligible);
  assert(
    !discover(snapshot, { ...connection, freePlanConfirmed: false }).free
      .eligible,
  );
  assert(!discover({ ...snapshot, curated: [] }).free.eligible);
  assert(!discover({ ...snapshot, curatedAt: "2001-01-01" }).free.eligible);
  assert(
    !discover(snapshot, connection, { ...entry, active: false }).free.eligible,
  );
  assert(
    !discover(snapshot, connection, { ...entry, id: "new-unknown-model" }).free
      .eligible,
  );
  assert(!discover().supportedParameters.includes("parallel_tool_calls"));
});
test("catalog additions/removals and changed free eligibility are reflected without stale merge", () => {
  assert.equal(
    parseCatalog(
      "openrouter",
      { data: [row, { ...row, id: "new:free" }] },
      snapshot,
    ).length,
    2,
  );
  assert.equal(parseCatalog("openrouter", { data: [] }, snapshot).length, 0);
  assert.equal(
    parseCatalog(
      "openrouter",
      { data: [{ ...row, pricing: { prompt: "0.2", completion: "0" } }] },
      snapshot,
    )[0]!.free.eligible,
    false,
  );
  assert.throws(
    () => parseCatalog("openrouter", { models: [row] }, snapshot),
    /schema changed/,
  );
});
test("fragmented UTF8 and multiline SSE stream preserves content and ignores comments", async () => {
  const multiline =
    'data: {"choices": [\ndata: {"index":0,"delta":{"content":"Hi λ"},"finish_reason":null}]}\n\n';
  const client = new HostedProviders({
    fetch: fake(() =>
      streamResponse(": heartbeat\r\n\r\n" + multiline + final, 1),
    ),
  });
  assert.deepEqual(await collect(client), [
    { type: "text", text: "Hi λ" },
    { type: "done", finishReason: "stop" },
  ]);
});
test("tool arguments are buffered until tool_calls finish AND DONE; duplicate accounting finish accepted", async () => {
  const text =
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          function: { name: "read_file", arguments: '{"pa' },
        },
      ],
    }) +
    chunk({
      tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }],
    }) +
    chunk({}, "tool_calls") +
    chunk({}, "tool_calls") +
    "data: [DONE]\n\n";
  const events = await collect(
    new HostedProviders({ fetch: fake(() => streamResponse(text)) }),
  );
  assert.deepEqual(events, [
    {
      type: "tool",
      call: { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
    },
    { type: "done", finishReason: "tool_calls" },
  ]);
});
test("incomplete tool calls, truncation, malformed args, and terminal length never emit executable tools", async () => {
  for (const tail of [
    "",
    chunk({}, "tool_calls"),
    chunk({}, "length") + "data: [DONE]\n\n",
    chunk({}, "tool_calls") + "data: [DONE]\n\n",
  ]) {
    const text =
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call",
            function: { name: "read_file", arguments: '{"path":' },
          },
        ],
      }) + tail;
    const events: StreamEvent[] = [];
    const client = new HostedProviders({
      fetch: fake(() => streamResponse(text)),
    });
    await assert.rejects(async () => {
      for await (const event of client.complete(request())) events.push(event);
    }, ProviderFailure);
    assert(!events.some((event) => event.type === "tool"));
  }
});
test("mid-stream 429 preserves emitted text but blocks pending tools and scopes shared account quota", async () => {
  const text =
    chunk({ content: "Existing work" }) +
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    }) +
    'data: {"error":{"code":429,"message":"secret-key-never-log"}}\n\n';
  const events: StreamEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const event of new HostedProviders({
        fetch: fake(() => streamResponse(text)),
      }).complete(request()))
        events.push(event);
    },
    (error: unknown) =>
      error instanceof ProviderFailure &&
      error.status === 429 &&
      error.scope === "account" &&
      !error.message.includes("secret-key"),
  );
  assert.deepEqual(events, [{ type: "text", text: "Existing work" }]);
});
test("HTTP 503 respects retry hints; 400 requires diagnosis; auth and model failures use narrow scope", async () => {
  const client = new HostedProviders({
    fetch: fake(
      () =>
        new Response('{"error":{"message":"secret-key"}}', {
          status: 503,
          headers: { "retry-after": "7" },
        }),
    ),
  });
  await assert.rejects(
    () => collect(client),
    (error: unknown) =>
      error instanceof ProviderFailure &&
      error.scope === "provider" &&
      error.retryAfterMs === 7000,
  );
  assert.equal(failureFromResponse(400, {}).recoverable, false);
  assert.equal(failureFromResponse(401, {}).scope, "account");
  assert.equal(failureFromResponse(403, {}).scope, "account");
  assert.equal(
    failureFromResponse(400, { error: { code: "model_not_found" } }).scope,
    "model",
  );
  assert.equal(
    failureFromResponse(429, { error: { metadata: { scope: "model" } } }).scope,
    "model",
  );
  assert.equal(
    retryHint(new Headers({ "x-ratelimit-reset-tokens": "1m2.5s" })),
    62500,
  );
});
test("network interruptions are recoverable; cancellation never falls back", async () => {
  const client = new HostedProviders({
    fetch: fake(() => {
      throw new TypeError("fetch failed secret");
    }),
  });
  await assert.rejects(
    () => collect(client),
    (error: unknown) =>
      error instanceof ProviderFailure &&
      error.recoverable &&
      !error.message.includes("secret"),
  );
  const req = request();
  const controller = new AbortController();
  req.signal = controller.signal;
  controller.abort();
  await assert.rejects(
    () => collect(client, req),
    (error: unknown) =>
      error instanceof ProviderFailure && error.cancelled && !error.recoverable,
  );
  assert.equal(
    classifyFailure(new Error("private payload")).message,
    "Provider connection interrupted",
  );
});
test("wire translation retains tool IDs/results and forces free max price without forwarding arbitrary params", async () => {
  let payload: Record<string, unknown> = {};
  const req = request();
  req.messages.push(
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "old_call", name: "read_file", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: "old_call",
      content: "existing edits survived",
    },
  );
  const client = new HostedProviders({
    fetch: fake((_url, init) => {
      payload = JSON.parse(String(init?.body));
      assert.equal(init?.redirect, "error");
      return streamResponse(final);
    }),
  });
  await collect(client, req);
  assert.deepEqual(payload.provider, {
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    require_parameters: true,
  });
  assert.deepEqual((payload.messages as unknown[])[3], {
    role: "tool",
    tool_call_id: "old_call",
    content: "existing edits survived",
  });
  await assert.rejects(
    () =>
      collect(client, {
        ...req,
        params: { provider: { max_price: { prompt: 100 } } },
      }),
    /Unsupported request settings/,
  );
});
test("unknown endpoint, stale free status, and quarantine fail before network", async () => {
  let fetched = false;
  const client = new HostedProviders({
    fetch: fake(() => {
      fetched = true;
      return streamResponse(final);
    }),
  });
  const req = request();
  await assert.rejects(
    () =>
      collect(client, {
        ...req,
        snapshot: {
          ...snapshot,
          endpoints: {
            ...ENDPOINTS,
            openrouter: {
              ...ENDPOINTS.openrouter,
              chat: "https://attacker.invalid",
            },
          },
        },
      }),
    /endpoint/,
  );
  await assert.rejects(
    () =>
      collect(client, {
        ...req,
        model: {
          ...req.model,
          free: { ...req.model.free, checkedAt: "2001-01-01" },
        },
      }),
    /stale/,
  );
  await assert.rejects(
    () =>
      collect(client, {
        ...req,
        snapshot: {
          ...snapshot,
          quarantined: { openrouter: "schema changed" },
        },
      }),
    /quarantined/,
  );
  assert.equal(fetched, false);
});
test("nonstreaming is supported with the same complete-tool validation", async () => {
  const req = { ...request(), params: { stream: false } };
  const client = new HostedProviders({
    fetch: fake(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: "Done", tool_calls: [] },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  });
  assert.deepEqual(await collect(client, req), [
    { type: "text", text: "Done" },
    { type: "done", finishReason: "stop" },
  ]);
});

test("explicit discontinued catalog classification vetoes contradictory live zero pricing and cached eligibility", async () => {
  const discontinued = {
    ...snapshot,
    curated: [
      {
        provider: "openrouter",
        modelId: row.id,
        freeType: "discontinued",
        poolKey: "account",
      },
    ],
  };
  const current = parseCatalog("openrouter", { data: [row] }, discontinued)[0]!;
  assert.equal(current.free.eligible, false);
  assert.match(current.free.reason, /discontinued/);
  let fetched = false;
  const client = new HostedProviders({
    fetch: fake(() => {
      fetched = true;
      return streamResponse(final);
    }),
  });
  await assert.rejects(
    () => collect(client, { ...request(), snapshot: discontinued }),
    /discontinued/,
  );
  assert.equal(fetched, false);
});
