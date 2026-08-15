import { loadEnv } from "./config/env";
import { createApp } from "./app";
import { AnthropicAdapter } from "./adapters/anthropic/anthropicAdapter";
import { getAnthropicClient } from "./adapters/anthropic/client";
import { createRequestsRepo } from "./db/requestsRepo";
import { getPool } from "./db/client";
import { createApiKeysRepo } from "./auth/apiKeysRepo";
import { createTokenBucket } from "./rateLimiter/tokenBucket";
import { getRedisClient } from "./rateLimiter/redisClient";
import { baseLogger } from "./logger";

const env = loadEnv();

const app = createApp({
  anthropicAdapter: new AnthropicAdapter(getAnthropicClient()),
  requestsRepo: createRequestsRepo(getPool()),
  apiKeysRepo: createApiKeysRepo(getPool()),
  tokenBucket: createTokenBucket(getRedisClient()),
});

app.listen(env.PORT, () => {
  baseLogger.info({ port: env.PORT }, "gateway listening");
});
