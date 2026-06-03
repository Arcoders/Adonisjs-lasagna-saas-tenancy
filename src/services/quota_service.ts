import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import type { TenantModelContract } from '../types/contracts.js'
import type { PlanDefinition, PlansConfig } from '../types/config.js'
import QuotaExceededException from '../exceptions/quota_exceeded_exception.js'
import TenantQuotaExceeded from '../events/tenant_quota_exceeded.js'
import { cacheFor } from '../utils/cache.js'
import ResilienceService from './resilience_service.js'

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

/** Stateless, so a single shared instance is fine. */
const resilience = new ResilienceService()

const lazyTenantPlan = () => import('../models/satellites/tenant_plan.js').then((m) => m.default)

const ROLLING_TTL_SECONDS = 60 * 60 * 48
const PLAN_CACHE_TTL_MS = 60_000
const PLAN_CACHE_KEY = 'plan'

type PlanStorageMode = 'config-only' | 'tenant_plans'

let _storageProbe: PlanStorageMode | null = null

/**
 * Decide once per process whether the storage-backed plan resolver is
 * available. With `storage: 'tenant_plans'` we trust the operator and fail
 * loudly on first read if the table is missing. With `storage: 'auto'`
 * (or omitted) we probe `to_regclass`; result is memoised so we don't pay
 * the round-trip on every getPlanFor.
 *
 * Tests that need to flip the answer should call `__resetStorageProbe()`.
 */
async function resolveStorageMode(): Promise<PlanStorageMode> {
  if (_storageProbe) return _storageProbe

  const cfg = getConfig().plans
  const declared = cfg?.storage

  if (declared === 'config-only') {
    _storageProbe = 'config-only'
    return _storageProbe
  }
  if (declared === 'tenant_plans') {
    _storageProbe = 'tenant_plans'
    return _storageProbe
  }

  // 'auto' (or undefined) — probe the table.
  try {
    const TenantPlan = await lazyTenantPlan()
    const conn = TenantPlan.$adapter
    if (!conn) {
      _storageProbe = 'config-only'
      return _storageProbe
    }
    // We can't query through Lucid before the adapter is wired in tests, so
    // go straight to the underlying connection by name.
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const result = await db
      .connection(getConfig().backofficeConnectionName)
      .rawQuery(`SELECT to_regclass(?) AS reg`, [
        `${getConfig().backofficeSchemaName}.tenant_plans`,
      ])
    const rows = (result?.rows ?? result) as Array<{ reg: string | null }>
    _storageProbe = rows[0]?.reg ? 'tenant_plans' : 'config-only'
  } catch {
    _storageProbe = 'config-only'
  }
  return _storageProbe
}

/** @internal — for tests only */
export function __resetPlanStorageProbe(): void {
  _storageProbe = null
}

/**
 * Atomic check-and-increment for `consume()`. Single round-trip to
 * Redis. Returns `{allowed, value}`:
 *   - `allowed=1` → counter was incremented; `value` is the new total.
 *   - `allowed=0` → would exceed limit; `value` is the unchanged
 *     pre-increment counter (i.e. what `getUsage` would have returned).
 *
 * KEYS[1] = rolling counter key
 * ARGV[1] = limit (integer; caller guarantees finite)
 * ARGV[2] = amount to increment by
 * ARGV[3] = TTL seconds
 */
const QUOTA_CONSUME_LUA = `
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

export type QuotaMode = 'rolling-day' | 'snapshot'

export interface QuotaCheckResult {
  allowed: boolean
  current: number
  limit: number
  attempted: number
}

export interface QuotaStateSnapshot {
  plan: string
  limits: Record<string, number>
  usage: Record<string, number>
}

const DEFAULT_FALLBACK: PlansConfig = {
  defaultPlan: '__default__',
  definitions: { __default__: { limits: {} } },
}

export default class QuotaService {
  /**
   * Resolve the Redis client, throwing when `@adonisjs/redis` isn't
   * installed/registered so the call routes through `ResilienceService` and
   * degrades per the configured policy. `protected` so tests can override it
   * to simulate a Redis outage (mirrors `RateLimitMiddleware.getRedis`).
   */
  protected async requireRedis(): Promise<NonNullable<Awaited<ReturnType<typeof lazyRedis>>>> {
    const redis = await lazyRedis()
    if (!redis) throw new Error('@adonisjs/redis is not installed or not registered')
    return redis
  }

  /**
   * Returns the plan name + definition currently applied to a tenant.
   *
   * Resolution order:
   *   1. `config.plans.getPlan(tenant)` if defined — host callback wins.
   *   2. Storage-backed `tenant_plans` row when `config.plans.storage` is
   *      `'tenant_plans'` (or `'auto'` and the table exists). Cached 60s in
   *      BentoCache; cross-process invalidation runs through the redis bus
   *      so an `assignPlan` on one node is visible everywhere within the
   *      next request.
   *   3. `defaultPlan`.
   *
   * Throws if the resolved name is not declared in `definitions`.
   */
  async getPlanFor(tenant: TenantModelContract): Promise<{ name: string; plan: PlanDefinition }> {
    const cfg = getConfig().plans ?? DEFAULT_FALLBACK

    let resolved = await cfg.getPlan?.(tenant)
    if (!resolved) {
      const stored = await this.getAssignedPlan(tenant.id)
      resolved = stored ?? cfg.defaultPlan
    }

    const plan = cfg.definitions[resolved]
    if (!plan) {
      throw new Error(
        `QuotaService: plan "${resolved}" is not declared in config.plans.definitions`
      )
    }
    return { name: resolved, plan }
  }

  /**
   * Persist a tenant→plan mapping. Source-of-truth for billing-driven plan
   * changes; the Stripe webhook job calls this after `syncSubscription`.
   *
   * Idempotent: re-assigning the same plan is a no-op (no cache churn). A
   * different plan upserts and invalidates the cache so the next read sees
   * the new plan immediately.
   *
   * Validates that `planName` exists in `config.plans.definitions` — guards
   * against a Stripe product that drifted out of config.
   */
  async assignPlan(
    tenantId: string,
    planName: string,
    opts?: { source?: string; expiresAt?: DateTime }
  ): Promise<void> {
    const cfg = getConfig().plans
    if (cfg && !cfg.definitions[planName]) {
      throw new Error(
        `QuotaService.assignPlan: plan "${planName}" is not declared in config.plans.definitions`
      )
    }

    const TenantPlan = await lazyTenantPlan()
    const existing = await TenantPlan.find(tenantId)
    const desiredSource = opts?.source ?? 'manual'
    const desiredExpires = opts?.expiresAt ?? null

    if (
      existing &&
      existing.planName === planName &&
      existing.source === desiredSource &&
      ((existing.expiresAt === null && desiredExpires === null) ||
        existing.expiresAt?.equals(desiredExpires as DateTime))
    ) {
      // No-op: same row, skip the write and the cache bust.
      return
    }

    if (existing) {
      existing.planName = planName
      existing.source = desiredSource
      existing.expiresAt = desiredExpires
      existing.assignedAt = DateTime.utc()
      await existing.save()
    } else {
      await TenantPlan.create({
        tenantId,
        planName,
        source: desiredSource,
        expiresAt: desiredExpires,
        assignedAt: DateTime.utc(),
      })
    }

    await cacheFor(tenantId).delete({ key: PLAN_CACHE_KEY })
  }

  /**
   * Reads the persisted plan name for a tenant, honouring `expires_at`
   * (an expired row is treated as missing — caller falls back to
   * `defaultPlan`). Returns `null` when storage is disabled or the row
   * doesn't exist.
   *
   * Caches 60s in BentoCache. Cross-node invalidation arrives via the redis
   * bus on `assignPlan`/`clearAssignedPlan`.
   */
  async getAssignedPlan(tenantId: string): Promise<string | null> {
    const mode = await resolveStorageMode()
    if (mode === 'config-only') return null

    const result = await cacheFor(tenantId).getOrSet({
      key: PLAN_CACHE_KEY,
      factory: async () => {
        const TenantPlan = await lazyTenantPlan()
        const row = await TenantPlan.find(tenantId)
        if (!row) return { plan: null }
        if (row.expiresAt && row.expiresAt < DateTime.utc()) return { plan: null }
        return { plan: row.planName }
      },
      ttl: PLAN_CACHE_TTL_MS,
    })
    return result?.plan ?? null
  }

  /** Remove a tenant's plan assignment. Subsequent reads fall back to `defaultPlan`. */
  async clearAssignedPlan(tenantId: string): Promise<void> {
    const TenantPlan = await lazyTenantPlan()
    await TenantPlan.query().where('tenantId', tenantId).delete()
    await cacheFor(tenantId).delete({ key: PLAN_CACHE_KEY })
  }

  /**
   * Numeric limit for a quota on the tenant's plan, or `Infinity` if the
   * plan does not declare it (treated as unlimited).
   */
  async getLimit(tenant: TenantModelContract, quota: string): Promise<number> {
    const { plan } = await this.getPlanFor(tenant)
    const value = plan.limits[quota]
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }

  /**
   * Increment a rolling-day counter (default mode). Use this for things
   * like API calls per day. Counter expires after 48h.
   */
  async track(tenant: TenantModelContract, quota: string, amount: number = 1): Promise<number> {
    const key = this.#rollingKey(tenant.id, quota)
    const policy = getConfig().resilience?.redis?.quota ?? 'fail-open'
    const counted = await resilience.run<number | null>({
      dependency: 'redis',
      operation: 'quota.track',
      policy,
      tenantId: tenant.id,
      fallback: () => null,
      run: async () => {
        const redis = await this.requireRedis()
        const next = await redis.incrby(key, amount)
        await redis.expire(key, ROLLING_TTL_SECONDS)
        return Number(next) || 0
      },
    })
    if (counted === null) return 0
    const total = counted
    if (getConfig().plans?.emitTracked) {
      const { default: QuotaTracked } = await import('../events/quota_tracked.js')
      await QuotaTracked.dispatch(tenant, quota, amount, total)
    }
    return total
  }

  /**
   * Set a snapshot value (e.g. seats, storageMb). Snapshot values are not
   * incremented automatically — the user reports them when they change.
   * Snapshots have no TTL.
   */
  async setUsage(tenant: TenantModelContract, quota: string, value: number): Promise<void> {
    const redis = await lazyRedis()
    if (!redis) return
    await redis.set(this.#snapshotKey(tenant.id, quota), String(Math.max(0, Math.floor(value))))
  }

  /**
   * Read the current usage. Tries the rolling-day counter first; falls back
   * to the snapshot if no rolling counter exists.
   */
  async getUsage(tenant: TenantModelContract, quota: string): Promise<number> {
    const redis = await lazyRedis()
    if (!redis) return 0
    const rolling = await redis.get(this.#rollingKey(tenant.id, quota))
    if (rolling !== null) return Number(rolling) || 0
    const snapshot = await redis.get(this.#snapshotKey(tenant.id, quota))
    return snapshot !== null ? Number(snapshot) || 0 : 0
  }

  /**
   * Pure check: is the tenant allowed to consume `amount` of `quota`?
   * Does not increment any counter, does not throw.
   */
  async check(
    tenant: TenantModelContract,
    quota: string,
    amount: number = 1
  ): Promise<QuotaCheckResult> {
    const limit = await this.getLimit(tenant, quota)
    const current = await this.getUsage(tenant, quota)
    return {
      allowed: current + amount <= limit,
      current,
      limit,
      attempted: amount,
    }
  }

  /**
   * Atomic check-and-increment on the rolling-day counter. Either the
   * counter is incremented in full and the new value is returned, or
   * the limit would be exceeded and `QuotaExceededException` is thrown
   * — never both, never partial.
   *
   * Atomicity is guaranteed by a single `EVAL` (Lua) round-trip to
   * Redis: GET, compare against the configured limit, then `INCRBY`
   * + `EXPIRE` only when the new total fits. Redis is single-threaded
   * for script execution, so concurrent callers serialize on the
   * server side — no over-grant under burst.
   *
   * Notes:
   *   - Snapshot quotas (`setUsage`) are independent of this counter
   *     and are NOT included in the atomic check. If your quota is
   *     reported externally (seats, storage), enforce it where you
   *     write the value rather than via `consume`.
   *   - When `getLimit` returns `Infinity` (no limit declared in the
   *     plan) the script is skipped and we fall back to a plain
   *     non-atomic `track`, matching the "unlimited" semantics.
   */
  async consume(tenant: TenantModelContract, quota: string, amount: number = 1): Promise<number> {
    const limit = await this.getLimit(tenant, quota)
    if (!Number.isFinite(limit)) {
      // Unlimited plan — just track and return.
      return await this.track(tenant, quota, amount)
    }

    const key = this.#rollingKey(tenant.id, quota)
    const policy = getConfig().resilience?.redis?.quota ?? 'fail-open'
    const result = await resilience.run<[number, number] | null>({
      dependency: 'redis',
      operation: 'quota.consume',
      policy,
      tenantId: tenant.id,
      // fail-open: Redis down → skip enforcement, allow the consumption.
      fallback: () => null,
      run: async () =>
        (await (
          await this.requireRedis()
        ).eval(
          QUOTA_CONSUME_LUA,
          1,
          key,
          String(limit),
          String(amount),
          String(ROLLING_TTL_SECONDS)
        )) as [number, number],
    })

    // fail-open path: Redis was unavailable and the policy chose availability
    // over enforcement (ResilienceService already logged + emitted
    // DependencyDegraded). Previously this was a silent `return 0`.
    if (result === null) return 0

    const [allowed, currentOrAfter] = Array.isArray(result) ? result : [0, 0]

    if (allowed === 0) {
      // Lua reported "would exceed". `currentOrAfter` is the pre-increment
      // value, which is what we surface in the event/exception payload.
      await TenantQuotaExceeded.dispatch(tenant, quota, limit, Number(currentOrAfter) || 0, amount)
      throw new QuotaExceededException({
        tenantId: tenant.id,
        quota,
        limit,
        current: Number(currentOrAfter) || 0,
        attempted: amount,
      })
    }
    const newTotal = Number(currentOrAfter) || 0
    if (getConfig().plans?.emitTracked) {
      const { default: QuotaTracked } = await import('../events/quota_tracked.js')
      await QuotaTracked.dispatch(tenant, quota, amount, newTotal)
    }
    return newTotal
  }

  /**
   * Returns plan + limits + current usage for every limit declared in the
   * tenant's plan. Useful for a tenant-facing /usage endpoint.
   */
  async snapshot(tenant: TenantModelContract): Promise<QuotaStateSnapshot> {
    const { name, plan } = await this.getPlanFor(tenant)
    const usage: Record<string, number> = {}
    for (const quota of Object.keys(plan.limits)) {
      usage[quota] = await this.getUsage(tenant, quota)
    }
    return { plan: name, limits: { ...plan.limits }, usage }
  }

  /**
   * Reset both rolling and snapshot keys for a tenant + quota. Useful on
   * plan change or admin reset.
   */
  async reset(tenant: TenantModelContract, quota?: string): Promise<void> {
    const redis = await lazyRedis()
    if (!redis) return
    if (quota) {
      await redis.del(this.#rollingKey(tenant.id, quota))
      await redis.del(this.#snapshotKey(tenant.id, quota))
      return
    }
    // wildcard cleanup for the tenant
    const pattern = `quota:${tenant.id}:*`
    const pending: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = (await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)) as [
        string,
        string[],
      ]
      pending.push(...batch)
      cursor = next
    } while (cursor !== '0')
    if (pending.length > 0) await redis.del(...pending)
  }

  #periodToday(): string {
    return DateTime.utc().toFormat('yyyy-MM-dd')
  }

  #rollingKey(tenantId: string, quota: string): string {
    return `quota:${tenantId}:${this.#periodToday()}:${quota}`
  }

  #snapshotKey(tenantId: string, quota: string): string {
    return `quota:${tenantId}:snap:${quota}`
  }
}
