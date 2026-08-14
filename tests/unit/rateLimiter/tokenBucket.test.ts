import Redis from "ioredis";
import { loadEnv } from "../../../src/config/env";
import { createTokenBucket } from "../../../src/rateLimiter/tokenBucket";

// This "unit" test needs a real, local Redis (see lld.md §8) — the token
// bucket's logic is the Lua script itself, and there's no meaningful way to
// exercise real Lua semantics without Redis's own interpreter.
describe("tokenBucket.checkAndConsume", () => {
  const env = loadEnv();
  const redis = new Redis(env.REDIS_URL);
  const bucket = createTokenBucket(redis);
  const testKey = "ratelimit:test:tokenBucket";

  beforeEach(async () => {
    await redis.del(testKey);
  });

  afterAll(async () => {
    await redis.del(testKey);
    await redis.quit();
  });

  it("allows a request from a fresh key and consumes one token", async () => {
    const result = await bucket.checkAndConsume(testKey, 5, 1, 300);

    expect(result.allowed).toBe(true);
    expect(result.tokensRemaining).toBeCloseTo(4, 5);
  });

  it("allows exactly `capacity` requests back-to-back, then rejects the next one", async () => {
    const capacity = 3;
    const results = [];
    for (let i = 0; i < capacity; i++) {
      results.push(await bucket.checkAndConsume(testKey, capacity, 0.001, 300));
    }
    const overflow = await bucket.checkAndConsume(testKey, capacity, 0.001, 300);

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(overflow.allowed).toBe(false);
    // Not exactly 0: real wall-clock time passes between calls, so even a
    // near-zero refill rate accrues a tiny fraction of a token by design.
    expect(overflow.tokensRemaining).toBeLessThan(0.01);
  });

  it("refills over elapsed time up to capacity, never exceeding it", async () => {
    const capacity = 2;
    const refillPerSecond = 2; // 1 token every 500ms

    await bucket.checkAndConsume(testKey, capacity, refillPerSecond, 300);
    await bucket.checkAndConsume(testKey, capacity, refillPerSecond, 300);
    const empty = await bucket.checkAndConsume(testKey, capacity, refillPerSecond, 300);
    expect(empty.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const afterWait = await bucket.checkAndConsume(testKey, capacity, refillPerSecond, 300);
    expect(afterWait.allowed).toBe(true);
    // Capped at capacity, not overflowed by the elapsed 1.1s * 2/s = 2.2 tokens.
    expect(afterWait.tokensRemaining).toBeLessThanOrEqual(capacity - 1);
  });

  it("sets a TTL on the bucket key so idle keys expire", async () => {
    await bucket.checkAndConsume(testKey, 5, 1, 300);

    const ttl = await redis.ttl(testKey);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });
});
