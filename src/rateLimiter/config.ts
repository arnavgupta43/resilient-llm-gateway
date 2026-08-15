import type { RateLimitTier } from "./types";

export interface TierConfig {
  capacity: number;
  refillPerSecond: number;
}

// architecture.md §11.
export const RATE_LIMIT_TIERS: Record<RateLimitTier, TierConfig> = {
  free: { capacity: 20, refillPerSecond: 0.33 },
  pro: { capacity: 60, refillPerSecond: 1 },
  enterprise: { capacity: 120, refillPerSecond: 2 },
};

// Time to refill from empty to full, plus a buffer — see lld.md §4.
export function bucketTtlSeconds(config: TierConfig): number {
  return Math.ceil(config.capacity / config.refillPerSecond) + 60;
}
