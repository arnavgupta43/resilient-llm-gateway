import express, { type Express } from "express";
import { requestContextMiddleware } from "./middleware/requestContext";
import { createAuthMiddleware } from "./middleware/authMiddleware";
import { createRateLimiterMiddleware } from "./middleware/rateLimiterMiddleware";
import { errorHandler } from "./middleware/errorHandler";
import { createCompletionsRouter } from "./routes/completions";
import type { ProviderAdapter } from "./adapters/types";
import type { RequestsRepo } from "./db/requestsRepo";
import type { ApiKeysRepo } from "./auth/apiKeysRepo";
import type { TokenBucket } from "./rateLimiter/tokenBucket";

export interface AppDependencies {
  anthropicAdapter: ProviderAdapter;
  requestsRepo: RequestsRepo;
  apiKeysRepo: ApiKeysRepo;
  tokenBucket: TokenBucket;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(requestContextMiddleware);

  // Mounted before auth/rate-limiting: healthchecks (load balancers, docker
  // compose) must stay reachable without an API key and shouldn't burn
  // against any key's rate-limit budget.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(createAuthMiddleware(deps.apiKeysRepo));
  app.use(createRateLimiterMiddleware(deps.tokenBucket));
  app.use(express.json());

  app.use(createCompletionsRouter(deps.anthropicAdapter, deps.requestsRepo));

  app.use(errorHandler);

  return app;
}
