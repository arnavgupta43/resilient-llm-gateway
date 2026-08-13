import request from "supertest";
import { createApp } from "../../../src/app";
import { ProviderError } from "../../../src/errors";
import type { ProviderAdapter, GatewayCompletionResult } from "../../../src/adapters/types";
import type { RequestsRepo } from "../../../src/db/requestsRepo";

function makeAdapter(complete: ProviderAdapter["complete"]): ProviderAdapter {
  return { name: "anthropic", complete };
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

describe("POST /v1/completions", () => {
  it("returns 200 with the mapped completion and logs the request", async () => {
    const complete = jest.fn().mockResolvedValue(fakeResult);
    const logRequest = jest.fn().mockResolvedValue(undefined);
    const app = createApp({
      anthropicAdapter: makeAdapter(complete),
      requestsRepo: { logRequest } as unknown as RequestsRepo,
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

    expect(complete).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "What is the capital of France?" }],
      taskType: undefined,
    });
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: "key-abc",
        featureId: "capital-qa",
        provider: "anthropic",
        tier: "complex",
      }),
    );
  });

  it("returns 400 when the x-api-key header is missing", async () => {
    const app = createApp({
      anthropicAdapter: makeAdapter(jest.fn()),
      requestsRepo: { logRequest: jest.fn() } as unknown as RequestsRepo,
    });

    const response = await request(app)
      .post("/v1/completions")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(400);
  });

  it("returns 400 on an invalid body without calling the adapter", async () => {
    const complete = jest.fn();
    const app = createApp({
      anthropicAdapter: makeAdapter(complete),
      requestsRepo: { logRequest: jest.fn() } as unknown as RequestsRepo,
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "key-abc")
      .send({ feature_id: "f", messages: [] });

    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns 502 and does not log when the adapter throws a ProviderError", async () => {
    const complete = jest.fn().mockRejectedValue(new ProviderError("upstream 500", "anthropic"));
    const logRequest = jest.fn();
    const app = createApp({
      anthropicAdapter: makeAdapter(complete),
      requestsRepo: { logRequest } as unknown as RequestsRepo,
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "key-abc")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(502);
    expect(logRequest).not.toHaveBeenCalled();
  });
});
