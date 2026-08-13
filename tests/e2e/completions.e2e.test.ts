import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../../src/app";
import { createRequestsRepo } from "../../src/db/requestsRepo";
import { loadEnv } from "../../src/config/env";
import type { ProviderAdapter, GatewayCompletionResult } from "../../src/adapters/types";

// The only mock in this suite is the Anthropic adapter boundary (see
// CLAUDE.md "Testing") — everything else, including Postgres, is real.
function makeFakeAnthropicAdapter(result: GatewayCompletionResult): ProviderAdapter {
  return { name: "anthropic", complete: jest.fn().mockResolvedValue(result) };
}

describe("POST /v1/completions (e2e)", () => {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE requests");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists a row in the real requests table for a successful completion", async () => {
    const fakeResult: GatewayCompletionResult = {
      content: "4",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 8,
      completionTokens: 1,
      costUsd: 0.000039,
      latencyMs: 120,
    };

    const app = createApp({
      anthropicAdapter: makeFakeAnthropicAdapter(fakeResult),
      requestsRepo: createRequestsRepo(pool),
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "e2e-key")
      .send({
        feature_id: "arithmetic-qa",
        messages: [{ role: "user", content: "What is 2+2?" }],
      });

    expect(response.status).toBe(200);
    expect(response.body.content).toBe("4");

    const { rows } = await pool.query<{
      api_key_id: string;
      feature_id: string;
      provider: string;
      tier: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost_usd: string;
      latency_ms: number;
    }>("SELECT * FROM requests");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      api_key_id: "e2e-key",
      feature_id: "arithmetic-qa",
      provider: "anthropic",
      tier: "complex",
      prompt_tokens: 8,
      completion_tokens: 1,
      latency_ms: 120,
    });
    expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.000039, 6);
  });

  it("does not write a request row when the request body is invalid", async () => {
    const app = createApp({
      anthropicAdapter: makeFakeAnthropicAdapter({
        content: "",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      }),
      requestsRepo: createRequestsRepo(pool),
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", "e2e-key")
      .send({ feature_id: "f", messages: [] });

    expect(response.status).toBe(400);

    const { rows } = await pool.query("SELECT * FROM requests");
    expect(rows).toHaveLength(0);
  });
});
