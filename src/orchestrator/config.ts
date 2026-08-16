import type { ProviderName, RoutingTier } from "./types";

// architecture.md §6.3. The Complexity Router (build order step 4) will
// eventually choose which tier a request *starts* in; this map is the fixed
// half of that decision that already exists today.
export const TIER_PROVIDERS: Record<RoutingTier, ProviderName[]> = {
  complex: ["anthropic", "openai"],
  simple: ["gemini"],
};

export function otherTier(tier: RoutingTier): RoutingTier {
  return tier === "complex" ? "simple" : "complex";
}
