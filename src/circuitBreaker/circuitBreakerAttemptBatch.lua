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
