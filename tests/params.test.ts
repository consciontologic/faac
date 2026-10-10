import test from "node:test";
import assert from "node:assert/strict";
import {
  parameterHelp,
  reconcileParams,
  validateParam,
} from "../src/params.js";
import type { Model } from "../src/types.js";
const model: Model = {
  provider: "openrouter",
  id: "test:free",
  name: "Test",
  contextWindow: 8192,
  maxOutput: 1024,
  supportedParameters: [
    "tools",
    "max_tokens",
    "temperature",
    "top_p",
    "response_format",
    "structured_outputs",
    "reasoning",
    "novel_param",
  ],
  inputModalities: ["text"],
  outputModalities: ["text"],
  pool: "shared",
  free: {
    eligible: true,
    kind: "test",
    evidence: [],
    checkedAt: new Date().toISOString(),
    reason: "test",
  },
};
test("descriptors show supported, unsupported, defaults, limits and modalities", () => {
  const help = parameterHelp(model);
  assert.match(help, /frequency_penalty \[unsupported\]/);
  assert.match(help, /novel_param \[unsupported\]/);
  assert.match(help, /default:/);
  assert.match(help, /Maximum output: 1024/);
  assert.match(help, /Modalities: input text/);
});
test("heat alias and range validation reject invalid/nonfinite values", () => {
  assert.equal(validateParam("heat", 0.5, model), 0.5);
  for (const value of [-1, 3, NaN, Infinity, "0.5"])
    assert.throws(() => validateParam("temperature", value, model));
  assert.throws(() => validateParam("max_tokens", 1025, model), /output limit/);
});
test("fallback reconciles optional settings visibly and refuses dropping essential capabilities", () => {
  const next = { ...model, supportedParameters: ["tools", "max_tokens"] };
  const result = reconcileParams(next, { temperature: 0.7, max_tokens: 512 });
  assert.deepEqual(result.params, { max_tokens: 512 });
  assert.match(result.warnings[0]!, /temperature.*omitted/);
  assert.throws(
    () => reconcileParams(next, { temperature: 0.7 }, ["temperature"]),
    /Essential/,
  );
  assert.throws(
    () => reconcileParams({ ...next, supportedParameters: [] }, {}, ["tools"]),
    /Essential/,
  );
});
test("advanced safe allowlist prevents routing, paid tools and arbitrary fields", () => {
  assert.deepEqual(validateParam("advanced", { temperature: 0.5 }, model), {
    temperature: 0.5,
  });
  for (const key of [
    "provider",
    "model",
    "api_key",
    "tools",
    "service_tier",
    "plugins",
    "web_search_options",
    "novel_param",
    "advanced",
  ])
    assert.throws(() => validateParam("advanced", { [key]: {} }, model));
  assert.deepEqual(
    reconcileParams(model, { advanced: { temperature: 0.4 } }).params,
    { temperature: 0.4 },
  );
});
test("reasoning and structured output enforce supported shape and capabilities", () => {
  assert.throws(
    () => validateParam("reasoning", { effort: "high", max_tokens: 5 }, model),
    /choose/,
  );
  assert.throws(
    () => validateParam("reasoning", { unreviewed: true }, model),
    /unknown/,
  );
  const schema = {
    type: "json_schema",
    json_schema: { name: "answer", strict: true, schema: { type: "object" } },
  };
  assert.deepEqual(validateParam("response_format", schema, model), schema);
  assert.throws(
    () =>
      validateParam("response_format", schema, {
        ...model,
        supportedParameters: ["response_format"],
      }),
    /structured_outputs/,
  );
});
test("model-specific Groq reasoning, mutually exclusive aliases and unsupported penalties", () => {
  const groq: Model = {
    ...model,
    provider: "groq",
    id: "openai/gpt-oss-20b",
    supportedParameters: ["reasoning_effort", "max_completion_tokens"],
  };
  assert.equal(validateParam("reasoning_effort", "high", groq), "high");
  assert.throws(
    () => validateParam("reasoning_effort", "none", groq),
    /accepts/,
  );
  assert.throws(
    () =>
      reconcileParams(groq, { max_tokens: 100, max_completion_tokens: 100 }),
    /Choose/,
  );
  assert.throws(
    () => validateParam("frequency_penalty", 0, groq),
    /unsupported/,
  );
});
