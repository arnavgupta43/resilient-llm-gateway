import Redis from "ioredis";
import { loadEnv } from "../../../src/config/env";
import { createCircuitBreaker } from "../../../src/circuitBreaker/circuitBreaker";
import type { CircuitBreakerConfig } from "../../../src/circuitBreaker/config";

// Real local Redis, same exception as tokenBucket.test.ts (lld.md §10) — the
// logic under test is the Lua script itself, so mocking Redis would just
// exercise our own mock, not real Lua semantics.
describe("circuitBreaker.attemptBatch", () => {
  const env = loadEnv();
  const redis = new Redis(env.REDIS_URL);
  const config: CircuitBreakerConfig = {
    failureThreshold: 5,
    failureWindowSeconds: 60,
    cooldownSeconds: 30,
    halfOpenLeaseSeconds: 30,
  };
  const circuitBreaker = createCircuitBreaker(redis, config);

  // Matches the real "circuitbreaker:{provider}" key shape from
  // circuitBreaker.ts. Provider names are prefixed "test:" so they can't
  // collide with any real provider's breaker key.
  const keyFor = (provider: string) => `circuitbreaker:${provider}`;
  const providers = ["test:attempt-batch:a", "test:attempt-batch:b", "test:attempt-batch:c"];

  beforeEach(async () => {
    await redis.del(...providers.map(keyFor));
  });

  afterAll(async () => {
    await redis.del(...providers.map(keyFor));
    await redis.quit();
  });

  async function seed(
    provider: string,
    fields: { state?: string; opened_at?: number; failure_count?: number },
  ): Promise<void> {
    const args: string[] = [];
    if (fields.state !== undefined) args.push("state", fields.state);
    if (fields.opened_at !== undefined) args.push("opened_at", fields.opened_at.toString());
    if (fields.failure_count !== undefined) args.push("failure_count", fields.failure_count.toString());
    if (args.length > 0) await redis.hset(keyFor(provider), ...args);
  }

  it("allows a provider with no prior breaker state (fresh)", async () => {
    const result = await circuitBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(result).toEqual(["test:attempt-batch:a"]);
  });

  it("allows a provider explicitly in the closed state", async () => {
    await seed("test:attempt-batch:a", { state: "closed" });
    const result = await circuitBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(result).toEqual(["test:attempt-batch:a"]);
  });

  it("rejects a provider that is open and the cooldown has not elapsed", async () => {
    await seed("test:attempt-batch:a", { state: "open", opened_at: Date.now() / 1000 });
    const result = await circuitBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(result).toEqual([]);
  });

  it("grants exactly one probe once the cooldown has elapsed, and flips state to half_open", async () => {
    const openedAt = Date.now() / 1000 - config.cooldownSeconds - 1;
    await seed("test:attempt-batch:a", { state: "open", opened_at: openedAt });

    const first = await circuitBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(first).toEqual(["test:attempt-batch:a"]);

    const state = await redis.hget(keyFor("test:attempt-batch:a"), "state");
    expect(state).toBe("half_open");

    // A second caller arriving while the probe is still outstanding must be
    // rejected — only one caller gets to test the recovering provider.
    const second = await circuitBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(second).toEqual([]);
  });

  it("grants only one probe among truly concurrent callers past cooldown", async () => {
    const openedAt = Date.now() / 1000 - config.cooldownSeconds - 1;
    await seed("test:attempt-batch:a", { state: "open", opened_at: openedAt });

    const results = await Promise.all([
      circuitBreaker.attemptBatch(["test:attempt-batch:a"]),
      circuitBreaker.attemptBatch(["test:attempt-batch:a"]),
      circuitBreaker.attemptBatch(["test:attempt-batch:a"]),
    ]);

    const admitted = results.filter((r) => r.length === 1);
    expect(admitted).toHaveLength(1);
  });

  it("re-grants a probe once the half-open lease has expired without a report", async () => {
    const shortLeaseBreaker = createCircuitBreaker(redis, { ...config, halfOpenLeaseSeconds: 1 });
    const openedAt = Date.now() / 1000 - config.cooldownSeconds - 1;
    await seed("test:attempt-batch:a", { state: "open", opened_at: openedAt });

    const probe = await shortLeaseBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(probe).toEqual(["test:attempt-batch:a"]);

    // Comfortably past the 1s lease — the exact expiry moment isn't precise
    // enough to cut this closer under parallel test-worker load.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // The probe caller never reported back — the lease should have expired
    // the key entirely, so this reads as fresh/closed rather than stuck.
    const exists = await redis.exists(keyFor("test:attempt-batch:a"));
    expect(exists).toBe(0);

    const afterExpiry = await shortLeaseBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(afterExpiry).toEqual(["test:attempt-batch:a"]);
  }, 10000);

  it("rejects a provider already half_open (a probe is already outstanding)", async () => {
    await seed("test:attempt-batch:a", { state: "half_open", opened_at: Date.now() / 1000 });
    const result = await circuitBreaker.attemptBatch(["test:attempt-batch:a"]);
    expect(result).toEqual([]);
  });

  it("filters a mixed list, preserving the original order of survivors", async () => {
    await seed("test:attempt-batch:a", { state: "closed" });
    await seed("test:attempt-batch:b", { state: "open", opened_at: Date.now() / 1000 });
    await seed("test:attempt-batch:c", { state: "closed" });

    const result = await circuitBreaker.attemptBatch(["test:attempt-batch:a", "test:attempt-batch:b", "test:attempt-batch:c"]);
    expect(result).toEqual(["test:attempt-batch:a", "test:attempt-batch:c"]);
  });

  it("returns an empty array for an empty provider list without calling Redis", async () => {
    const result = await circuitBreaker.attemptBatch([]);
    expect(result).toEqual([]);
  });
});
