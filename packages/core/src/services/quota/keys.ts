import { DateTime } from 'luxon'

/**
 * Pure Redis key builders + the atomic consume script for {@link QuotaService}.
 * Extracted so the key formats (which `reset()` depends on via a wildcard
 * `SCAN quota:<id>:*` and which the consume/getUsage round-trip must agree on)
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
 * Returns `{allowed, value}`: `allowed=1` means incremented and `value` is the new
 * total; `allowed=0` means it would exceed and `value` is the unchanged
 * pre-increment counter.
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

/**
 * Committed/settled counter for an explicit UTC day. `settle` reuses the
 * reservation's reserve-time day so a stream that crosses 00:00 UTC keeps
 * charging the same bucket it reserved against, rather than splitting across the
 * midnight boundary. `rollingKey` is this with today's date.
 */
export function committedKey(tenantId: string, day: string, quota: string): string {
  return `quota:${tenantId}:${day}:${quota}`
}

/** Date-scoped rolling counter key: `quota:<tenantId>:<yyyy-MM-dd>:<quota>`. */
export function rollingKey(tenantId: string, quota: string): string {
  return committedKey(tenantId, periodToday(), quota)
}

/** Snapshot watermark key (no TTL): `quota:<tenantId>:snap:<quota>`. */
export function snapshotKey(tenantId: string, quota: string): string {
  return `quota:${tenantId}:snap:${quota}`
}

/**
 * Wildcard matching every quota key owned by one tenant (rolling counters,
 * snapshots, reservation holds, amounts). `reset()` SCANs this to drop a tenant's
 * state. Tenant-scoped by construction: it embeds `tenantId`, so it can never
 * match the shared `quota:op:*` operator-ceiling keys.
 */
export function tenantKeyPattern(tenantId: string): string {
  return `quota:${tenantId}:*`
}

// ---------------------------------------------------------------------------
// Reservation holds (reserve/settle/release): the AI-streaming cost seam.
//
// A reservation HOLDS a worst-case amount against the budget BEFORE a streaming
// provider call, then settles the actual usage as it arrives and releases the
// remainder at the end. The accounting is "derive, never store": there is NO
// scalar reserved-counter. Each live hold is a member of a per-(tenant,day,quota)
// sorted set scored by its ABSOLUTE expiry (`now + reservationTtl`), with its
// `worst:settled` amounts in a companion hash. The outstanding reserved amount
// is recomputed from the live members on every reserve, and each reserve first
// evicts members whose score has passed. That eviction IS the reaper: an orphan
// left by a crashed process drops out of the sum the moment its expiry passes,
// with no timer, no scheduler, and no counter left inflated. Redis is the only
// reaper. Keys keep the `quota:<tenantId>:` prefix so `QuotaService.reset()`'s
// wildcard cleans them, and the operator-global keys live under `quota:op:` so a
// per-tenant reset never touches the shared ceiling.
//
// Cluster note: this ships for standalone/Sentinel Redis (the package default),
// where every key is one slot so the both-or-neither reserve is a single atomic
// EVAL. Redis Cluster (per-tenant keys and the un-tagged operator keys hash to
// different slots) needs hash-tagging plus a second EVAL for the ceiling; that
// is a deferred follow-up, not silently broken here.
// ---------------------------------------------------------------------------

/**
 * Default worst-case lifetime (ms) of a single reservation hold before Redis
 * expiry reclaims an orphan left by a crashed process. A live stream refreshes
 * its hold on every `settle`, so this only bounds a CRASHED stream's stranded
 * budget. Override with `config.plans.reservationTtlMs`.
 */
export const DEFAULT_RESERVATION_TTL_MS = 120_000

/** 48h GC backstop (ms) for the holds sorted set / amount hash of a fully idle tenant. */
export const RESERVATION_CONTAINER_TTL_MS = ROLLING_TTL_SECONDS * 1000

/** Live-holds sorted set for a tenant/day/quota: member = holdId, score = absolute expiry ms. */
export function holdsKey(tenantId: string, day: string, quota: string): string {
  return `${committedKey(tenantId, day, quota)}:holds`
}

/** Per-hold amount hash for a tenant/day/quota: field = holdId, value = `"<worst>:<settled>"`. */
export function amtKey(tenantId: string, day: string, quota: string): string {
  return `${committedKey(tenantId, day, quota)}:amt`
}

/** Operator-global committed counter (tenant-independent ceiling): `quota:op:<day>:<quota>`. */
export function opCommittedKey(day: string, quota: string): string {
  return `quota:op:${day}:${quota}`
}

/** Operator-global live-holds sorted set. */
export function opHoldsKey(day: string, quota: string): string {
  return `${opCommittedKey(day, quota)}:holds`
}

/** Operator-global per-hold amount hash. */
export function opAmtKey(day: string, quota: string): string {
  return `${opCommittedKey(day, quota)}:amt`
}

/**
 * Atomic reserve. HOLDS `worstCase` against BOTH the per-tenant daily budget AND
 * the operator-global ceiling (both-or-neither): if either would be exceeded,
 * nothing is committed. Reaps expired holds first, then derives the outstanding
 * reserved amount from the live members, so no scalar counter can leak.
 *
 *   KEYS[1] tenant committed   KEYS[2] tenant holds   KEYS[3] tenant amt
 *   KEYS[4] op committed       KEYS[5] op holds       KEYS[6] op amt
 *   ARGV[1] tenant limit (-1 = unlimited)   ARGV[2] op limit (-1 = disabled)
 *   ARGV[3] worstCase (>0)   ARGV[4] holdId   ARGV[5] now(ms)
 *   ARGV[6] reservationTtl(ms)   ARGV[7] containerTtl(ms)
 *   -> {1, tEff, oEff} placed | {0, tEff, oEff, 't'|'g'} refused | {-1} duplicate id
 */
export const QUOTA_RESERVE_LUA = `
local tLimit = tonumber(ARGV[1])
local oLimit = tonumber(ARGV[2])
local worst  = tonumber(ARGV[3])
local holdId = ARGV[4]
local now    = tonumber(ARGV[5])
local resTtl = tonumber(ARGV[6])
local ctTtl  = tonumber(ARGV[7])

if redis.call('ZSCORE', KEYS[2], holdId) then return {-1} end

local function reapAndSum(holdsK, amtK)
  -- Exclusive boundary: a member whose score EQUALS now is still live this
  -- instant (its ttl has not strictly elapsed), so only score < now is reaped.
  -- This keeps a degenerate reservationTtl of 0 from self-reaping into an
  -- over-grant.
  local dead = redis.call('ZRANGEBYSCORE', holdsK, '-inf', '(' .. now)
  if #dead > 0 then
    redis.call('ZREMRANGEBYSCORE', holdsK, '-inf', '(' .. now)
    local i = 1
    while i <= #dead do
      local j = math.min(i + 499, #dead)
      redis.call('HDEL', amtK, unpack(dead, i, j))
      i = j + 1
    end
  end
  local sum = 0
  local live = redis.call('ZRANGE', holdsK, 0, -1)
  for k = 1, #live do
    local rec = redis.call('HGET', amtK, live[k])
    if rec then
      local sep = string.find(rec, ':', 1, true)
      if sep then
        sum = sum + (tonumber(string.sub(rec, 1, sep - 1)) - tonumber(string.sub(rec, sep + 1)))
      end
    end
  end
  return sum
end

local tEff = tonumber(redis.call('GET', KEYS[1]) or '0') + reapAndSum(KEYS[2], KEYS[3])
local oEff = 0
if oLimit >= 0 then
  oEff = tonumber(redis.call('GET', KEYS[4]) or '0') + reapAndSum(KEYS[5], KEYS[6])
end

if tLimit >= 0 and (tEff + worst) > tLimit then return {0, tEff, oEff, 't'} end
if oLimit >= 0 and (oEff + worst) > oLimit then return {0, tEff, oEff, 'g'} end

local score = now + resTtl
local rec = worst .. ':0'
redis.call('ZADD', KEYS[2], score, holdId)
redis.call('HSET', KEYS[3], holdId, rec)
redis.call('PEXPIRE', KEYS[2], ctTtl)
redis.call('PEXPIRE', KEYS[3], ctTtl)
if oLimit >= 0 then
  redis.call('ZADD', KEYS[5], score, holdId)
  redis.call('HSET', KEYS[6], holdId, rec)
  redis.call('PEXPIRE', KEYS[5], ctTtl)
  redis.call('PEXPIRE', KEYS[6], ctTtl)
end
return {1, tEff + worst, oEff + worst}
`.trim()

/**
 * Monotonic-cumulative settle. The caller passes TOTAL used-so-far for a hold;
 * the delta since the prior settle is committed and the value is clamped to
 * [0, worst], so a misreporting provider can never over-settle past the hold.
 * A repeated or smaller total is a no-op. A live hold refreshes its expiry
 * (bounded to now + reservationTtl, never accumulating). A hold already reaped
 * by TTL returns {-1}: a benign no-op, since a crashed stream is never charged.
 *
 *   KEYS[1] tenant committed   KEYS[2] tenant holds   KEYS[3] tenant amt
 *   KEYS[4] op committed       KEYS[5] op holds       KEYS[6] op amt
 *   ARGV[1] cumulativeUsed   ARGV[2] now(ms)   ARGV[3] reservationTtl(ms)
 *   ARGV[4] committedTtl(sec)   ARGV[5] opEnabled(1|0)   ARGV[6] holdId
 *   -> {delta, newSettled, worst} | {-1, 0, 0} if the hold is gone
 */
export const QUOTA_SETTLE_LUA = `
local used   = tonumber(ARGV[1]) or 0
local now    = tonumber(ARGV[2])
local resTtl = tonumber(ARGV[3])
local ttlSec = tonumber(ARGV[4])
local opOn   = tonumber(ARGV[5])
local holdId = ARGV[6]

local rec = redis.call('HGET', KEYS[3], holdId)
if not rec then return {-1, 0, 0} end
local sep = string.find(rec, ':', 1, true)
if not sep then return {-1, 0, 0} end
local worst = tonumber(string.sub(rec, 1, sep - 1))
local prev  = tonumber(string.sub(rec, sep + 1))

if used < 0 then used = 0 end
if used > worst then used = worst end

-- Gate the operator side on ITS OWN live member. The op holds/amt are shared
-- across tenants, so another tenant's reserve can reap this hold's op member
-- (once its score passes) while this tenant's own amt still survives; charging
-- the shared op counter then would inflate the ceiling permanently.
local opLive = opOn == 1 and redis.call('ZSCORE', KEYS[5], holdId)

local score = now + resTtl
if used <= prev then
  redis.call('ZADD', KEYS[2], 'XX', score, holdId)
  if opLive then redis.call('ZADD', KEYS[5], 'XX', score, holdId) end
  return {0, prev, worst}
end

local delta = used - prev
local newRec = worst .. ':' .. used
redis.call('INCRBY', KEYS[1], delta)
redis.call('EXPIRE', KEYS[1], ttlSec)
redis.call('HSET', KEYS[3], holdId, newRec)
redis.call('ZADD', KEYS[2], 'XX', score, holdId)
if opLive then
  redis.call('INCRBY', KEYS[4], delta)
  redis.call('EXPIRE', KEYS[4], ttlSec)
  redis.call('HSET', KEYS[6], holdId, newRec)
  redis.call('ZADD', KEYS[5], 'XX', score, holdId)
end
return {delta, used, worst}
`.trim()

/**
 * Idempotent release. Drops the hold from both structures, freeing the unused
 * remainder (worst - settled). A second call finds no member and frees 0, so the
 * streaming seam's finally is safe under a double abort (disconnect AND timeout).
 *
 *   KEYS[1] tenant holds   KEYS[2] tenant amt
 *   KEYS[3] op holds       KEYS[4] op amt
 *   ARGV[1] holdId   ARGV[2] opEnabled(1|0)
 *   -> {freed}
 */
export const QUOTA_RELEASE_LUA = `
local holdId = ARGV[1]
local opOn = tonumber(ARGV[2])
local rec = redis.call('HGET', KEYS[2], holdId)
local freed = 0
if rec then
  local sep = string.find(rec, ':', 1, true)
  if sep then
    freed = tonumber(string.sub(rec, 1, sep - 1)) - tonumber(string.sub(rec, sep + 1))
    if freed < 0 then freed = 0 end
  end
  redis.call('ZREM', KEYS[1], holdId)
  redis.call('HDEL', KEYS[2], holdId)
end
-- The operator hold gets its own guard, OUTSIDE the tenant 'if rec' block: after
-- reset(tenant) DELs the tenant keys mid-stream the tenant rec is gone, but the
-- shared op hold must still be released so it stops consuming the ceiling.
if opOn == 1 and redis.call('HGET', KEYS[4], holdId) then
  redis.call('ZREM', KEYS[3], holdId)
  redis.call('HDEL', KEYS[4], holdId)
end
return {freed}
`.trim()
