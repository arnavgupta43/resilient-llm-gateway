import type { Queryable } from "../db/types";
import type { RateLimitTier } from "../rateLimiter/types";

export interface ApiKeyRecord {
  id: string;
  tier: RateLimitTier;
}

export interface ApiKeysRepo {
  findByKeyHash(keyHash: string): Promise<ApiKeyRecord | null>;
}

export function createApiKeysRepo(db: Queryable): ApiKeysRepo {
  return {
    async findByKeyHash(keyHash: string): Promise<ApiKeyRecord | null> {
      const { rows } = (await db.query("SELECT id, tier FROM api_keys WHERE key_hash = $1", [keyHash])) as {
        rows: { id: string; tier: string }[];
      };

      const row = rows[0];
      return row ? { id: row.id, tier: row.tier as RateLimitTier } : null;
    },
  };
}
