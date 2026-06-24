import { DateTime } from 'luxon'

/**
 * Pure Redis key builders + the atomic consume script for {@link QuotaService}.
 * Extracted so the key formats — which `reset()` depends on via a wildcard
 * `SCAN quota:<id>:*` and which the consume/getUsage round-trip must agree on —
 * are directly unit-testable and can never silently drift.
 */

/** Rolling-day counter TTL: 48h, long enough for the previous UTC day's key to survive. */
export const ROLLING_TTL_SECONDS = 60 * 60 * 48

/**
 * Atomic check-and-increment for `consume()`. Single `EVAL` round-trip:
 *   KEYS[1] = rolling counter key
 *   ARGV[1] = limit (integer; caller guarantees finite)
 *   ARGV[2] = amount to increment by
 *   ARGV[3] = TTL seconds
 * Returns `{allowed, value}`: `allowed=1` → incremented, `value` is the new
 * total; `allowed=0` → would exceed, `value` is the unchanged pre-increment
 * counter.
 */
export const QUOTA_CONSUME_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit   = tonumber(ARGV[1])
local amount  = tonumber(ARGV[2])
local ttl     = tonumber(ARGV[3])
if current + amount > limit then
  return {0, current}
end
local newval = redis.call('INCRBY', KEYS[1], amount)
redis.call('EXPIRE', KEYS[1], ttl)
return {1, newval}
`.trim()

/** Today's UTC calendar date (`yyyy-MM-dd`); the rolling counter resets at 00:00 UTC. */
export function periodToday(): string {
  return DateTime.utc().toFormat('yyyy-MM-dd')
}

/** Date-scoped rolling counter key: `quota:<tenantId>:<yyyy-MM-dd>:<quota>`. */
export function rollingKey(tenantId: string, quota: string): string {
  return `quota:${tenantId}:${periodToday()}:${quota}`
}

/** Snapshot watermark key (no TTL): `quota:<tenantId>:snap:<quota>`. */
export function snapshotKey(tenantId: string, quota: string): string {
  return `quota:${tenantId}:snap:${quota}`
}
