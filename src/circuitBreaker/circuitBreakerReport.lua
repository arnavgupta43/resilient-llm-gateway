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
  -- A half-open outcome always transitions somewhere: success proves
  -- recovery (close), failure means it isn't recovered yet (reopen) --
  -- neither case is counted against the ordinary failure threshold, one
  -- probe result is decisive either way.
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
  -- Treat any non-half_open state (closed, fresh/missing, or a stray
  -- already-open report -- see lld.md §5 "Decision 1") the same way: a
  -- success always closes it, a failure counts toward the threshold.
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
