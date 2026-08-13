import pino, { type Logger } from "pino";
import { loadEnv } from "../config/env";
import { getRequestContext } from "./context";

const env = loadEnv();

export const baseLogger: Logger = pino({ level: env.LOG_LEVEL });

// Pulls the ALS-bound context so callers never have to thread a logger
// instance through function signatures — see CLAUDE.md "Logging".
export function getLogger(): Logger {
  const context = getRequestContext();
  if (!context) return baseLogger;

  return baseLogger.child({
    correlationId: context.correlationId,
    apiKeyId: context.apiKeyId,
    featureId: context.featureId,
  });
}
