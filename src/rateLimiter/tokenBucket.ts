import { readFileSync } from "node:fs";
import path from "node:path";
import type { Redis } from "ioredis";

export interface TokenBucketResult {
  allowed: boolean;
  tokensRemaining: number;
}

export interface TokenBucket {
  checkAndConsume(
    bucketKey: string,
    capacity: number,
    refillPerSecond: number,
    ttlSeconds: number,
  ): Promise<TokenBucketResult>;
}

// ioredis's defineCommand attaches the script as a method at runtime, so
// TypeScript has no way to know it exists on Redis — this interface names
// just that one added method, keeping the cast contained to this file.
interface RedisWithTokenBucket extends Redis {
  tokenBucketCheck(key: string, capacity: number, refillRate: number, ttlSeconds: number): Promise<[number, string]>;
}

export function createTokenBucket(redis: Redis): TokenBucket {
  const lua = readFileSync(path.join(__dirname, "tokenBucket.lua"), "utf8");
  redis.defineCommand("tokenBucketCheck", { numberOfKeys: 1, lua });
  const redisWithScript = redis as RedisWithTokenBucket;

  return {
    async checkAndConsume(bucketKey, capacity, refillPerSecond, ttlSeconds) {
      const [allowed, tokensRemaining] = await redisWithScript.tokenBucketCheck(
        bucketKey,
        capacity,
        refillPerSecond,
        ttlSeconds,
      );
      return { allowed: allowed === 1, tokensRemaining: Number(tokensRemaining) };
    },
  };
}
