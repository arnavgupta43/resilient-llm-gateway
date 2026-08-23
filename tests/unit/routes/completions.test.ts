import request from "supertest";
import { createApp } from "../../../src/app";
import { ProviderError } from "../../../src/errors";
import type { GatewayCompletionResult } from "../../../src/adapters/types";
import type { FallbackOrchestrator, OrchestratorResult } from "../../../src/orchestrator/fallbackOrchestrator";
import type { RequestsRepo } from "../../../src/db/requestsRepo";
import type { ApiKeysRepo } from "../../../src/auth/apiKeysRepo";
import type { TokenBucket } from "../../../src/rateLimiter/tokenBucket";

function makeOrchestrator(complete: FallbackOrchestrator["complete"]): FallbackOrchestrator {
  return { complete };
}

function makeApiKeysRepo(record: { id: string; tier: "free" | "pro" | "enterprise" } | null): ApiKeysRepo {
  return { findByKeyHash: jest.fn().mockResolvedValue(record) };
}

function makeAllowingTokenBucket(): TokenBucket {
  return { checkAndConsume: jest.fn().mockResolvedValue({ allowed: true, tokensRemaining: 19 }) };
}

const fakeResult: GatewayCompletionResult = {
  content: "Paris.",
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  promptTokens: 12,
  completionTokens: 3,
  costUsd: 0.000081,
  latencyMs: 250,
};

const fakeOutcome: OrchestratorResult = { result: fakeResult, tier: "complex" };

describe("POST /v1/completions", () => {
  it("returns 200 with the mapped completion and logs the tier the orchestrator actually served it from", async () => {
    const complete = jest.fn().mockResolvedValue(fakeOutcome);
    const logRequest = jest.fn().mockResolvedValue(undefined);
    const app = createApp({
      orchestrator: makeOrchestrator(complete),
      requestsRepo: { logRequest } as unknown as RequestsRepo,
      apiKeysRepo: makeApiKeysRepo({ id: "resolved-key-id", tier: "pro" }),
      tokenBucket: makeAllowingTokenBucket(),
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "key-abc")
      .send({
        feature_id: "capital-qa",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      content: "Paris.",
      provider: "anthropic",
      prompt_tokens: 12,
      completion_tokens: 3,
    });
    expect(response.headers["x-request-id"]).toBeDefined();

    expect(complete).toHaveBeenCalledWith(
      { messages: [{ role: "user", content: "What is the capital of France?" }], taskType: undefined },
      "simple",
    );
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: "resolved-key-id",
        featureId: "capital-qa",
        provider: "anthropic",
        tier: "complex",
      }),
    );
  });

  it("logs the downgraded tier when the orchestrator falls back to it, not the starting hint", async () => {
    const complete = jest.fn().mockResolvedValue({ result: { ...fakeResult, provider: "gemini" }, tier: "simple" });
    const logRequest = jest.fn().mockResolvedValue(undefined);
    const app = createApp({
      orchestrator: makeOrchestrator(complete),
      requestsRepo: { logRequest } as unknown as RequestsRepo,
      apiKeysRepo: makeApiKeysRepo({ id: "resolved-key-id", tier: "pro" }),
      tokenBucket: makeAllowingTokenBucket(),
    });

    await request(app)
      .post("/v1/completions")
      .set("x-api-key", "key-abc")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini", tier: "simple" }));
  });

  it("returns 401 when the x-api-key header is missing", async () => {
    const app = createApp({
      orchestrator: makeOrchestrator(jest.fn()),
      requestsRepo: { logRequest: jest.fn() } as unknown as RequestsRepo,
      apiKeysRepo: makeApiKeysRepo({ id: "resolved-key-id", tier: "free" }),
      tokenBucket: makeAllowingTokenBucket(),
    });

    const response = await request(app)
      .post("/v1/completions")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(401);
  });

  it("returns 401 when the x-api-key does not match any known key", async () => {
    const app = createApp({
      orchestrator: makeOrchestrator(jest.fn()),
      requestsRepo: { logRequest: jest.fn() } as unknown as RequestsRepo,
      apiKeysRepo: makeApiKeysRepo(null),
      tokenBucket: makeAllowingTokenBucket(),
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "not-a-real-key")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(401);
  });

  it("returns 429 and does not call the orchestrator when the rate limit is exceeded", async () => {
    const complete = jest.fn();
    const app = createApp({
      orchestrator: makeOrchestrator(complete),
      requestsRepo: { logRequest: jest.fn() } as unknown as RequestsRepo,
      apiKeysRepo: makeApiKeysRepo({ id: "resolved-key-id", tier: "free" }),
      tokenBucket: { checkAndConsume: jest.fn().mockResolvedValue({ allowed: false, tokensRemaining: 0 }) },
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "key-abc")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(429);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns 400 on an invalid body without calling the orchestrator", async () => {
    const complete = jest.fn();
    const app = createApp({
      orchestrator: makeOrchestrator(complete),
      requestsRepo: { logRequest: jest.fn() } as unknown as RequestsRepo,
      apiKeysRepo: makeApiKeysRepo({ id: "resolved-key-id", tier: "free" }),
      tokenBucket: makeAllowingTokenBucket(),
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "key-abc")
      .send({ feature_id: "f", messages: [] });

    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns 502 and does not log when the orchestrator throws ProviderError (all providers unavailable)", async () => {
    const complete = jest.fn().mockRejectedValue(new ProviderError("All providers unavailable", "none"));
    const logRequest = jest.fn();
    const app = createApp({
      orchestrator: makeOrchestrator(complete),
      requestsRepo: { logRequest } as unknown as RequestsRepo,
      apiKeysRepo: makeApiKeysRepo({ id: "resolved-key-id", tier: "free" }),
      tokenBucket: makeAllowingTokenBucket(),
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "key-abc")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(502);
    expect(logRequest).not.toHaveBeenCalled();
  });
});
