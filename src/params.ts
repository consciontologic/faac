import type { Model } from "./types.js";

export interface ParameterDescriptor {
  name: string;
  description: string;
  default: string;
  range: string;
  kind: "number" | "integer" | "boolean" | "enum" | "json";
  min?: number;
  max?: number;
  values?: string[];
}
const number = (
  name: string,
  description: string,
  min: number,
  max: number,
  value: string,
  integer = false,
): ParameterDescriptor => ({
  name,
  description,
  min,
  max,
  default: value,
  range: `${min}..${max}`,
  kind: integer ? "integer" : "number",
});
const flag = (
  name: string,
  description: string,
  value = "provider default",
): ParameterDescriptor => ({
  name,
  description,
  default: value,
  range: "true | false",
  kind: "boolean",
});
const enumeration = (
  name: string,
  description: string,
  values: string[],
): ParameterDescriptor => ({
  name,
  description,
  default: "provider default",
  range: values.join(" | "),
  values,
  kind: "enum",
});
const json = (
  name: string,
  description: string,
  range: string,
): ParameterDescriptor => ({
  name,
  description,
  default: "unset",
  range,
  kind: "json",
});

/** Only reviewed API fields are forwarded. An advertised but unknown field is never inferred. */
export const PARAMETERS: ParameterDescriptor[] = [
  number(
    "temperature",
    "Heat: randomness of token selection",
    0,
    2,
    "provider default (usually 1)",
  ),
  number(
    "top_p",
    "Nucleus probability mass",
    0,
    1,
    "provider default (usually 1)",
  ),
  number(
    "top_k",
    "Limit candidate tokens (0 disables)",
    0,
    Number.MAX_SAFE_INTEGER,
    "provider default (usually 0)",
    true,
  ),
  number(
    "min_p",
    "Minimum relative token probability",
    0,
    1,
    "provider default",
  ),
  number("top_a", "Adaptive probability cutoff", 0, 1, "provider default"),
  number(
    "frequency_penalty",
    "Discourage tokens proportional to frequency",
    -2,
    2,
    "provider default (usually 0)",
  ),
  number(
    "presence_penalty",
    "Discourage previously seen tokens",
    -2,
    2,
    "provider default (usually 0)",
  ),
  number(
    "repetition_penalty",
    "Token repetition penalty multiplier",
    0,
    2,
    "provider default (usually 1)",
  ),
  number(
    "max_tokens",
    "Output budget including reasoning; bounded by model limit",
    1,
    Number.MAX_SAFE_INTEGER,
    "agent budget",
    true,
  ),
  number(
    "max_completion_tokens",
    "Output budget alias; do not combine with max_tokens",
    1,
    Number.MAX_SAFE_INTEGER,
    "agent budget",
    true,
  ),
  number(
    "seed",
    "Best-effort sampling seed; determinism is not guaranteed",
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    "unset",
    true,
  ),
  number(
    "top_logprobs",
    "Number of token alternatives (requires logprobs)",
    0,
    20,
    "unset",
    true,
  ),
  flag("stream", "Stream text as it arrives", "true"),
  flag(
    "parallel_tool_calls",
    "Let the model request multiple tools; faac executes serially",
  ),
  flag("logprobs", "Request token log probabilities"),
  flag("include_reasoning", "Provider-specific reasoning output toggle"),
  enumeration(
    "reasoning_effort",
    "Reasoning effort; accepted values differ by model",
    ["none", "default", "minimal", "low", "medium", "high", "xhigh", "max"],
  ),
  enumeration("reasoning_format", "Groq reasoning representation", [
    "hidden",
    "raw",
    "parsed",
  ]),
  enumeration("verbosity", "Desired answer detail", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]),
  flag("safe_prompt", "Mistral safe prompt option through OpenRouter"),
  json("stop", "Stop sequences", "string or up to 4 strings"),
  json(
    "tool_choice",
    "Tool selection; definitions are managed by /tools",
    "auto | required | none | function object",
  ),
  json(
    "reasoning",
    "OpenRouter reasoning options",
    "{effort?, max_tokens?, exclude?, enabled?}",
  ),
  json(
    "response_format",
    "Text, JSON object, or supported strict JSON schema",
    "{type: text | json_object | json_schema, json_schema?}",
  ),
  json(
    "logit_bias",
    "Token ID to logit adjustment",
    "object of numeric token IDs to -100..100",
  ),
  json(
    "advanced",
    "Validated provider-specific settings; same reviewed allowlist",
    "JSON object; no routing, billing, endpoint, or arbitrary fields",
  ),
];
const descriptors = new Map(PARAMETERS.map((p) => [p.name, p]));
export function canonicalParam(name: string): string {
  return name === "heat" ? "temperature" : name;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function knownKeys(
  value: Record<string, unknown>,
  keys: string[],
  name: string,
) {
  assert(
    Object.keys(value).every((k) => keys.includes(k)),
    `${name}: unknown field`,
  );
}
export function supportsParam(model: Model, name: string): boolean {
  name = canonicalParam(name);
  if (name === "stream" || name === "advanced") return true;
  if (name === "max_tokens" || name === "max_completion_tokens")
    return model.supportedParameters.some(
      (p) => p === "max_tokens" || p === "max_completion_tokens",
    );
  return model.supportedParameters.includes(name);
}
export function validateParam(
  rawName: string,
  value: unknown,
  model?: Model,
): unknown {
  const name = canonicalParam(rawName);
  const p = descriptors.get(name);
  assert(p, `${name}: unsupported setting; /params lists reviewed fields`);
  if (model)
    assert(
      supportsParam(model, name),
      `${name}: unsupported by ${model.provider}/${model.id}`,
    );
  if (p.kind === "number" || p.kind === "integer") {
    assert(
      typeof value === "number" &&
        Number.isFinite(value) &&
        value >= p.min! &&
        value <= p.max! &&
        (p.kind !== "integer" || Number.isSafeInteger(value)),
      `${name}: expected ${p.kind} ${p.range}`,
    );
    if (model && (name === "max_tokens" || name === "max_completion_tokens"))
      assert(
        value <= model.maxOutput,
        `${name}: model output limit is ${model.maxOutput}`,
      );
  } else if (p.kind === "boolean")
    assert(typeof value === "boolean", `${name}: expected true or false`);
  else if (p.kind === "enum") {
    assert(
      typeof value === "string" && p.values!.includes(value),
      `${name}: expected ${p.range}`,
    );
    if (model?.provider === "groq" && name === "reasoning_effort") {
      const allowed = model.id.startsWith("openai/gpt-oss")
        ? ["low", "medium", "high"]
        : model.id === "qwen/qwen3.8-27b"
          ? ["none", "default", "low", "medium", "high"]
          : ["none", "default"];
      assert(
        allowed.includes(value),
        `${name}: ${model.id} accepts ${allowed.join(", ")}`,
      );
    }
  } else if (name === "stop")
    assert(
      (typeof value === "string" && value.length > 0) ||
        (Array.isArray(value) &&
          value.length <= 4 &&
          value.every((s) => typeof s === "string" && s.length > 0)),
      "stop: expected string or up to 4 nonempty strings",
    );
  else if (name === "tool_choice") {
    assert(
      ["auto", "none", "required"].includes(String(value)) ||
        (record(value) &&
          value.type === "function" &&
          record(value.function) &&
          typeof value.function.name === "string" &&
          /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.function.name)),
      "tool_choice: expected auto, none, required, or function object",
    );
    if (record(value)) {
      knownKeys(value, ["type", "function"], name);
      knownKeys(value.function as Record<string, unknown>, ["name"], name);
    }
  } else if (name === "reasoning") {
    assert(record(value), "reasoning: expected object");
    knownKeys(value, ["effort", "max_tokens", "exclude", "enabled"], name);
    if (value.effort !== undefined)
      assert(
        typeof value.effort === "string" &&
          ["none", "minimal", "low", "medium", "high", "xhigh"].includes(
            value.effort,
          ),
        "reasoning.effort: invalid value",
      );
    if (value.max_tokens !== undefined)
      assert(
        Number.isSafeInteger(value.max_tokens) && Number(value.max_tokens) > 0,
        "reasoning.max_tokens: expected positive integer",
      );
    for (const k of ["exclude", "enabled"])
      if (value[k] !== undefined)
        assert(
          typeof value[k] === "boolean",
          `reasoning.${k}: expected boolean`,
        );
    assert(
      !(value.effort !== undefined && value.max_tokens !== undefined),
      "reasoning: choose effort or max_tokens, not both",
    );
  } else if (name === "response_format") {
    assert(record(value), "response_format: expected object");
    knownKeys(value, ["type", "json_schema"], name);
    assert(
      ["text", "json_object", "json_schema"].includes(String(value.type)),
      "response_format.type: invalid value",
    );
    if (value.type === "json_schema") {
      assert(
        !model || model.supportedParameters.includes("structured_outputs"),
        "response_format: model does not advertise structured_outputs",
      );
      assert(
        record(value.json_schema),
        "response_format.json_schema: expected object",
      );
      knownKeys(
        value.json_schema,
        ["name", "description", "strict", "schema"],
        "json_schema",
      );
      assert(
        typeof value.json_schema.name === "string" &&
          /^[A-Za-z0-9_-]{1,64}$/.test(value.json_schema.name) &&
          record(value.json_schema.schema),
        "json_schema: requires name and schema object",
      );
      if (value.json_schema.strict !== undefined)
        assert(
          typeof value.json_schema.strict === "boolean",
          "json_schema.strict: expected boolean",
        );
      assert(
        JSON.stringify(value).length < 64_000,
        "json_schema: exceeds 64 KB",
      );
    } else
      assert(
        value.json_schema === undefined,
        "json_schema only applies to type json_schema",
      );
  } else if (name === "logit_bias") {
    assert(
      record(value) &&
        Object.entries(value).every(
          ([k, v]) =>
            /^\d+$/.test(k) &&
            typeof v === "number" &&
            Number.isFinite(v) &&
            v >= -100 &&
            v <= 100,
        ),
      "logit_bias: expected token IDs mapped to -100..100",
    );
  } else if (name === "advanced") {
    assert(record(value), "advanced: expected JSON object");
    for (const [key, v] of Object.entries(value)) {
      assert(key !== "advanced", "advanced: nesting is not supported");
      validateParam(key, v, model);
    }
  }
  return structuredClone(value);
}
export function reconcileParams(
  model: Model,
  params: Record<string, unknown>,
  essential: string[] = [],
): { params: Record<string, unknown>; warnings: string[] } {
  const result: Record<string, unknown> = {};
  const warnings: string[] = [];
  const flattened = {
    ...(record(params.advanced) ? params.advanced : {}),
    ...params,
  };
  delete flattened.advanced;
  for (const required of essential) {
    const name = canonicalParam(required);
    assert(
      supportsParam(model, name),
      `Essential parameter ${name} unsupported by ${model.provider}/${model.id}`,
    );
  }
  for (const [rawName, value] of Object.entries(flattened)) {
    const name = canonicalParam(rawName);
    try {
      result[name] = validateParam(name, value, model);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid parameter";
      if (essential.map(canonicalParam).includes(name))
        throw new Error(`Essential ${message}`);
      warnings.push(`${message}; omitted for this model`);
    }
  }
  assert(
    !(
      result.max_tokens !== undefined &&
      result.max_completion_tokens !== undefined
    ),
    "Choose max_tokens or max_completion_tokens, not both",
  );
  assert(
    !(
      result.reasoning_format !== undefined &&
      result.include_reasoning !== undefined
    ),
    "reasoning_format and include_reasoning are mutually exclusive",
  );
  assert(
    !(result.reasoning !== undefined && result.reasoning_effort !== undefined),
    "reasoning and reasoning_effort are mutually exclusive",
  );
  assert(
    !(result.top_logprobs !== undefined && result.logprobs !== true),
    "top_logprobs requires logprobs=true",
  );
  return { params: result, warnings };
}
export function parameterHelp(model?: Model): string {
  const lines = PARAMETERS.map(
    (p) =>
      `${p.name}${model && !supportsParam(model, p.name) ? " [unsupported]" : ""}: ${p.description}\n  ${p.range}; default: ${p.default}`,
  );
  lines.push(
    "tools [read-only]: definitions are supplied by the agent; inspect /tools. heat aliases temperature.",
  );
  if (model) {
    lines.push(
      `Modalities: input ${model.inputModalities.join(", ")}; output ${model.outputModalities.join(", ")}. faac currently sends text only.`,
    );
    for (const field of model.supportedParameters)
      if (
        !descriptors.has(field) &&
        !["tools", "structured_outputs"].includes(field)
      )
        lines.push(
          `${field} [unsupported]: advertised upstream but no reviewed transformation`,
        );
    lines.push(
      `Maximum output: ${model.maxOutput}; context: ${model.contextWindow}. Provider defaults are left unset.`,
    );
  }
  return lines.join("\n");
}
