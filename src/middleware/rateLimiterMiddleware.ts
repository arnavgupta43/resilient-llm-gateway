import type { NextFunction, Request, Response } from "express";
import { RateLimitExceededError, RateLimiterUnavailableError } from "../errors";
import { getRequestContext } from "../logger/context";
import { getLogger } from "../logger";
import { RATE_LIMIT_TIERS, bucketTtlSeconds } from "../rateLimiter/config";
import type { TokenBucket, TokenBucketResult } from "../rateLimiter/tokenBucket";
import type { RateLimitTier } from "../rateLimiter/types";

export function createRateLimiterMiddleware(tokenBucket: TokenBucket) {
  return async function rateLimiterMiddleware(_req: Request, _res: Response, next: NextFunction): Promise<void> {
    const context = getRequestContext();
    const apiKeyId = context?.apiKeyId as string;
    const tier = context?.rateLimitTier as RateLimitTier;
    const config = RATE_LIMIT_TIERS[tier];
    const ttlSeconds = bucketTtlSeconds(config);

    let result: TokenBucketResult;
    try {
      result = await tokenBucket.checkAndConsume(`ratelimit:${apiKeyId}`, config.capacity, config.refillPerSecond, ttlSeconds);
    } catch (err) {
      // Deliberate catch: converts an unrecognized ioredis failure into our
      // own typed error rather than letting it fall through as a generic
      // 500 — see CLAUDE.md "Error Handling". cause is preserved.
      throw new RateLimiterUnavailableError("Rate limiter unavailable", { cause: err });
    }

    if (!result.allowed) {
      getLogger().warn({ apiKeyId, tier }, "rate limit exceeded");
      throw new RateLimitExceededError("Rate limit exceeded");
    }

    next();
  };
}
