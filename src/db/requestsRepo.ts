import type { Queryable } from "./types";

export interface RequestLogEntry {
  apiKeyId: string;
  featureId: string;
  provider: string;
  tier: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface RequestsRepo {
  logRequest(entry: RequestLogEntry): Promise<void>;
}

export function createRequestsRepo(db: Queryable): RequestsRepo {
  return {
    async logRequest(entry: RequestLogEntry): Promise<void> {
      await db.query(
        `INSERT INTO requests
           (api_key_id, feature_id, provider, tier, prompt_tokens, completion_tokens, cost_usd, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.apiKeyId,
          entry.featureId,
          entry.provider,
          entry.tier,
          entry.promptTokens,
          entry.completionTokens,
          entry.costUsd,
          entry.latencyMs,
        ],
      );
    },
  };
}
