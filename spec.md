# Resilient LLM Gateway — Technical Spec

> **Revision note (2026-08-13):** This spec was revised after the initial draft to drop the semantic caching layer (originally §6.3 Semantic Cache + §7 Volatile-Content Filter) and to resolve the open decisions from the original §12. See §12 "Revision History" at the bottom for the full rationale. `architecture.md` in the project repo tracks the same design going forward — treat that file as authoritative if the two ever drift.

## 1. Purpose

A self-hosted gateway that sits between client applications and multiple LLM providers (Anthropic, OpenAI, Gemini). It solves three problems apps hit when calling providers directly:

1. **Fragility** — one provider going down or rate-limiting takes the whole app down.
2. **Cost blindness** — no visibility into what's being spent per feature.
3. **Cost inefficiency** — sending every request to an expensive model even when a cheap one would do.

It does this with per-key rate limiting, complexity-based routing, cross-provider fallback with circuit breakers, per-request cost/token logging, and an event-driven alerting path that ends in an AWS Lambda notification sink.

## 2. Scope & Non-Goals

**In scope:** stateless, task-based LLM calls (summarization, classification, doc Q&A, content generation). The client sends the full message history with each request — the gateway does not maintain conversation state.

**Non-goals:**
- Not a persistent chatbot session manager (no server-side thread state).
- No frontend / dashboard. Alerting ends at a Slack/email message; observability of events is via logs + Postgres.
- No ML-based routing or classification — all routing decisions are heuristic (see §6.3). A wrong heuristic route is recoverable; a wrong learned-model route silently returns a bad answer.
- **No caching layer.** An earlier draft of this spec included a semantic (vector-similarity) cache. It was dropped: its core failure mode — near-duplicate prompts ("weather in Kanpur" vs "weather in Nagpur") scoring high similarity but needing different answers — was already an accepted risk in that draft rather than a solved problem, and a cache hit that's silently wrong is worse than a cache miss. See §12 for the full rationale and the fallback approach (exact-match caching) if this is revisited later.

**Accepted tradeoffs:**
- Routing across providers forfeits provider-specific perks (e.g. prompt-caching discounts).

## 3. Tech Stack

- **Language/runtime:** Node.js + TypeScript
- **HTTP framework:** Express (5.x)
- **Redis:** rate-limiter buckets, circuit-breaker state
- **Postgres:** per-request cost/token log + event audit log
- **RabbitMQ:** internal event bus
- **AWS:** EventBridge (event routing rule) + Lambda (alert sender)

No embedding model / vector search dependency — removed along with the caching layer.

## 4. High-Level Architecture

```mermaid
flowchart TD
    Client[Client Apps - full history each call] --> GW[Gateway Core]

    GW --> RL[Redis: Token Bucket Rate Limiter]
    GW --> Router[Complexity Router]

    CB[(Redis: Circuit Breaker State)] --> FB[Fallback Orchestrator]
    Router --> FB

    FB --> A1[Anthropic Adapter]
    FB --> A2[OpenAI Adapter]
    FB --> A3[Gemini Adapter]

    GW --> PG[(Postgres: request + cost log)]
    GW --> EP[Event Publisher util]

    EP --> MQ[RabbitMQ: event bus]
    MQ --> LOG[Logger Consumer] --> PG
    MQ --> AR[Alert Relay Consumer]
    AR -->|severity=alert only| EB[AWS EventBridge]
    EB --> L[AWS Lambda]
    L --> SL[Slack / Email]
```

## 5. Request Lifecycle (happy path)

1. Client sends a completion request with an API key, full message history, and an optional `task_type` hint.
2. **Rate Limiter** checks the key's tier bucket. Empty → reject 429 + fire `rate_limit.exceeded`.
3. **Complexity Router** scores the request and picks a tier, producing an ordered provider list.
4. **Fallback Orchestrator** consults **Circuit Breaker state**, picks the first healthy provider in the list, calls it via its **Adapter**.
5. On success → return response; **Gateway Core** logs `{provider, tier, prompt_tokens, completion_tokens, cost, latency}` to Postgres.

## 6. Components

### 6.1 Gateway Core
Owns the request lifecycle and orchestrates every other component. The only component that writes the per-request cost/token row to Postgres (it's the only place that has the final provider, token counts, and latency after the call returns).

### 6.2 Rate Limiter (Redis, token bucket, tiered)
- **Per-API-key**, not per-provider. Stops one client starving others / burning the budget.
- **Algorithm:** token bucket — capacity `C`, refill rate `R` tokens/sec, looked up per key's tier. Every request costs a flat 1 token (no prompt-size weighting — kept simple deliberately for v1).
- **Tiers:**

  | Tier | Capacity C | Refill R | Sustained rate |
  |---|---|---|---|
  | free | 20 | 0.33/sec | ~20 req/min |
  | pro | 60 | 1/sec | ~60 req/min |
  | enterprise | 120 | 2/sec | ~120 req/min |

  Key → tier mapping stored in Postgres (`api_keys` table, §9).
- **Atomicity:** check-refill-deduct must be one atomic op. Implement as a Lua script via `EVAL` (Redis runs Lua single-threaded → no race). `rate-limiter-flexible` (npm) implements this pattern if not hand-rolling.
- Fires `rate_limit.exceeded` on rejection.

### 6.3 Complexity Router
- Pure decision function. Input: request. Output: ordered provider list (a tier). Does **not** call providers, does **not** log.
- **Tiers:** `complex` → `[Anthropic, OpenAI]`; `simple` → `[Gemini]`.
- **Heuristics (no ML):** caller-supplied `task_type` hint (most reliable) → else prompt length, presence of code blocks, reasoning keywords ("explain step by step", "prove", "debug").
- Note: "tier" here means *model-routing tier* (complex/simple), distinct from the *rate-limit tier* (free/pro/enterprise) in §6.2 — same word, two unrelated axes.

### 6.4 Circuit Breaker (Redis state)
- **Per-provider** state stored in Redis (shared across gateway instances — one source of truth, avoids instance A thinking a provider is dead while instance B keeps hammering it).
- **Stored per provider:** `state (closed|open|half-open)`, `failure_count`, `opened_at`.
- **Config:** `N=5` (failure threshold), `W=60s` (window), `T=30s` (cooldown).
- **Transitions:**
  - closed → fail → increment `failure_count`; 5 failures within 60s → **open**, set `opened_at`, fire `circuit_breaker.opened`.
  - open → all calls skipped until 30s elapses since `opened_at`.
  - after cooldown → **half-open** → allow one test request. Success → close, reset, fire `circuit_breaker.closed`. Fail → back to open, reset cooldown.
- **Atomicity:** increment + threshold-check + state-flip in one Lua `EVAL` (concurrent failures from multiple instances must not double-count or stomp).

### 6.5 Fallback Orchestrator
- Takes the Router's ordered provider list, filters out providers whose breaker is open, calls the first healthy one via its Adapter.
- On failure → increment that provider's breaker count, retry next provider **in the same tier**.
- If every provider in the tier is open → cross to the cheap tier as a last resort AND fire `tier_downgrade` (a hard request answered by a weak model is a correctness concern, flagged separately from availability).

### 6.6 Provider Adapters
- One per provider (Anthropic, OpenAI, Gemini). Normalize the gateway's internal request/response shape to/from each provider's API (including translating the full message history into each provider's message format). Core logic stays provider-agnostic.

### 6.7 Event Publisher
- Shared utility `publish(eventType, payload, severity)` — **not** a standalone watcher. Components call it directly when their own state changes.
- Writes to RabbitMQ only (single write path). Every event carries a `severity` (`info` | `alert`).

### 6.8 RabbitMQ (event bus)
- Single fan-out point. Two independent consumers:
  - **Logger Consumer** → writes every event to the Postgres event-audit table.
  - **Alert Relay Consumer** → filters `severity=alert`, forwards only those to AWS EventBridge via the AWS SDK (`PutEvents`).

### 6.9 AWS EventBridge + Lambda (alert sink)
- **EventBridge:** a rule matching `{"detail": {"severity": ["alert"]}}` targets the Lambda. Filtering lives in config, not code — new alert conditions don't require redeploying.
- **Lambda:** receives the event, formats it, POSTs to a Slack webhook / sends email. ~20 lines. Kept off local infra deliberately — the only cloud piece, an isolated notification sink that can be swapped/removed without touching core failover logic. Lambda can't natively subscribe to RabbitMQ, which is *why* EventBridge exists in the design — it's the door Lambda listens at.

## 7. Events

| Event | Published by | Severity | Reaches Lambda? |
|---|---|---|---|
| `circuit_breaker.opened` | Circuit Breaker | alert | yes |
| `tier_downgrade` | Fallback Orchestrator | alert | yes |
| `circuit_breaker.closed` | Circuit Breaker | info | no (logged only) |
| `rate_limit.exceeded` | Rate Limiter | info | no (logged only; fires often, would be alert-noise) |

All events → RabbitMQ → Postgres audit. Only `alert` → EventBridge → Lambda → Slack.

## 8. Data Model (Postgres)

**`requests`** (per-request cost log, written by Gateway Core)
`id, api_key_id, feature_id, provider, tier, prompt_tokens, completion_tokens, cost_usd, latency_ms, created_at`

**`events`** (audit log, written by Logger Consumer)
`id, event_type, severity, payload_json, created_at`

**`api_keys`** (key → rate-limit tier mapping)
`id, key_hash, tier (free|pro|enterprise), created_at`

## 9. Deployment Split

- **Local / self-hosted:** Gateway Core, Redis, Postgres, RabbitMQ, Logger Consumer, Alert Relay Consumer.
- **AWS:** EventBridge (rule/config) + Lambda (alert code).
- The Alert Relay is the only component that talks to AWS (SDK `PutEvents`).

## 10. Build Order

1. Gateway Core + one Provider Adapter (end-to-end single-provider passthrough) + Postgres request logging.
2. Rate Limiter (Lua token bucket, tiered).
3. Add remaining adapters + Circuit Breaker + Fallback Orchestrator (multi-provider failover working).
4. Complexity Router + tier-aware fallback + `tier_downgrade`.
5. Event Publisher + RabbitMQ + Logger Consumer (internal event path).
6. Alert Relay + EventBridge + Lambda (AWS alert path) — last, since it's optional polish on top of a working gateway.

## 11. Config Values

- Rate limiter: flat 1 token per request. Tiers: free (C=20, R=0.33/s), pro (C=60, R=1/s), enterprise (C=120, R=2/s).
- Circuit breaker: N=5, W=60s, T=30s.

## 12. Revision History

**2026-08-13 — caching layer removed, open decisions resolved.**

The original draft of this spec (§6.3 Semantic Cache, §7 Volatile-Content Filter) proposed a Redis Stack vector-similarity cache: embed incoming prompts, look up nearest neighbor above a similarity threshold (~0.92), return the cached response on a hit. It was scoped out after discussion:

- Its own known-risk section already flagged the core problem — near-duplicate prompts with different parameters (e.g. "weather in Kanpur" vs "weather in Nagpur") scoring high similarity but needing different answers — as an *accepted* false-positive/false-negative risk, not a solved one.
- A cache hit that's silently wrong is a harder bug to catch than a cache miss (which just costs an extra provider call).
- The infrastructure cost was high relative to the payoff: Redis Stack vector search, an embedding model/API dependency, per-entry TTL tuning, per-feature similarity thresholds, plus the Volatile-Content Filter as a safety net — all to support a probabilistic optimization that isn't required for any of the three core problems this gateway solves (§1). Fragility is handled by rate limiting + circuit breaker + fallback; cost blindness by Postgres logging; cost inefficiency by the Complexity Router — none of which depend on caching.
- If caching is revisited later, prefer **exact-match caching** (hash of normalized prompt + `feature_id` + `model_tier` as a plain Redis key with TTL) over semantic similarity — deterministic, no parametric-prompt risk, no embedding/vector-index dependency.

The rest of §12's original open decisions were resolved and folded into §6.2, §6.4, and §11 above: rate-limiter tiers/values, circuit breaker N/W/T, and flat (unweighted) rate-limit token cost.

**2026-08-13 — HTTP framework settled as Express (5.x).** This draft originally listed "Fastify (or Express)" as interchangeable. Settled on Express for developer familiarity — none of the gateway's actual complexity (rate limiter, circuit breaker, router, fallback orchestrator) is framework-dependent, and the gateway is I/O-bound on slow provider calls, so Fastify's routing-layer performance edge isn't the bottleneck here. Must be Express 5.x, not 4.x — 5.x auto-catches rejected promises in async route handlers, avoiding 4.x's classic manual try/catch requirement. Tradeoff accepted: unlike Fastify, Express has no built-in per-request child logger or schema validation, so both are wired manually (see the project's `CLAUDE.md`).
