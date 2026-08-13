import express, { type Express } from "express";
import { requestContextMiddleware } from "./middleware/requestContext";
import { errorHandler } from "./middleware/errorHandler";
import { createCompletionsRouter } from "./routes/completions";
import type { ProviderAdapter } from "./adapters/types";
import type { RequestsRepo } from "./db/requestsRepo";

export interface AppDependencies {
  anthropicAdapter: ProviderAdapter;
  requestsRepo: RequestsRepo;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(requestContextMiddleware);
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(createCompletionsRouter(deps.anthropicAdapter, deps.requestsRepo));

  app.use(errorHandler);

  return app;
}
