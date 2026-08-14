# HLD: Redis Token-Bucket Rate Limiter

**Status:** Finalized
**Build order:** step 2 (`architecture.md` §10)
**Related:** `architecture.md` §6.2 (Rate Limiter), §11 (config values), §2 (non-goals — usage quotas out of scope)

## 1. Goal

Reject requests over a per-API-key rate limit *before* they consume provider quota or gateway resources, using tiered limits (free/pro/enterprise).

## 2. Request lifecycle placement

Today: `requestContextMiddleware` (extracts raw `x-api-key` header, opens ALS context) → `express.json()` → `completions` route.

New:

```
requestContextMiddleware → rateLimiterMiddleware → express.json() → completions route
```

The rate limiter only needs the API key (already available via ALS after `requestContextMiddleware`), not the parsed body. Checking before `express.json()` means a rejected request never pays body-parsing cost.

## 3. Auth / tier resolution

There is currently no real authentication — `requestContextMiddleware` takes the raw `x-api-key` header value and uses it directly as `apiKeyId`. This PR replaces that with a real lookup, since the rate limiter needs a verified key's tier:

- New `api_keys` table: `id, key_hash, tier (free|pro|enterprise), created_at` (migration `002_create_api_keys_table.sql`, per `architecture.md` §8).
- **Keys are stored hashed, never in plaintext.** A fast cryptographic hash (SHA-256) is used, not a slow password hash (bcrypt/scrypt) — API keys are high-entropy random secrets, not human-chosen passwords, so bcrypt's deliberate slowness defends against a threat (guessing) that doesn't apply here, and would be costly to pay on every request.
- Flow per request: hash the incoming header value → look up `api_keys WHERE key_hash = <hash>` → found gives the row's `id` (used everywhere downstream as `apiKeyId`, e.g. `requests.api_key_id`, the Redis bucket key) and `tier`.
- **Key not found** (including header missing entirely) → reject **401** via a new `AuthenticationError` class (`isOperational: true`). This also replaces the existing "missing header → 400 `ValidationError`" behavior in `completions.ts` — both cases are "no valid credentials," not a malformed request body, so they get the same treatment.
- **Tier lookup is read-per-request** (a Postgres query, no in-process cache). Caching would need an invalidation strategy for no proven benefit yet — simplest thing that works; revisit only if the DB round-trip proves costly.

## 4. Redis token bucket

- **Key shape:** `ratelimit:{api_key_id}` → a Redis hash `{tokens, last_refill_ts}`.
- **Config:** tier → `(C, R)` hardcoded per `architecture.md` §11 — free (C=20, R=0.33/s), pro (C=60, R=1/s), enterprise (C=120, R=2/s). Flat cost of 1 bucket-token per request (not weighted by prompt size or LLM token count — see §7 below for why "token" means two different things here).
- **Redis client:** `ioredis` (not yet a dependency) — its `defineCommand` API registers a Lua script as a callable method, cleaner than raw `EVAL` string calls.

### 4.1 Lazy refill mechanism

There is no background process, cron job, or timer continuously topping up buckets — that would mean one running timer per API key, indefinitely, mostly doing nothing. Instead, refill is computed **on demand**, as pure math, at the moment each request arrives:

```
elapsed = now - last_refill_ts
tokens = min(C, tokens + elapsed * R)   # capped at capacity, never overflows
```

An idle bucket is just two inert numbers sitting in Redis between requests — nothing "happens" to it while no request arrives. The full per-request sequence, all inside one atomic Lua `EVAL`:

1. Read `{tokens, last_refill_ts}` for the key (treat a missing key as `{C, now}` — a new/never-seen key starts full).
2. Apply the lazy-refill formula above.
3. If `tokens >= 1`: deduct 1, write back `{tokens, now}`, refresh TTL (§4.2), **allow**.
4. Else: write back the refilled (but still <1) `tokens` and `now`, refresh TTL, **reject**.

### 4.2 Key expiry (TTL)

Bucket keys are **not** kept forever. Every touch refreshes a TTL of roughly `C / R` seconds (time to refill from empty to full, plus a small buffer) via the same Lua script (`PEXPIRE`, same `EVAL` — a separate round-trip would reintroduce the exact race the atomicity requirement exists to prevent).

This is safe because a token bucket caps at `C` and never exceeds it — an idle key's true value would sit at "full" indefinitely anyway. Letting Redis expire and reclaim idle keys causes zero behavioral difference (the next request just reinitializes at `C`, same as if the stale key had persisted), and avoids Redis memory growing forever as new/revoked keys accumulate permanent entries.

### 4.3 Atomicity

Check-refill-deduct-and-expire is one atomic Lua `EVAL` — never separate GET/SET round-trips, which would race across concurrent requests and across gateway instances (per CLAUDE.md conventions).

## 5. Failure mode: Redis unreachable

**Fail closed.** If the `EVAL` call itself errors (Redis down/unreachable), reject with **503** via a new `RateLimiterUnavailableError` (`isOperational: true` — an infra outage is an expected operational condition, not a programmer bug). Consistent with treating Redis as a required dependency, same as Postgres, and with the project's "no silent failures" stance — silently allowing all traffic through during a Redis outage would mean the rate limiter's guarantees quietly stop applying with no visible signal.

## 6. Event emission

`architecture.md` §7 specifies a `rate_limit.exceeded` event (severity `info`), but the Event Publisher / RabbitMQ don't exist until build order step 5. For this PR: **log at `warn`** with full ALS-derived context (correlation ID, `api_key_id`, tier) instead of publishing. When step 5 lands, that log call is replaced with a real `publish("rate_limit.exceeded", ..., "info")` call — no premature Event Publisher stub built now.

## 7. Terminology note: two different "tokens"

Redis token-bucket *tokens* (an abstract per-request cost unit, flat-rated at 1) are unrelated to *LLM tokens* (prompt/completion tokens returned by the provider and logged to `requests`). This rate limiter only throttles request rate — it has no concept of cumulative LLM-token spend. See `architecture.md` §2 non-goals for why usage-based (monthly/weekly LLM-token) quotas are explicitly out of scope.

## 8. Dev / test key seeding

No admin API exists yet to create API keys. A seed script (following the `src/db/migrate.ts` pattern, e.g. `src/db/seed.ts`) inserts a handful of fixed dev/test keys across tiers. Runnable standalone for local dev; e2e tests call it in setup.

## 9. New infra

A `redis` service is added to `docker-compose.yml`, mirroring the existing `postgres` / `postgres_test` pattern (likely `redis` + `redis_test`).

## 10. Testing (per CLAUDE.md)

- **Unit:** token bucket math (exact capacity boundary, exact refill instant, fractional accumulation, TTL calculation), auth/tier-lookup branching (found/not-found/missing header) — against a Lua-script test harness or fake Redis.
- **E2E:** real Redis via docker-compose, concurrent requests against the same key to confirm the Lua script is race-free across simultaneous callers.

## 11. Out of scope

Circuit breaker, fallback orchestrator, complexity router (later build-order steps). Any admin API for creating/rotating real API keys. Usage-based token quotas (`architecture.md` §2 non-goals).
