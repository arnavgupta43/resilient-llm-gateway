import Redis from "ioredis";
import { loadEnv } from "../../../src/config/env";
import { baseLogger } from "../../../src/logger";
import { createCircuitBreaker } from "../../../src/circuitBreaker/circuitBreaker";
import type { CircuitBreakerConfig } from "../../../src/circuitBreaker/config";

// Real local Redis — see circuitBreakerAttemptBatch.test.ts for why.
describe("circuitBreaker.report", () => {
  const env = loadEnv();
  const redis = new Redis(env.REDIS_URL);
  const config: CircuitBreakerConfig = {
    failureThreshold: 3,
    failureWindowSeconds: 60,
    cooldownSeconds: 30,
    halfOpenLeaseSeconds: 30,
  };
  const circuitBreaker = createCircuitBreaker(redis, config);

  const keyFor = (provider: string) => `circuitbreaker:${provider}`;
  const providers = ["test:report:a"];

  beforeEach(async () => {
    await redis.del(...providers.map(keyFor));
  });

  afterAll(async () => {
    await redis.del(...providers.map(keyFor));
    await redis.quit();
  });

  async function seed(provider: string, fields: { state?: string; failure_count?: number }): Promise<void> {
    const args: string[] = [];
    if (fields.state !== undefined) args.push("state", fields.state);
    if (fields.failure_count !== undefined) args.push("failure_count", fields.failure_count.toString());
    if (args.length > 0) await redis.hset(keyFor(provider), ...args);
  }

  it("stays closed and resets failure_count on success from a fresh/closed provider", async () => {
    await seed("test:report:a", { state: "closed", failure_count: 2 });
    await circuitBreaker.report("test:report:a", true);

    const data = await redis.hmget(keyFor("test:report:a"), "state", "failure_count");
    expect(data).toEqual(["closed", "0"]);
  });

  it("increments failure_count on failure while below the threshold, staying closed", async () => {
    await seed("test:report:a", { state: "closed", failure_count: 1 });
    await circuitBreaker.report("test:report:a", false);

    const data = await redis.hmget(keyFor("test:report:a"), "state", "failure_count");
    expect(data).toEqual(["closed", "2"]);
  });

  it("flips to open exactly when failure_count crosses the threshold", async () => {
    await seed("test:report:a", { state: "closed", failure_count: config.failureThreshold - 1 });
    await circuitBreaker.report("test:report:a", false);

    const data = await redis.hmget(keyFor("test:report:a"), "state", "opened_at");
    expect(data[0]).toBe("open");
    expect(data[1]).not.toBeNull();
  });

  it("sets a window TTL on failure so an idle failure_count resets after W seconds", async () => {
    const shortWindowBreaker = createCircuitBreaker(redis, { ...config, failureWindowSeconds: 1 });

    await shortWindowBreaker.report("test:report:a", false);
    expect((await redis.hget(keyFor("test:report:a"), "failure_count"))).toBe("1");

    // Comfortably past the 1s window — see the same margin note in
    // circuitBreakerAttemptBatch.test.ts.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await redis.exists(keyFor("test:report:a"))).toBe(0);

    await shortWindowBreaker.report("test:report:a", false);
    // Started fresh, not accumulating on top of the pre-expiry count.
    expect(await redis.hget(keyFor("test:report:a"), "failure_count")).toBe("1");
  }, 10000);

  it("closes and resets failure_count when a half-open probe succeeds", async () => {
    await seed("test:report:a", { state: "half_open", failure_count: config.failureThreshold });
    await circuitBreaker.report("test:report:a", true);

    const data = await redis.hmget(keyFor("test:report:a"), "state", "failure_count");
    expect(data).toEqual(["closed", "0"]);
  });

  it("re-opens immediately when a half-open probe fails, regardless of failure_count", async () => {
    await seed("test:report:a", { state: "half_open", failure_count: 0 });
    await circuitBreaker.report("test:report:a", false);

    const data = await redis.hmget(keyFor("test:report:a"), "state", "opened_at");
    expect(data[0]).toBe("open");
    expect(data[1]).not.toBeNull();
  });

  it("treats a stray report against an already-open breaker as closed-state semantics", async () => {
    // Can happen under the Redis-down fail-open path (hld.md §6): a caller
    // is granted access without a real breaker check, so by report time the
    // real stored state might already be `open` from a concurrent failure.
    await seed("test:report:a", { state: "open", failure_count: config.failureThreshold });
    await circuitBreaker.report("test:report:a", true);

    const data = await redis.hmget(keyFor("test:report:a"), "state", "failure_count");
    expect(data).toEqual(["closed", "0"]);
  });

  it("logs circuit_breaker.opened only on the closed->open transition, not on every failure", async () => {
    const warnSpy = jest.spyOn(baseLogger, "warn").mockImplementation(() => baseLogger);
    try {
      await seed("test:report:a", { state: "closed", failure_count: 0 });
      await circuitBreaker.report("test:report:a", false); // 1/3 — no transition
      await circuitBreaker.report("test:report:a", false); // 2/3 — no transition
      expect(warnSpy).not.toHaveBeenCalled();

      await circuitBreaker.report("test:report:a", false); // 3/3 — opens
      expect(warnSpy).toHaveBeenCalledWith({ provider: "test:report:a" }, "circuit_breaker.opened");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs circuit_breaker.closed only on a half_open->closed transition", async () => {
    const infoSpy = jest.spyOn(baseLogger, "info").mockImplementation(() => baseLogger);
    try {
      await seed("test:report:a", { state: "half_open", failure_count: 0 });
      await circuitBreaker.report("test:report:a", true);
      expect(infoSpy).toHaveBeenCalledWith({ provider: "test:report:a" }, "circuit_breaker.closed");
      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not reject and logs a warning if the underlying Redis call fails", async () => {
    const brokenRedis = { defineCommand: jest.fn() } as unknown as Redis;
    // Simulate defineCommand attaching a method that always rejects, the
    // same shape a real connection failure would produce.
    (brokenRedis as unknown as { circuitBreakerReport: () => Promise<never> }).circuitBreakerReport = () =>
      Promise.reject(new Error("connection lost"));
    const brokenBreaker = createCircuitBreaker(brokenRedis, config);
    const warnSpy = jest.spyOn(baseLogger, "warn").mockImplementation(() => baseLogger);

    try {
      await expect(brokenBreaker.report("test:report:a", false)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "test:report:a" }),
        "circuit breaker report failed",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
