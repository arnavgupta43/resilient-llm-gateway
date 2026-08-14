import type { Request, Response } from "express";
import { createAuthMiddleware } from "../../../src/middleware/authMiddleware";
import { runWithRequestContext, getRequestContext } from "../../../src/logger/context";
import { hashApiKey } from "../../../src/auth/hashApiKey";
import { AuthenticationError } from "../../../src/errors";
import type { ApiKeysRepo } from "../../../src/auth/apiKeysRepo";

function makeReq(apiKeyHeader?: string): Request {
  return { header: (name: string) => (name.toLowerCase() === "x-api-key" ? apiKeyHeader : undefined) } as Request;
}

function makeRepo(findByKeyHash: ApiKeysRepo["findByKeyHash"]): ApiKeysRepo {
  return { findByKeyHash };
}

describe("authMiddleware", () => {
  it("resolves apiKeyId and rateLimitTier into the request context on a valid key", async () => {
    const repo = makeRepo(jest.fn().mockResolvedValue({ id: "key-uuid-1", tier: "pro" }));
    const middleware = createAuthMiddleware(repo);
    const next = jest.fn();

    await runWithRequestContext({ correlationId: "corr-1" }, async () => {
      await middleware(makeReq("raw-secret"), {} as Response, next);
      expect(getRequestContext()).toMatchObject({ apiKeyId: "key-uuid-1", rateLimitTier: "pro" });
    });

    expect(next).toHaveBeenCalledWith();
  });

  it("looks up the hash of the raw key, never the raw key itself", async () => {
    const findByKeyHash = jest.fn().mockResolvedValue({ id: "key-uuid-1", tier: "free" });
    const middleware = createAuthMiddleware(makeRepo(findByKeyHash));

    await runWithRequestContext({ correlationId: "corr-1" }, async () => {
      await middleware(makeReq("raw-secret"), {} as Response, jest.fn());
    });

    expect(findByKeyHash).toHaveBeenCalledWith(hashApiKey("raw-secret"));
  });

  it("throws AuthenticationError when the header is missing", async () => {
    const middleware = createAuthMiddleware(makeRepo(jest.fn()));

    await expect(
      runWithRequestContext({ correlationId: "corr-1" }, () => middleware(makeReq(undefined), {} as Response, jest.fn())),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("throws AuthenticationError when the key has no matching row", async () => {
    const repo = makeRepo(jest.fn().mockResolvedValue(null));
    const middleware = createAuthMiddleware(repo);

    await expect(
      runWithRequestContext({ correlationId: "corr-1" }, () => middleware(makeReq("unknown-key"), {} as Response, jest.fn())),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
