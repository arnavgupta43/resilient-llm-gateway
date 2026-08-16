import request from "supertest";
import { Pool } from "pg";
import Redis from "ioredis";
import { createApp } from "../../src/app";
import { createRequestsRepo } from "../../src/db/requestsRepo";
import { createApiKeysRepo } from "../../src/auth/apiKeysRepo";
import { createTokenBucket } from "../../src/rateLimiter/tokenBucket";
import { createCircuitBreaker } from "../../src/circuitBreaker/circuitBreaker";
import { CIRCUIT_BREAKER_CONFIG } from "../../src/circuitBreaker/config";
import { createFallbackOrchestrator } from "../../src/orchestrator/fallbackOrchestrator";
import { hashApiKey } from "../../src/auth/hashApiKey";
import { loadEnv } from "../../src/config/env";
import { ProviderError } from "../../src/errors";
import type { ProviderAdapter, GatewayCompletionResult } from "../../src/adapters/types";
import type { ProviderName } from "../../src/orchestrator/types";

// The only mocks in this suite are at the provider adapter boundary (see
// CLAUDE.md "Testing") — everything else, including Postgres, Redis, the
// real circuit breaker Lua scripts, and the real FallbackOrchestrator, is
// exercised for real.
function makeFakeAdapter(name: ProviderName, complete: ProviderAdapter["complete"]): ProviderAdapter {
  return { name, complete };
}

const RAW_E2E_KEY = "e2e-key";
const BREAKER_KEYS = ["circuitbreaker:anthropic", "circuitbreaker:openai", "circuitbreaker:gemini"];

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
    await redis.del(`ratelimit:${apiKeyId}`, ...BREAKER_KEYS);
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  function buildApp(adapters: Partial<Record<ProviderName, ProviderAdapter>> = {}) {
    const circuitBreaker = createCircuitBreaker(redis, CIRCUIT_BREAKER_CONFIG);
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: adapters.anthropic ?? makeFakeAdapter("anthropic", jest.fn()),
        openai: adapters.openai ?? makeFakeAdapter("openai", jest.fn()),
        gemini: adapters.gemini ?? makeFakeAdapter("gemini", jest.fn()),
      },
      circuitBreaker,
    );
    return createApp({
      orchestrator,
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

    const app = buildApp({ anthropic: makeFakeAdapter("anthropic", jest.fn().mockResolvedValue(fakeResult)) });

    const response = await request(app)
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
    const response = await request(buildApp())
      .post("/v1/completions")
      .set("x-api-key", RAW_E2E_KEY)
      .send({ feature_id: "f", messages: [] });

    expect(response.status).toBe(400);

    const { rows } = await pool.query("SELECT * FROM requests");
    expect(rows).toHaveLength(0);
  });

  it("returns 401 and does not write a request row for an unrecognized api key", async () => {
    const response = await request(buildApp())
      .post("/v1/completions")
      .set("x-api-key", "totally-unrecognized-key")
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(401);

    const { rows } = await pool.query("SELECT * FROM requests");
    expect(rows).toHaveLength(0);
  });

  it("returns 429 against the real Redis bucket once it's exhausted", async () => {
    await redis.hset(`ratelimit:${apiKeyId}`, "tokens", "0", "last_refill_ms", Date.now());

    const response = await request(buildApp())
      .post("/v1/completions")
      .set("x-api-key", RAW_E2E_KEY)
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(429);

    const { rows } = await pool.query("SELECT * FROM requests");
    expect(rows).toHaveLength(0);
  });

  it("falls back to OpenAI within a single request when Anthropic fails", async () => {
    const anthropicComplete = jest.fn().mockRejectedValue(new ProviderError("upstream 500", "anthropic"));
    const openaiResult: GatewayCompletionResult = {
      content: "fallback answer",
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 5,
      completionTokens: 2,
      costUsd: 0.000002,
      latencyMs: 80,
    };

    const app = buildApp({
      anthropic: makeFakeAdapter("anthropic", anthropicComplete),
      openai: makeFakeAdapter("openai", jest.fn().mockResolvedValue(openaiResult)),
    });

    const response = await request(app)
      .post("/v1/completions")
      .set("x-api-key", RAW_E2E_KEY)
      .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(200);
    expect(response.body.provider).toBe("openai");

    const { rows } = await pool.query<{ provider: string; tier: string }>("SELECT provider, tier FROM requests");
    expect(rows[0]).toMatchObject({ provider: "openai", tier: "complex" });
  });

  it("opens Anthropic's real breaker after N consecutive failures and skips straight to OpenAI on the next request", async () => {
    const anthropicComplete = jest.fn().mockRejectedValue(new ProviderError("upstream 500", "anthropic"));
    const openaiComplete = jest.fn().mockResolvedValue({
      content: "ok",
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.000001,
      latencyMs: 10,
    });
    const app = buildApp({
      anthropic: makeFakeAdapter("anthropic", anthropicComplete),
      openai: makeFakeAdapter("openai", openaiComplete),
    });

    const send = () =>
      request(app)
        .post("/v1/completions")
        .set("x-api-key", RAW_E2E_KEY)
        .send({ feature_id: "f", messages: [{ role: "user", content: "hi" }] });

    // architecture.md §11: N=5 failures opens the breaker. Each of these
    // requests still succeeds overall — Anthropic fails, OpenAI covers it.
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.failureThreshold; i++) {
      const response = await send();
      expect(response.status).toBe(200);
    }

    expect(anthropicComplete).toHaveBeenCalledTimes(CIRCUIT_BREAKER_CONFIG.failureThreshold);

    const breakerState = await redis.hget("circuitbreaker:anthropic", "state");
    expect(breakerState).toBe("open");

    // The breaker is open and cooldown hasn't elapsed — this request should
    // skip Anthropic entirely rather than calling and failing it again.
    const response = await send();
    expect(response.status).toBe(200);
    expect(anthropicComplete).toHaveBeenCalledTimes(CIRCUIT_BREAKER_CONFIG.failureThreshold); // unchanged
    expect(openaiComplete).toHaveBeenCalledTimes(CIRCUIT_BREAKER_CONFIG.failureThreshold + 1);
  });
});
