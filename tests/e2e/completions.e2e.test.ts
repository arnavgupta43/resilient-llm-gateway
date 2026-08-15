import request from "supertest";
import { Pool } from "pg";
import Redis from "ioredis";
import { createApp } from "../../src/app";
import { createRequestsRepo } from "../../src/db/requestsRepo";
import { createApiKeysRepo } from "../../src/auth/apiKeysRepo";
import { createTokenBucket } from "../../src/rateLimiter/tokenBucket";
import { hashApiKey } from "../../src/auth/hashApiKey";
import { loadEnv } from "../../src/config/env";
import type { ProviderAdapter, GatewayCompletionResult } from "../../src/adapters/types";

// The only mock in this suite is the Anthropic adapter boundary (see
// CLAUDE.md "Testing") — everything else, including Postgres and Redis, is
// real.
function makeFakeAnthropicAdapter(result: GatewayCompletionResult): ProviderAdapter {
  return { name: "anthropic", complete: jest.fn().mockResolvedValue(result) };
}

const RAW_E2E_KEY = "e2e-key";

describe("POST /v1/completions (e2e)", () => {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL);
  let apiKeyId: string;

  beforeAll(async () => {
    // Upsert (not a plain INSERT) so this suite is safe to rerun against a
    // database that already has this key seeded from a previous run.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO api_keys (key_hash, tier) VALUES ($1, 'pro')
       ON CONFLICT (key_hash) DO UPDATE SET tier = EXCLUDED.tier
       RETURNING id`,
      [hashApiKey(RAW_E2E_KEY)],
    );
    apiKeyId = rows[0]!.id;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE requests");
    await redis.del(`ratelimit:${apiKeyId}`);
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  function buildApp(fakeResult: GatewayCompletionResult) {
    return createApp({
      anthropicAdapter: makeFakeAnthropicAdapter(fakeResult),
      requestsRepo: createRequestsRepo(pool),
      apiKeysRepo: createApiKeysRepo(pool),
      tokenBucket: createTokenBucket(redis),
    });
  }

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

    const response = await request(buildApp(fakeResult))
      .post("/v1/completions")
      .set("x-api-key", RAW_E2E_KEY)
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
      api_key_id: apiKeyId,
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
    const response = await request(
      buildApp({
        content: "",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      }),
    )
      .post("/v1/completions")
      .set("x-api-key", RAW_E2E_KEY)
      .send({ feature_id: "f", messages: [] });

    expect(response.status).toBe(400);

    const { rows } = await pool.query("SELECT * FROM requests");
    expect(rows).toHaveLength(0);
  });

  it("returns 401 and does not write a request row for an unrecognized api key", async () => {
    const response = await request(
      buildApp({
        content: "4",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        latencyMs: 1,
      }),
    )
      .post("/v1/completions")
      .set("x-api-key", "totally-unrecognized-key")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(401);

    const { rows } = await pool.query("SELECT * FROM requests");
    expect(rows).toHaveLength(0);
  });

  it("returns 429 against the real Redis bucket once it's exhausted", async () => {
    await redis.hset(`ratelimit:${apiKeyId}`, "tokens", "0", "last_refill_ms", Date.now());

    const response = await request(
      buildApp({
        content: "4",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        latencyMs: 1,
      }),
    )
      .post("/v1/completions")
      .set("x-api-key", RAW_E2E_KEY)
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(429);

    const { rows } = await pool.query("SELECT * FROM requests");
    expect(rows).toHaveLength(0);
  });
});
