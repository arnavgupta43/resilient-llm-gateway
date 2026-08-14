import type { Request, Response } from "express";
import { createRateLimiterMiddleware } from "../../../src/middleware/rateLimiterMiddleware";
import { runWithRequestContext } from "../../../src/logger/context";
import { RateLimitExceededError, RateLimiterUnavailableError } from "../../../src/errors";
import type { TokenBucket } from "../../../src/rateLimiter/tokenBucket";

function makeBucket(checkAndConsume: TokenBucket["checkAndConsume"]): TokenBucket {
  return { checkAndConsume };
}

describe("rateLimiterMiddleware", () => {
  it("calls next() when the bucket allows the request", async () => {
    const checkAndConsume = jest.fn().mockResolvedValue({ allowed: true, tokensRemaining: 19 });
    const middleware = createRateLimiterMiddleware(makeBucket(checkAndConsume));
    const next = jest.fn();

    await runWithRequestContext({ correlationId: "corr-1", apiKeyId: "key-uuid-1", rateLimitTier: "free" }, () =>
      middleware({} as Request, {} as Response, next),
    );

    expect(next).toHaveBeenCalledWith();
    expect(checkAndConsume).toHaveBeenCalledWith("ratelimit:key-uuid-1", 20, 0.33, expect.any(Number));
  });

  it("throws RateLimitExceededError when the bucket rejects the request", async () => {
    const checkAndConsume = jest.fn().mockResolvedValue({ allowed: false, tokensRemaining: 0 });
    const middleware = createRateLimiterMiddleware(makeBucket(checkAndConsume));

    await expect(
      runWithRequestContext({ correlationId: "corr-1", apiKeyId: "key-uuid-1", rateLimitTier: "free" }, () =>
        middleware({} as Request, {} as Response, jest.fn()),
      ),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("throws RateLimiterUnavailableError when the bucket check fails, preserving the cause", async () => {
    const redisError = new Error("connection refused");
    const checkAndConsume = jest.fn().mockRejectedValue(redisError);
    const middleware = createRateLimiterMiddleware(makeBucket(checkAndConsume));

    await expect(
      runWithRequestContext({ correlationId: "corr-1", apiKeyId: "key-uuid-1", rateLimitTier: "pro" }, () =>
        middleware({} as Request, {} as Response, jest.fn()),
      ),
    ).rejects.toMatchObject({ constructor: RateLimiterUnavailableError, cause: redisError });
  });

  it("uses the enterprise tier's capacity and refill rate for that tier", async () => {
    const checkAndConsume = jest.fn().mockResolvedValue({ allowed: true, tokensRemaining: 119 });
    const middleware = createRateLimiterMiddleware(makeBucket(checkAndConsume));

    await runWithRequestContext({ correlationId: "corr-1", apiKeyId: "key-uuid-2", rateLimitTier: "enterprise" }, () =>
      middleware({} as Request, {} as Response, jest.fn()),
    );

    expect(checkAndConsume).toHaveBeenCalledWith("ratelimit:key-uuid-2", 120, 2, expect.any(Number));
  });
});
