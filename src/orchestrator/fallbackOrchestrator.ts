import { ProviderError } from "../errors";
import { getLogger } from "../logger";
import type { CircuitBreaker } from "../circuitBreaker/types";
import type { GatewayCompletionRequest, GatewayCompletionResult, ProviderAdapter } from "../adapters/types";
import { TIER_PROVIDERS, otherTier } from "./config";
import type { ProviderName, RoutingTier } from "./types";

export interface OrchestratorResult {
  result: GatewayCompletionResult;
  // The tier that actually served the request — may differ from the
  // starting tier after a downgrade (architecture.md §8's requests.tier
  // must record reality, not the hint the request started with).
  tier: RoutingTier;
}

export interface FallbackOrchestrator {
  complete(request: GatewayCompletionRequest, startingTier: RoutingTier): Promise<OrchestratorResult>;
}

export function createFallbackOrchestrator(
  adapters: Record<ProviderName, ProviderAdapter>,
  circuitBreaker: CircuitBreaker,
): FallbackOrchestrator {
  async function safeAttemptBatch(providers: ProviderName[]): Promise<ProviderName[]> {
    try {
      return await circuitBreaker.attemptBatch(providers);
    } catch (err) {
      // Fail open — hld.md §6/§9.3: a breaker-bookkeeping outage must not
      // block trying providers, it just loses the "skip known-bad
      // providers" optimization until Redis recovers.
      getLogger().warn({ err, providers }, "circuit breaker batch attempt failed");
      return providers;
    }
  }

  async function completeTier(
    request: GatewayCompletionRequest,
    tier: RoutingTier,
  ): Promise<GatewayCompletionResult | null> {
    const healthy = await safeAttemptBatch(TIER_PROVIDERS[tier]);

    for (const provider of healthy) {
      try {
        const result = await adapters[provider].complete(request);
        await circuitBreaker.report(provider, true); // never rejects — see circuitBreaker/types.ts
        return result;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err; // programmer error — don't swallow, don't fall back
        getLogger().warn({ err, provider, tier }, "provider call failed, trying next provider");
        await circuitBreaker.report(provider, false);
      }
    }
    return null; // every provider in this tier was skipped (open) or failed
  }

  return {
    async complete(request, startingTier) {
      const result = await completeTier(request, startingTier);
      if (result) return { result, tier: startingTier };

      getLogger().warn({ tier: startingTier }, "tier_downgrade");
      const fallbackTier = otherTier(startingTier);
      const fallbackResult = await completeTier(request, fallbackTier);
      if (fallbackResult) return { result: fallbackResult, tier: fallbackTier };

      throw new ProviderError("All providers unavailable", "none");
    },
  };
}
