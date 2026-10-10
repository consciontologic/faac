import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderFailure } from "../src/providers.js";
import { Router, RECOVERY_PROBE_MS } from "../src/routing.js";
import { fixture, testModel } from "./helpers.js";

const disruption = () =>
  new ProviderFailure("service unavailable", 503, "provider");

test("provider circuit opens, permits one half-open probe across instances, and closes on success", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const a = new Router(
    f.store.home,
    () => now,
    () => 0.5,
  );
  const b = new Router(
    f.store.home,
    () => now,
    () => 0.5,
  );
  const one = testModel(),
    two = testModel("openrouter", "other:free");
  assert.equal(a.availability(one).state, "closed");
  await a.failure(one, disruption());
  assert.equal(a.status().gates["provider:openrouter"]?.state, "open");
  assert.equal(a.availability(two).available, false);
  now += 1001;
  assert.equal(a.status().gates["provider:openrouter"]?.state, "half-open");
  assert.equal(a.availability(one).available, true);
  const reservations = await Promise.all([a.reserve(one), b.reserve(two)]);
  assert.deepEqual(reservations, [true, false]);
  assert.equal(b.availability(two).state, "half-open");
  assert.equal(b.availability(two).retryAt, now + RECOVERY_PROBE_MS);
  assert.equal(b.availability(testModel("groq")).available, true);
  await a.success(one);
  assert.equal(a.status().gates["provider:openrouter"]?.state, "closed");
  assert.equal(b.availability(two).available, true);
});

test("failed recovery probe reopens the correct scope with increased bounded backoff", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const router = new Router(
    f.store.home,
    () => now,
    () => 0.5,
  );
  const model = testModel();
  await router.failure(model, disruption());
  now += 1001;
  assert(await router.reserve(model));
  await router.failure(model, disruption());
  const gate = router.status().gates["provider:openrouter"]!;
  assert.equal(gate.state, "open");
  assert.equal(gate.failures, 2);
  assert.equal(gate.until, now + 2000);
  assert.equal(gate.probe, undefined);
  const retryUntil = gate.until;
  await router.failure(
    model,
    new ProviderFailure("concurrent error", 503, "provider", {
      retryAfterMs: 1,
    }),
  );
  assert.equal(router.status().gates["provider:openrouter"]!.until, retryUntil);
  assert.equal(router.status().gates["provider:openrouter"]!.failures, 2);
});

test("account limits span models, model limits remain narrow, and upstream Retry-After wins", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const router = new Router(
    f.store.home,
    () => now,
    () => 0.5,
  );
  const one = testModel(),
    two = testModel("openrouter", "two:free");
  await router.failure(
    one,
    new ProviderFailure("model quota", 429, "model", { retryAfterMs: 5000 }),
  );
  assert.equal(router.availability(one).retryAt, now + 5000);
  assert.equal(router.availability(two).available, true);
  await router.failure(
    two,
    new ProviderFailure("account quota", 429, "account", {
      retryAfterMs: 9000,
    }),
  );
  assert.equal(router.availability(one).retryAt, now + 9000);
  assert.equal(router.availability(two).available, false);
  assert.equal(router.availability(testModel("groq")).available, true);
  now += 9001;
  assert(await router.reserve(two));
  assert.equal(await router.reserve(one), false);
  await router.success(two);
  assert.equal(router.availability(one).state, "half-open");
  assert(await router.reserve(one));
  await router.success(one);
  assert.equal(router.availability(one).state, "closed");
});

test("older successful requests never clear newer gates even after cooldown expiry", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const router = new Router(
    f.store.home,
    () => now,
    () => 0.5,
  );
  const one = testModel(),
    two = testModel("openrouter", "two:free");
  assert(await router.reserve(one));
  await router.failure(two, disruption());
  now += 1001;
  await router.success(one);
  assert.equal(
    router.status().gates["provider:openrouter"]!.state,
    "half-open",
  );
  assert(await router.reserve(one));
  await router.failure(two, disruption());
  now += 2001;
  await router.success(one);
  assert.equal(
    router.status().gates["provider:openrouter"]!.state,
    "half-open",
  );
  assert.equal(router.status().gates["provider:openrouter"]!.failures, 2);
});

test("abandoned or cancelled probes cannot lock a provider permanently", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const a = new Router(
      f.store.home,
      () => now,
      () => 0.5,
    ),
    b = new Router(
      f.store.home,
      () => now,
      () => 0.5,
    );
  const model = testModel();
  await a.failure(model, disruption());
  now += 1001;
  assert(await a.reserve(model));
  assert.equal(await b.reserve(model), false);
  now += RECOVERY_PROBE_MS + 1;
  assert.equal(b.availability(model).available, true);
  assert(await b.reserve(model));
  await a.success(model); // A's late completion cannot clear B's replacement lease.
  assert.equal(a.availability(model).available, false);
  await b.failure(
    model,
    new ProviderFailure("cancelled", 0, "request", { cancelled: true }),
  );
  assert.equal(b.availability(model).available, true);
  assert.equal(b.status().gates["provider:openrouter"]!.failures, 1);
  assert(await a.reserve(model));
  await a.success(model);
  assert.equal(a.availability(model).state, "closed");
});

test("overlapping same-model reservations conservatively cannot close a recovery gate", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const a = new Router(
      f.store.home,
      () => now,
      () => 0.5,
    ),
    b = new Router(
      f.store.home,
      () => now,
      () => 0.5,
    );
  const model = testModel();
  assert(await a.reserve(model));
  await b.failure(model, disruption());
  now += 1001;
  assert(await a.reserve(model));
  await a.success(model);
  await a.success(model);
  assert.equal(a.status().gates["provider:openrouter"]!.state, "half-open");
  assert.equal(a.availability(model).available, false);
  now += RECOVERY_PROBE_MS + 1;
  assert(await a.reserve(model));
  await a.success(model);
  assert.equal(a.availability(model).state, "closed");
});

test("next retry waits for the maximum of scoped gates and shared quota windows", async (t) => {
  const f = fixture(t);
  let now = Date.parse("2026-10-10T12:00:00Z");
  const router = new Router(
    f.store.home,
    () => now,
    () => 0.5,
  );
  const model = testModel();
  for (let i = 0; i < 20; i++) {
    assert(await router.reserve(model));
    await router.success(model);
  }
  await router.failure(model, disruption());
  assert.equal(router.availability(model).retryAt, now + 60000);
  now += 60001;
  assert(await router.reserve(model));
  await router.success(model);
  for (let i = 0; i < 19; i++) {
    assert(await router.reserve(model));
    await router.success(model);
  }
  now += 60001;
  for (let i = 0; i < 10; i++) {
    assert(await router.reserve(model));
    await router.success(model);
  }
  await router.failure(model, disruption());
  assert.equal(
    router.availability(model).retryAt,
    Date.parse("2026-10-11T00:00:00Z"),
  );
});
