# LLD: Circuit Breaker + Fallback Orchestrator

**Status:** Finalized
**Depends on:** [`hld.md`](./hld.md)

## 1. Module layout

```
src/
  circuitBreaker/
    types.ts                        # NEW - BreakerState, CircuitBreaker interface
    config.ts                       # NEW - N/W/T config (architecture.md §11)
    circuitBreakerAttemptBatch.lua  # NEW - the batched health-check script (hld.md §5.3)
    circuitBreakerReport.lua        # NEW - the report/transition script
    circuitBreaker.ts               # NEW - loads both scripts, exposes attemptBatch()/report()
  orchestrator/
    types.ts                        # NEW - RoutingTier type
    config.ts                       # NEW - TIER_PROVIDERS map, otherTier()
    fallbackOrchestrator.ts         # NEW - the sequential fallback loop
  routes/
    completions.ts                  # MODIFIED - takes FallbackOrchestrator instead of one ProviderAdapter
  app.ts                            # MODIFIED - AppDependencies swaps anthropicAdapter for orchestrator
  server.ts                         # MODIFIED - constructs all 3 adapters + circuit breaker + orchestrator
```

Two separate top-level folders (`circuitBreaker/`, `orchestrator/`), not one — same reasoning as `rateLimiter/` vs `auth/` in the previous PR: the breaker only knows about Redis and provider *names* (strings), the orchestrator only knows about *providers* (adapters) and *tiers*. Neither needs to know the other's internals, only the narrow `CircuitBreaker` interface between them. This is the same "depend on an interface, not a concrete module" shape as `ApiKeysRepo`/`TokenBucket` from the rate limiter PR.

## 2. `circuitBreaker/types.ts`

```ts
export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreaker {
  // Returns the subset of `providers` currently allowed to be tried, in the
  // same order they were passed in. One Redis round-trip regardless of list
  // length (hld.md §5.3).
  attemptBatch(providers: string[]): Promise<string[]>;

  // Records the outcome of an actual attempt. Never throws — Redis failures
  // are caught and logged inside the implementation (hld.md §6), because a
  // bookkeeping write failing must never affect the caller's control flow.
  report(provider: string, success: boolean): Promise<void>;
}
```

Making `report()` swallow its own errors *inside the interface's contract* (not just as an implementation detail the orchestrator has to remember) is deliberate: it means `fallbackOrchestrator.ts` never needs its own `safeReport` wrapper — the "never rejects" guarantee lives in exactly one place, the thing that actually talks to Redis, instead of being a discipline every caller has to remember to apply. `attemptBatch()` still *can* reject (Redis down), so the orchestrator keeps its own `safeAttemptBatch` for that one — see §5.

## 3. `circuitBreaker/config.ts`

```ts
export interface CircuitBreakerConfig {
  failureThreshold: number;      // N
  failureWindowSeconds: number;  // W
  cooldownSeconds: number;       // T
  halfOpenLeaseSeconds: number;  // reuses T — see hld.md §5.3
}

// architecture.md §11.
export const CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowSeconds: 60,
  cooldownSeconds: 30,
  halfOpenLeaseSeconds: 30,
};
```

## 4. `circuitBreakerAttemptBatch.lua`

Exactly as drafted in `hld.md` §5.3 — reproduced here as the actual file, not a review sketch:

```lua
-- KEYS[1..N]  = circuitbreaker:{provider}, one per provider in the tier,
--               in the order the caller wants results back in.
-- ARGV[1]     = cooldown_seconds (T)
-- ARGV[2]     = half_open_lease_seconds
local cooldown = tonumber(ARGV[1])
local half_open_lease = tonumber(ARGV[2])

-- Redis's own clock, frozen for the life of this script -- not a timestamp
-- passed from Node -- so every gateway instance evaluates cooldowns against
-- the same clock (same reasoning as tokenBucket.lua).
local time = redis.call('TIME')
local now = tonumber(time[1]) + (tonumber(time[2]) / 1000000)

local allowed = {}

for i, key in ipairs(KEYS) do
  local data = redis.call('HMGET', key, 'state', 'opened_at')
  local state = data[1]
  local opened_at = tonumber(data[2])

  if state == false or state == 'closed' then
    allowed[i] = 1
  elseif state == 'open' and opened_at ~= nil and (now - opened_at) >= cooldown then
    -- Cooldown elapsed: this call becomes the single half-open probe for
    -- this provider. The lease TTL means a probe caller that crashes before
    -- reporting back doesn't wedge the breaker open forever -- the key just
    -- expires and the next attempt re-evaluates from a clean slate.
    redis.call('HSET', key, 'state', 'half_open', 'opened_at', tostring(now))
    redis.call('EXPIRE', key, half_open_lease)
    allowed[i] = 1
  else
    -- Still open (cooldown not elapsed) or half_open (a probe is already
    -- outstanding for this provider) -- either way, skip it.
    allowed[i] = 0
  end
end

return allowed
```

## 5. `circuitBreakerReport.lua`

This is new relative to the HLD — the HLD specified the *transition table* (§4.2) but not the script itself. Two design decisions worth calling out:

**Decision 1 — treat a report against a stray `open` state the same as `closed`.** Normally `report()` only ever runs for a provider `attemptBatch()` just granted access to, so the state at report-time should be `closed` or `half_open`. But under the Redis-down fail-open path (`hld.md` §6), `attemptBatch` can grant access *without having checked Redis at all* — so by the time `report()` runs, the real stored state could be anything, including `open` (opened by a *different* concurrent request in the meantime). Rather than special-case this, the script treats "not `half_open`" uniformly: success closes it, failure runs the normal threshold-counting logic. This is simpler than adding a third branch and produces the same end state a `closed`-state report would (a real success is real evidence, wherever it came from).

**Decision 2 — half-open failures skip the counter entirely.** Per the transition table, a failed probe goes straight back to `open` regardless of `failure_count` — it doesn't need to re-cross the threshold, one bad probe is enough evidence the provider isn't recovered yet.

```lua
-- KEYS[1]  = circuitbreaker:{provider}
-- ARGV[1]  = "1" if the attempt succeeded, "0" if it failed
-- ARGV[2]  = failure_threshold (N)
-- ARGV[3]  = failure_window_seconds (W)
local key = KEYS[1]
local success = ARGV[1] == '1'
local threshold = tonumber(ARGV[2])
local window = tonumber(ARGV[3])

local time = redis.call('TIME')
local now = tonumber(time[1]) + (tonumber(time[2]) / 1000000)

local data = redis.call('HMGET', key, 'state', 'failure_count')
local state = data[1]
local failure_count = tonumber(data[2]) or 0

local new_state
local transitioned = 0

if state == 'half_open' then
  if success then
    new_state = 'closed'
    redis.call('HSET', key, 'state', 'closed', 'failure_count', 0)
    redis.call('PERSIST', key)
  else
    new_state = 'open'
    redis.call('HSET', key, 'state', 'open', 'opened_at', tostring(now))
    redis.call('PERSIST', key)
  end
  transitioned = 1
else
  if success then
    new_state = 'closed'
    if state == 'open' then transitioned = 1 end
    redis.call('HSET', key, 'state', 'closed', 'failure_count', 0)
    redis.call('PERSIST', key)
  else
    failure_count = failure_count + 1
    if failure_count >= threshold then
      new_state = 'open'
      transitioned = 1
      redis.call('HSET', key, 'state', 'open', 'opened_at', tostring(now), 'failure_count', failure_count)
      redis.call('PERSIST', key)
    else
      new_state = 'closed'
      redis.call('HSET', key, 'state', 'closed', 'failure_count', failure_count)
      -- Failure-window approximation (hld.md §9.2): refresh a TTL on every
      -- failure. If W seconds pass with no further failures, the key
      -- expires and the next report starts failure_count fresh at 0 --
      -- same practical effect as a true sliding window resetting, without
      -- needing a timestamp list per provider.
      redis.call('EXPIRE', key, window)
    end
  end
end

return { new_state, transitioned }
```

`transitioned` is `1` only on an actual state *change* (closed→open, open/closed→closed via success, half_open→either), never on "still closed, count went from 2 to 3." This is what lets the TS wrapper fire `circuit_breaker.opened` / `circuit_breaker.closed` exactly once per transition instead of once per failed request while already open.

## 6. `circuitBreaker/circuitBreaker.ts`

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Redis } from "ioredis";
import { getLogger } from "../logger";
import type { BreakerState, CircuitBreaker } from "./types";
import type { CircuitBreakerConfig } from "./config";

// defineCommand attaches these as methods at runtime, so TypeScript can't
// know they exist on Redis -- same pattern as RedisWithTokenBucket in
// rateLimiter/tokenBucket.ts, kept contained to this one file.
interface RedisWithCircuitBreakerScripts extends Redis {
  circuitBreakerAttemptBatch(...args: (string | number)[]): Promise<number[]>;
  circuitBreakerReport(
    key: string,
    success: "0" | "1",
    threshold: number,
    window: number,
  ): Promise<[BreakerState, number]>;
}

export function createCircuitBreaker(redis: Redis, config: CircuitBreakerConfig): CircuitBreaker {
  const attemptLua = readFileSync(path.join(__dirname, "circuitBreakerAttemptBatch.lua"), "utf8");
  const reportLua = readFileSync(path.join(__dirname, "circuitBreakerReport.lua"), "utf8");

  // attemptBatch has a variable number of keys per call (a tier's provider
  // count), so numberOfKeys is intentionally omitted -- ioredis then expects
  // the key count as the first argument at call time, standard raw-EVAL
  // convention. report() always operates on exactly one key.
  redis.defineCommand("circuitBreakerAttemptBatch", { lua: attemptLua });
  redis.defineCommand("circuitBreakerReport", { numberOfKeys: 1, lua: reportLua });

  const redisWithScripts = redis as RedisWithCircuitBreakerScripts;

  return {
    async attemptBatch(providers) {
      if (providers.length === 0) return [];
      const keys = providers.map((provider) => `circuitbreaker:${provider}`);
      const results = await redisWithScripts.circuitBreakerAttemptBatch(
        keys.length,
        ...keys,
        config.cooldownSeconds,
        config.halfOpenLeaseSeconds,
      );
      return providers.filter((_, i) => results[i] === 1);
    },

    async report(provider, success) {
      try {
        const [state, transitioned] = await redisWithScripts.circuitBreakerReport(
          `circuitbreaker:${provider}`,
          success ? "1" : "0",
          config.failureThreshold,
          config.failureWindowSeconds,
        );
        if (transitioned !== 1) return;
        if (state === "open") {
          getLogger().warn({ provider }, "circuit_breaker.opened");
        } else if (state === "closed") {
          getLogger().info({ provider }, "circuit_breaker.closed");
        }
      } catch (err) {
        // Per the interface contract in types.ts -- report() never rejects.
        getLogger().warn({ err, provider }, "circuit breaker report failed");
      }
    },
  };
}
```

## 7. `orchestrator/types.ts` + `orchestrator/config.ts`

```ts
// types.ts
export type RoutingTier = "complex" | "simple";
```

```ts
// config.ts
import type { RoutingTier } from "./types";

// architecture.md §6.3. The Complexity Router (build order step 4) will
// eventually choose which tier a request *starts* in; this map is the fixed
// half of that decision that already exists today.
export const TIER_PROVIDERS: Record<RoutingTier, string[]> = {
  complex: ["anthropic", "openai"],
  simple: ["gemini"],
};

export function otherTier(tier: RoutingTier): RoutingTier {
  return tier === "complex" ? "simple" : "complex";
}
```

## 8. `orchestrator/fallbackOrchestrator.ts`

One correctness detail that only surfaced while writing this (not called out in the HLD's pseudocode): `architecture.md` §8's `requests.tier` column has to record the tier that **actually served** the request, not just the starting hint — after a downgrade, that's `simple`, not `complex`. So `complete()` returns which tier won, alongside the result, rather than just the `GatewayCompletionResult` the HLD's sketch returned.

```ts
import { ProviderError } from "../errors";
import { getLogger } from "../logger";
import type { CircuitBreaker } from "../circuitBreaker/types";
import type { GatewayCompletionRequest, GatewayCompletionResult, ProviderAdapter } from "../adapters/types";
import { TIER_PROVIDERS, otherTier } from "./config";
import type { RoutingTier } from "./types";

export interface OrchestratorResult {
  result: GatewayCompletionResult;
  tier: RoutingTier; // the tier that actually served the request -- may differ from the starting tier after a downgrade
}

export interface FallbackOrchestrator {
  complete(request: GatewayCompletionRequest, startingTier: RoutingTier): Promise<OrchestratorResult>;
}

export function createFallbackOrchestrator(
  adapters: Record<string, ProviderAdapter>,
  circuitBreaker: CircuitBreaker,
): FallbackOrchestrator {
  async function safeAttemptBatch(providers: string[]): Promise<string[]> {
    try {
      return await circuitBreaker.attemptBatch(providers);
    } catch (err) {
      getLogger().warn({ err, providers }, "circuit breaker batch attempt failed");
      return providers; // fail open -- hld.md §6/§9.3
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
        await circuitBreaker.report(provider, true); // never rejects, see circuitBreaker/types.ts
        return result;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err; // programmer error -- don't swallow, don't fall back
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
```

Note `report()` is called directly here, no local `safeReport` wrapper needed — per §2, that guarantee is already built into `circuitBreaker.report()` itself.

## 9. Wiring changes

### 9.1 `routes/completions.ts`

```ts
import type { FallbackOrchestrator } from "../orchestrator/fallbackOrchestrator";
import type { RoutingTier } from "../orchestrator/types";

// Until the Complexity Router (build order step 4) derives this per-request,
// every request starts in the complex tier -- unchanged behavior from today,
// just expressed as the orchestrator's starting point instead of a fixed
// single-provider call.
const STARTING_TIER: RoutingTier = "complex";

export function createCompletionsRouter(orchestrator: FallbackOrchestrator, requestsRepo: RequestsRepo): Router {
  const router = Router();

  router.post("/v1/completions", async (req, res, next) => {
    try {
      const context = getRequestContext();
      const body = completionRequestSchema.parse(req.body);
      if (context) context.featureId = body.feature_id;

      const { result, tier } = await orchestrator.complete(
        { messages: body.messages, taskType: body.task_type },
        STARTING_TIER,
      );

      await requestsRepo.logRequest({
        apiKeyId: context?.apiKeyId as string,
        featureId: body.feature_id,
        provider: result.provider,
        tier,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      });

      getLogger().info({ provider: result.provider, tier, latencyMs: result.latencyMs }, "completion served");

      res.status(200).json({
        content: result.content,
        provider: result.provider,
        model: result.model,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        cost_usd: result.costUsd,
        latency_ms: result.latencyMs,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        next(new ValidationError(err.issues.map((issue) => issue.message).join("; ")));
        return;
      }
      next(err);
    }
  });

  return router;
}
```

Everything else in the route (the zod schema, error translation, response shape) is untouched — only the call site and what gets logged as `tier` changed.

### 9.2 `app.ts`

```ts
export interface AppDependencies {
  orchestrator: FallbackOrchestrator; // replaces anthropicAdapter
  requestsRepo: RequestsRepo;
  apiKeysRepo: ApiKeysRepo;
  tokenBucket: TokenBucket;
}
...
app.use(createCompletionsRouter(deps.orchestrator, deps.requestsRepo));
```

### 9.3 `server.ts`

```ts
import { AnthropicAdapter } from "./adapters/anthropic/anthropicAdapter";
import { getAnthropicClient } from "./adapters/anthropic/client";
import { OpenAIAdapter } from "./adapters/openai/openaiAdapter";
import { getOpenAIClient } from "./adapters/openai/client";
import { GeminiAdapter } from "./adapters/gemini/geminiAdapter";
import { getGeminiClient } from "./adapters/gemini/client";
import { createCircuitBreaker } from "./circuitBreaker/circuitBreaker";
import { CIRCUIT_BREAKER_CONFIG } from "./circuitBreaker/config";
import { createFallbackOrchestrator } from "./orchestrator/fallbackOrchestrator";

const circuitBreaker = createCircuitBreaker(getRedisClient(), CIRCUIT_BREAKER_CONFIG);

const orchestrator = createFallbackOrchestrator(
  {
    anthropic: new AnthropicAdapter(getAnthropicClient()),
    openai: new OpenAIAdapter(getOpenAIClient()),
    gemini: new GeminiAdapter(getGeminiClient()),
  },
  circuitBreaker,
);

const app = createApp({
  orchestrator,
  requestsRepo: createRequestsRepo(getPool()),
  apiKeysRepo: createApiKeysRepo(getPool()),
  tokenBucket: createTokenBucket(getRedisClient()),
});
```

Both the circuit breaker and the rate limiter's token bucket share the same `getRedisClient()` singleton — no new Redis connection, no new `docker-compose.yml` entry, this PR reuses the `redis` / `redis_test` services the rate limiter PR already added.

## 10. Testing

Following `CLAUDE.md`'s unit-first, mock-free-e2e split:

| File | Covers |
|---|---|
| `tests/unit/circuitBreaker/circuitBreakerAttemptBatch.test.ts` | Real local Redis (same exception as `tokenBucket.test.ts` — the logic *is* the Lua, mocking Redis would test the mock). Closed→allow; open+cooldown-not-elapsed→reject; open+cooldown-elapsed→exactly one probe admitted among concurrent callers, others rejected; half-open lease expiry→treated as fresh/closed. |
| `tests/unit/circuitBreaker/circuitBreakerReport.test.ts` | Real local Redis. Boundary at exactly `N=5`; window-TTL reset behavior; half-open success→closed; half-open failure→open regardless of count; `transitioned` flag only set on actual state changes. |
| `tests/unit/orchestrator/fallbackOrchestrator.test.ts` | Fake `CircuitBreaker` + fake `ProviderAdapter`s, no real Redis. Sequential iteration order; skip-on-empty-`attemptBatch`-result; fallback to next provider on `ProviderError`; non-`ProviderError` rethrown without fallback; cross-tier downgrade + `tier_downgrade` log; all-exhausted→throws `ProviderError`; returned `tier` matches whichever tier actually served the request. |
| `tests/unit/routes/completions.test.ts` (existing file, updated) | Swap the fake `ProviderAdapter` for a fake `FallbackOrchestrator`; assert `requestsRepo.logRequest` is called with the *orchestrator's* returned `tier`, not a hardcoded constant. |
| `tests/e2e/completions.e2e.test.ts` (existing file, updated) | Real Redis + Postgres. New case: force Anthropic's adapter to fail (mocked at the adapter boundary per CLAUDE.md's adapter-mocking exception) enough times to open its breaker, confirm the next request goes straight to OpenAI without attempting Anthropic, confirm `requests.tier` / breaker Redis state reflect it. |

Adapters remain mocked at the SDK-client boundary in all of the above (`AnthropicMessagesClient` / etc. fakes, same as the existing adapter unit tests) — never a real Anthropic/OpenAI/Gemini call in the suite, per CLAUDE.md.

## 11. Out of scope

Same as `hld.md` §10: Complexity Router, RabbitMQ/Event Publisher, admin/observability endpoints.
