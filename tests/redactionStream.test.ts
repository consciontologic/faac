import test from "node:test";
import assert from "node:assert/strict";
import { Redactor } from "../src/storage.js";
import { createRedactedStream } from "../src/redactionStream.js";

function feed(input: string, redactor: Redactor, chunk: number): string {
  const stream = createRedactedStream(redactor);
  let output = "";
  for (let i = 0; i < input.length; i += chunk)
    output += stream.push(input.slice(i, i + chunk));
  return output + stream.finish();
}
test("registered API credentials split at every possible chunk size never leak", () => {
  const redactor = new Redactor();
  const secret = "registered-credential-with-long-value-123456789";
  redactor.add(secret);
  const text =
    `Starting the answer normally. ${secret} More explanation after the credential. `.repeat(
      4,
    );
  for (let size = 1; size <= secret.length + 4; size++) {
    const output = feed(text, redactor, size);
    assert.equal(output, redactor.text(text));
    assert(!output.includes(secret));
  }
});
test("multiword and multiline registered secrets remain whole across output cuts", () => {
  const redactor = new Redactor();
  redactor.add("the passphrase contains multiple words");
  redactor.add("first secret line\nsecond secret line");
  const text =
    "Normal words before. the passphrase contains multiple words then explanation. first secret line\nsecond secret line done. ".repeat(
      3,
    );
  for (const size of [1, 2, 7, 31, 47, 103])
    assert.equal(feed(text, redactor, size), redactor.text(text));
});
test("generic OpenRouter/Groq keys and authorization/assignment tokens redact across chunks", () => {
  const redactor = new Redactor();
  const text =
    "Examples: sk-or-v1-notarealkey123 gsk_notarealkey456 sk-proj-notareal789\nAuthorization: Bearer testtoken123\npassword = fakevalue123\napi_key: otherfakevalue456\nAll done. ".repeat(
      3,
    );
  for (const size of [1, 2, 3, 7, 30, 45, 80, 200])
    assert.equal(feed(text, redactor, size), redactor.text(text));
});
test("unfinished authentication introducer retains context even with large whitespace", () => {
  const redactor = new Redactor();
  const text =
    "Authorization:" +
    " ".repeat(200) +
    "Bearer" +
    " ".repeat(200) +
    "secretvalue123\nEnd of record.";
  assert.equal(feed(text, redactor, 1), redactor.text(text));
  assert(!feed(text, redactor, 20).includes("secretvalue123"));
});
test("normal Markdown streams progressively without altering spaces, code, or Unicode", () => {
  const redactor = new Redactor();
  const stream = createRedactedStream(redactor);
  const input =
    "# Header\n\nReadable **text** with λ and Markdown.\n```ts\nconst answer = 42;\n```\n";
  const first = stream.push(input);
  assert(first.length > 0);
  assert(first.length < input.length);
  assert.equal(first + stream.finish(), input);
  assert.equal(stream.finish(), "");
});
test("finish on disruption flushes only sanitized pending output", () => {
  const redactor = new Redactor();
  redactor.add("fake-known-secret");
  const stream = createRedactedStream(redactor);
  let output = stream.push("Short fake-known-");
  output += stream.push("secret");
  output += stream.finish();
  assert.equal(output, "Short [REDACTED]");
});
test("oversized unbroken credential is withheld with bounded storage until newline", () => {
  const stream = createRedactedStream(new Redactor());
  let output = stream.push("gsk_" + "x".repeat(70000));
  output += stream.push("tail-of-key");
  output += stream.push("\nNormal response after withheld line.");
  output += stream.finish();
  assert.match(output, /withheld/);
  assert(!output.includes("gsk_"));
  assert(!output.includes("tail-of-key"));
  assert.match(output, /Normal response/);
});
