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
