import { readFileSync } from "node:fs";
import path from "node:path";
import type { Redis } from "ioredis";
import { getLogger } from "../logger";
import type { BreakerState, CircuitBreaker } from "./types";
import type { CircuitBreakerConfig } from "./config";

// defineCommand attaches these as methods at runtime, so TypeScript can't
// know they exist on Redis -- same pattern as RedisWithTokenBucket in
// rateLimiter/tokenBucket.ts, kept contained to this one file.
interface RedisWithCircuitBreakerScripts extends Redis {
  circuitBreakerAttemptBatch(...args: (string | number)[]): Promise<number[]>;
  circuitBreakerReport(
    key: string,
    success: "0" | "1",
    threshold: number,
    window: number,
  ): Promise<[BreakerState, number]>;
}

export function createCircuitBreaker(redis: Redis, config: CircuitBreakerConfig): CircuitBreaker {
  const attemptLua = readFileSync(path.join(__dirname, "circuitBreakerAttemptBatch.lua"), "utf8");
  const reportLua = readFileSync(path.join(__dirname, "circuitBreakerReport.lua"), "utf8");

  // attemptBatch has a variable number of keys per call (a tier's provider
  // count), so numberOfKeys is intentionally omitted -- ioredis then expects
  // the key count as the first argument at call time, the standard raw-EVAL
  // convention. report() always operates on exactly one key.
  redis.defineCommand("circuitBreakerAttemptBatch", { lua: attemptLua });
  redis.defineCommand("circuitBreakerReport", { numberOfKeys: 1, lua: reportLua });

  const redisWithScripts = redis as RedisWithCircuitBreakerScripts;

  return {
    async attemptBatch<T extends string>(providers: T[]): Promise<T[]> {
      if (providers.length === 0) return [];
      const keys = providers.map((provider) => `circuitbreaker:${provider}`);
      const results = await redisWithScripts.circuitBreakerAttemptBatch(
        keys.length,
        ...keys,
        config.cooldownSeconds,
        config.halfOpenLeaseSeconds,
      );
      return providers.filter((_, i) => results[i] === 1);
    },

    async report(provider, success) {
      try {
        const [state, transitioned] = await redisWithScripts.circuitBreakerReport(
          `circuitbreaker:${provider}`,
          success ? "1" : "0",
          config.failureThreshold,
          config.failureWindowSeconds,
        );
        if (transitioned !== 1) return;
        if (state === "open") {
          getLogger().warn({ provider }, "circuit_breaker.opened");
        } else if (state === "closed") {
          getLogger().info({ provider }, "circuit_breaker.closed");
        }
      } catch (err) {
        // Per the interface contract in types.ts -- report() never rejects.
        getLogger().warn({ err, provider }, "circuit breaker report failed");
      }
    },
  };
}
