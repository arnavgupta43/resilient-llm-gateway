import { loadEnv } from "./config/env";
import { createApp } from "./app";
import { AnthropicAdapter } from "./adapters/anthropic/anthropicAdapter";
import { getAnthropicClient } from "./adapters/anthropic/client";
import { OpenAIAdapter } from "./adapters/openai/openaiAdapter";
import { getOpenAIClient } from "./adapters/openai/client";
import { GeminiAdapter } from "./adapters/gemini/geminiAdapter";
import { getGeminiClient } from "./adapters/gemini/client";
import { createRequestsRepo } from "./db/requestsRepo";
import { getPool } from "./db/client";
import { createApiKeysRepo } from "./auth/apiKeysRepo";
import { createTokenBucket } from "./rateLimiter/tokenBucket";
import { createCircuitBreaker } from "./circuitBreaker/circuitBreaker";
import { CIRCUIT_BREAKER_CONFIG } from "./circuitBreaker/config";
import { createFallbackOrchestrator } from "./orchestrator/fallbackOrchestrator";
import { getRedisClient } from "./rateLimiter/redisClient";
import { baseLogger } from "./logger";

const env = loadEnv();

const circuitBreaker = createCircuitBreaker(getRedisClient(), CIRCUIT_BREAKER_CONFIG);

const orchestrator = createFallbackOrchestrator(
  {
    anthropic: new AnthropicAdapter(getAnthropicClient()),
    openai: new OpenAIAdapter(getOpenAIClient()),
    gemini: new GeminiAdapter(getGeminiClient()),
  },
  circuitBreaker,
);

const app = createApp({
  orchestrator,
  requestsRepo: createRequestsRepo(getPool()),
  apiKeysRepo: createApiKeysRepo(getPool()),
  tokenBucket: createTokenBucket(getRedisClient()),
});

app.listen(env.PORT, () => {
  baseLogger.info({ port: env.PORT }, "gateway listening");
});
