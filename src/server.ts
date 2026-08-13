import { loadEnv } from "./config/env";
import { createApp } from "./app";
import { AnthropicAdapter } from "./adapters/anthropic/anthropicAdapter";
import { getAnthropicClient } from "./adapters/anthropic/client";
import { createRequestsRepo } from "./db/requestsRepo";
import { getPool } from "./db/client";
import { baseLogger } from "./logger";

const env = loadEnv();

const app = createApp({
  anthropicAdapter: new AnthropicAdapter(getAnthropicClient()),
  requestsRepo: createRequestsRepo(getPool()),
});

app.listen(env.PORT, () => {
  baseLogger.info({ port: env.PORT }, "gateway listening");
});
