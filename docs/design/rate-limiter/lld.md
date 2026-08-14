# LLD: Redis Token-Bucket Rate Limiter

**Status:** Finalized
**Depends on:** [`hld.md`](./hld.md)

## 1. Module layout

```
src/
  auth/
    hashApiKey.ts          # SHA-256 hashing helper
    apiKeysRepo.ts          # api_keys table access
  rateLimiter/
    config.ts               # RateLimitTier type + tier -> (C, R) table
    redisClient.ts          # ioredis singleton (mirrors db/client.ts)
    tokenBucket.lua         # the atomic script
    tokenBucket.ts           # loads the script, exposes checkAndConsume()
  middleware/
    authMiddleware.ts        # NEW - resolves API key -> tier
    rateLimiterMiddleware.ts # NEW - enforces the bucket
    requestContext.ts        # MODIFIED - no longer touches the raw key
  errors/index.ts             # + AuthenticationError, RateLimitExceededError, RateLimiterUnavailableError
  db/
    types.ts                # NEW - Queryable, extracted out of requestsRepo.ts
    migrations/002_create_api_keys_table.sql
    seed.ts
```

Repository pattern: `ApiKeysRepo` mirrors the existing `RequestsRepo` shape — a narrow interface plus a `createXRepo(db)` factory returning an object literal. Business logic depends on the interface, never on `pg` directly, so tests can hand it a fake. Same idea as the `AnthropicMessagesClient` "port" interface for the Anthropic SDK.

## 2. Middleware split

```
requestContextMiddleware -> authMiddleware -> rateLimiterMiddleware -> express.json() -> routes
```

Two middlewares, not one, because they're two different responsibilities: `authMiddleware` resolves *who* is calling (raw key -> hash -> DB lookup -> internal id + tier, or 401); `rateLimiterMiddleware` enforces *how often* they may call, given that resolved identity (bucket check, or 429/503). Each is independently unit-testable against a fake of just its own dependency (`ApiKeysRepo` vs. `TokenBucket`). Express middleware is a chain-of-responsibility: each link calls `next()` or throws.

## 3. Correctness fix: raw keys must never reach logs

Today `requestContextMiddleware` puts the **raw** `x-api-key` header value into the ALS context as `apiKeyId`, and `getLogger()` binds `apiKeyId` onto every log line — so the actual secret has been going into structured logs. This PR fixes that: `requestContextMiddleware` stops touching the key entirely; only `authMiddleware`, *after* hashing-and-verifying it, writes the **resolved internal id** (`api_keys.id`, a UUID) into the context.

```ts
// requestContext.ts
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = req.header(CORRELATION_HEADER) ?? randomUUID();
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithRequestContext({ correlationId }, () => next());
}
```

```ts
// authMiddleware.ts
export function createAuthMiddleware(apiKeysRepo: ApiKeysRepo) {
  return async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
    const rawKey = req.header("x-api-key");
    if (!rawKey) throw new AuthenticationError("Missing x-api-key header");

    const record = await apiKeysRepo.findByKeyHash(hashApiKey(rawKey));
    if (!record) throw new AuthenticationError("Invalid API key");

    const context = getRequestContext();
    if (context) {
      context.apiKeyId = record.id;
      context.rateLimitTier = record.tier;
    }
    next();
  };
}
```

No `try/catch` — Express 5 auto-catches rejected promises from async handlers (`CLAUDE.md`). `completions.ts`'s existing `try/catch` only exists to translate `ZodError` into `ValidationError`; that's a special case, not the default pattern.

`RequestContext` gains one field:
```ts
export interface RequestContext {
  correlationId: string;
  apiKeyId?: string;
  featureId?: string;
  rateLimitTier?: RateLimitTier;   // NEW
}
```

## 4. The Lua script

```lua
-- tokenBucket.lua
-- KEYS[1] = bucket key ("ratelimit:{api_key_id}")
-- ARGV[1] = capacity, ARGV[2] = refill_per_second, ARGV[3] = ttl_seconds
local bucket_key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local ttl_seconds = tonumber(ARGV[3])

-- redis.call('TIME') is Redis's own clock, frozen for the duration of this
-- script. Using it (not a timestamp passed from Node) keeps every gateway
-- instance refilling against the same clock, avoiding drift between hosts.
local time = redis.call('TIME')
local now_ms = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local bucket = redis.call('HMGET', bucket_key, 'tokens', 'last_refill_ms')
local tokens = tonumber(bucket[1])
local last_refill_ms = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  last_refill_ms = now_ms
end

local elapsed_ms = math.max(0, now_ms - last_refill_ms)
tokens = math.min(capacity, tokens + (elapsed_ms / 1000) * refill_rate)

local allowed = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
end

redis.call('HMSET', bucket_key, 'tokens', tokens, 'last_refill_ms', now_ms)
redis.call('EXPIRE', bucket_key, ttl_seconds)

return { allowed, tostring(tokens) }
```

TypeScript side, via `ioredis`'s `defineCommand` (registers the script once; call sites get a plain method instead of hand-writing `EVAL` + the script string each time):

```ts
// tokenBucket.ts
export interface TokenBucketResult {
  allowed: boolean;
  tokensRemaining: number;
}

interface RedisWithTokenBucket extends Redis {
  tokenBucketCheck(key: string, capacity: number, refillRate: number, ttlSeconds: number): Promise<[number, string]>;
}

export interface TokenBucket {
  checkAndConsume(bucketKey: string, capacity: number, refillPerSecond: number, ttlSeconds: number): Promise<TokenBucketResult>;
}

export function createTokenBucket(redis: Redis): TokenBucket {
  const lua = readFileSync(path.join(__dirname, "tokenBucket.lua"), "utf8");
  redis.defineCommand("tokenBucketCheck", { numberOfKeys: 1, lua });

  return {
    async checkAndConsume(bucketKey, capacity, refillPerSecond, ttlSeconds) {
      const [allowed, tokensRemaining] = await (redis as RedisWithTokenBucket).tokenBucketCheck(
        bucketKey, capacity, refillPerSecond, ttlSeconds,
      );
      return { allowed: allowed === 1, tokensRemaining: Number(tokensRemaining) };
    },
  };
}
```

`defineCommand` attaches the method at runtime, so TypeScript doesn't know it exists on `Redis` — `RedisWithTokenBucket` describes just that one added method, keeping the cast contained to this file.

TTL: `ttlSeconds = Math.ceil(capacity / refillPerSecond) + 60` (time-to-full plus a minute of buffer).

## 5. `rateLimiterMiddleware.ts`

```ts
export function createRateLimiterMiddleware(tokenBucket: TokenBucket) {
  return async function rateLimiterMiddleware(_req: Request, _res: Response, next: NextFunction) {
    const context = getRequestContext();
    const tier = context?.rateLimitTier as RateLimitTier;
    const apiKeyId = context?.apiKeyId as string;
    const config = RATE_LIMIT_TIERS[tier];
    const ttlSeconds = Math.ceil(config.capacity / config.refillPerSecond) + 60;

    let result: TokenBucketResult;
    try {
      result = await tokenBucket.checkAndConsume(`ratelimit:${apiKeyId}`, config.capacity, config.refillPerSecond, ttlSeconds);
    } catch (err) {
      throw new RateLimiterUnavailableError("Rate limiter unavailable", { cause: err });
    }

    if (!result.allowed) {
      getLogger().warn({ apiKeyId, tier }, "rate limit exceeded");
      throw new RateLimitExceededError("Rate limit exceeded");
    }

    next();
  };
}
```

The `try/catch` here is the deliberate exception to "just throw" — it converts an `ioredis` connection failure into our own typed `RateLimiterUnavailableError` rather than letting an unrecognized error fall through to a generic 500, preserving `cause`.

## 6. New error classes

```ts
export class AuthenticationError extends GatewayError {
  readonly httpStatus = 401;
  readonly isOperational = true;
}
export class RateLimitExceededError extends GatewayError {
  readonly httpStatus = 429;
  readonly isOperational = true;
}
export class RateLimiterUnavailableError extends GatewayError {
  readonly httpStatus = 503;
  readonly isOperational = true;
}
```

## 7. `api_keys` table + repo

```sql
-- 002_create_api_keys_table.sql
CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash    TEXT NOT NULL UNIQUE,
    tier        TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'enterprise')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
No separate index on `key_hash` — `UNIQUE` already creates one.

```ts
export interface ApiKeyRecord { id: string; tier: RateLimitTier }
export interface ApiKeysRepo { findByKeyHash(keyHash: string): Promise<ApiKeyRecord | null> }

export function createApiKeysRepo(db: Queryable): ApiKeysRepo {
  return {
    async findByKeyHash(keyHash) {
      const { rows } = await db.query<{ id: string; tier: string }>(
        "SELECT id, tier FROM api_keys WHERE key_hash = $1", [keyHash],
      );
      return rows[0] ? { id: rows[0].id, tier: rows[0].tier as RateLimitTier } : null;
    },
  };
}
```

`Queryable` is extracted from `requestsRepo.ts` into `src/db/types.ts` and shared by both repos, instead of duplicating the same three-line interface.

## 8. Testing the Lua script (resolved)

`CLAUDE.md` draws a line between mock-free unit tests and real-service e2e tests, but the token bucket's logic *is* the Lua script — there's no meaningful way to exercise it without Redis's actual Lua interpreter, so mocking Redis here would just be testing our own mock. Resolution: `tests/unit/rateLimiter/tokenBucket.test.ts` tests the script in isolation (capacity boundaries, refill math, TTL — nothing about HTTP/Express) against the real local Redis from docker-compose, flushing the test key before each case. It's a unit test in scope, not in purity — a deliberate, documented exception to the general mock-free-unit-tests rule, not an oversight.

## 9. Test/dev seeding

`src/db/seed.ts` (same shape as `migrate.ts`) inserts fixed keys — `dev-free-key` / `dev-pro-key` / `dev-enterprise-key`, hashed, one per tier, `ON CONFLICT (key_hash) DO NOTHING`. New `npm run seed` script. E2E setup calls it before the suite runs.

`tests/e2e/completions.e2e.test.ts` currently sends `x-api-key: e2e-key` and asserts `requests.api_key_id === "e2e-key"` directly — updated as part of this PR to seed a real key and assert against the resolved UUID instead, since the raw-header-as-id behavior it checks today is exactly what's being replaced.

## 10. `docker-compose.yml` additions

```yaml
redis:
  image: redis:7-alpine
  restart: unless-stopped
  ports: ["6379:6379"]

redis_test:
  image: redis:7-alpine
  restart: unless-stopped
  ports: ["6380:6379"]
```
Plus `REDIS_URL` added to `env.ts`'s schema, `.env.example`, and `.env.test`.
