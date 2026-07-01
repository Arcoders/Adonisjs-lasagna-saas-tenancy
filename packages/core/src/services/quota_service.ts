import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import type { TenantModelContract } from '../types/contracts.js'
import type { PlanDefinition, PlansConfig } from '../types/config.js'
import QuotaExceededException from '../exceptions/quota_exceeded_exception.js'
import TenantQuotaExceeded from '../events/tenant_quota_exceeded.js'
import { cacheFor } from '../utils/cache.js'
import ResilienceService from './resilience_service.js'
import TelemetryService from './telemetry_service.js'
import { OBS_SPAN, OBS_EVENT, OBS_ATTR, RESERVE_OUTCOME } from './observability/names.js'
import {
  ROLLING_TTL_SECONDS,
  QUOTA_CONSUME_LUA,
  QUOTA_RESERVE_LUA,
  QUOTA_SETTLE_LUA,
  QUOTA_RELEASE_LUA,
  DEFAULT_RESERVATION_TTL_MS,
  RESERVATION_CONTAINER_TTL_MS,
  rollingKey,
  snapshotKey,
  tenantKeyPattern,
  committedKey,
  holdsKey,
  amtKey,
  opCommittedKey,
  opHoldsKey,
  opAmtKey,
  periodToday,
} from './quota/keys.js'
import { resolveStorageMode } from './quota/plan_storage.js'

// The storage probe moved to ./quota/plan_storage.js; re-export its test reset
// so the billing integration spec (imports it by deep path) and the package
// barrels keep resolving it.
export { __resetPlanStorageProbe } from './quota/plan_storage.js'

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

/** Stateless, so a single shared instance is fine. */
const resilience = new ResilienceService()

const lazyTenantPlan = () => import('../models/satellites/tenant_plan.js').then((m) => m.default)

const PLAN_CACHE_TTL_MS = 60_000
const PLAN_CACHE_KEY = 'plan'

/**
 * String-literal union naming the two ways QuotaService meters a tenant quota.
 * `'rolling-day'` is an auto-incrementing counter scoped to a fixed UTC
 * calendar day that resets at midnight (driven by `track` and `consume`), while
 * `'snapshot'` is an externally reported absolute value with no expiry that the
 * host sets via `setUsage`, suited to gauges like seats or stored megabytes.
 */
export type QuotaMode = 'rolling-day' | 'snapshot'

/**
 * Plain result object returned by `QuotaService.check()` describing whether a tenant
 * may consume a given amount of a quota without actually incrementing any counter or
 * throwing. It reports `allowed` (true when the current usage plus the attempted amount
 * stays within the plan limit), the `current` usage read from Redis, the plan `limit`,
 * and the `attempted` amount that was evaluated.
 */
export interface QuotaCheckResult {
  allowed: boolean
  current: number
  limit: number
  attempted: number
}

/**
 * Immutable view of a tenant's quota state returned by `QuotaService.snapshot()`.
 * It carries the resolved plan name, the limit ceilings declared for that plan,
 * and the current consumption recorded for each of those limits, keyed by quota
 * name. Intended to back a tenant-facing usage endpoint that reports remaining
 * allowance.
 *
 * @property plan - Name of the plan currently applied to the tenant.
 * @property limits - Declared ceiling for each quota in the plan, keyed by quota name.
 * @property usage - Current consumption for each declared quota, keyed by quota name.
 */
export interface QuotaStateSnapshot {
  plan: string
  limits: Record<string, number>
  usage: Record<string, number>
}

/**
 * Opaque handle returned by {@link QuotaService.reserve} and passed back to
 * {@link QuotaService.settle} / {@link QuotaService.release}. It carries
 * everything those calls need to address the hold without re-resolving the plan:
 * the hold `id`, the `tenantId` and `quota` it belongs to, the reserve-time
 * `day` (so a stream crossing 00:00 UTC settles the same bucket it reserved
 * against), the held `worstCase`, the reservation `ttl` in milliseconds, and
 * whether an operator ceiling was `op` in play. A handle whose `id` is the empty
 * string is an inert no-op, returned when neither a per-tenant limit nor an
 * operator ceiling applies to the quota (nothing to enforce); `settle` and
 * `release` on it do nothing.
 */
export interface QuotaReservation {
  readonly id: string
  readonly tenantId: string
  readonly quota: string
  readonly day: string
  readonly worstCase: number
  readonly ttl: number
  readonly op: boolean
}

const DEFAULT_FALLBACK: PlansConfig = {
  defaultPlan: '__default__',
  definitions: { __default__: { limits: {} } },
}

/**
 * Enforces per-tenant usage quotas defined by the tenant's billing plan, backed by Redis counters.
 * Resolves the active plan via host callback, a persisted `tenant_plans` row, or the configured
 * default, and exposes that mapping through `getPlanFor`, `assignPlan`, `getAssignedPlan`, and
 * `clearAssignedPlan`. Tracks consumption with two modes: a fixed UTC calendar-day rolling counter
 * (`track`, `consume`) and externally reported snapshot values (`setUsage`) for things like seats or
 * storage. `consume` performs an atomic Lua check-and-increment that throws `QuotaExceededException`
 * when a limit would be exceeded, while `check` reports allowance without mutating state. Reads honor
 * a configured resilience policy so a Redis outage degrades per policy rather than hard-failing, and
 * `snapshot`/`reset` expose and clear current usage.
 */
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
   * Increment the per-day counter (default mode). The key is dated by the UTC
   * calendar day (`#periodToday`), so it is a fixed daily bucket that resets at
   * 00:00 UTC, not a sliding 24h window — a tenant can spend the limit on each
   * side of midnight UTC. The 48h TTL only garbage-collects the previous day's
   * key. Use this for per-day allowances like API calls per day.
   */
  async track(tenant: TenantModelContract, quota: string, amount: number = 1): Promise<number> {
    const key = rollingKey(tenant.id, quota)
    const policy = getConfig().resilience?.redis?.quota ?? 'fail-open'
    const counted = await resilience.run<number | null>({
      dependency: 'redis',
      operation: 'quota.track',
      policy,
      tenantId: tenant.id,
      fallback: () => null,
      run: async () => {
        const redis = await this.requireRedis()
        // INCRBY + EXPIRE in one pipeline so a crash between them can't leave a
        // TTL-less counter key lingering. (Bounded anyway — the key is
        // date-scoped — but a clean atomic pair costs nothing.)
        const results = (await redis
          .pipeline()
          .incrby(key, amount)
          .expire(key, ROLLING_TTL_SECONDS)
          .exec()) as [[Error | null, number], [Error | null, unknown]] | null
        // ioredis types exec() as nullable (aborted pipelines); destructuring
        // null would throw an opaque TypeError instead of a classified
        // dependency failure.
        if (!results) throw new Error('quota.track: redis pipeline returned no results')
        const [[incrErr, next], [expireErr]] = results
        if (incrErr) throw incrErr
        // Surface an EXPIRE-only failure too: the increment stuck but the key
        // has no TTL — silent acceptance would leave a counter that never
        // resets while reporting success.
        if (expireErr) throw expireErr
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
    await redis.set(snapshotKey(tenant.id, quota), String(Math.max(0, Math.floor(value))))
  }

  /**
   * Read the current usage. Tries the rolling-day counter first; falls back
   * to the snapshot if no rolling counter exists.
   */
  async getUsage(tenant: TenantModelContract, quota: string): Promise<number> {
    const redis = await lazyRedis()
    if (!redis) return 0
    const rolling = await redis.get(rollingKey(tenant.id, quota))
    if (rolling !== null) return Number(rolling) || 0
    const snapshot = await redis.get(snapshotKey(tenant.id, quota))
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
   *   - The counter is a fixed UTC calendar-day bucket (the key is dated
   *     `YYYY-MM-DD`), not a sliding 24h window: it resets at 00:00 UTC, so a
   *     tenant can consume up to the limit on each side of midnight UTC.
   *   - Snapshot quotas (`setUsage`) are independent of this counter
   *     and are NOT included in the atomic check. If your quota is
   *     reported externally (seats, storage), enforce it where you
   *     write the value rather than via `consume`.
   *   - When `getLimit` returns `Infinity` (no limit declared in the
   *     plan) the script is skipped and we fall back to a plain
   *     non-atomic `track`, matching the "unlimited" semantics.
   *   - `consume` reads only the committed counter; it is blind to any
   *     outstanding `reserve` holds on the same quota. Meter a quota by
   *     `consume` XOR `reserve`, never both, or the two double-count.
   */
  async consume(tenant: TenantModelContract, quota: string, amount: number = 1): Promise<number> {
    const limit = await this.getLimit(tenant, quota)
    if (!Number.isFinite(limit)) {
      // Unlimited plan — just track and return.
      return await this.track(tenant, quota, amount)
    }

    const key = rollingKey(tenant.id, quota)
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
   * Reserve a worst-case amount of a quota BEFORE an operation whose true cost is
   * only known when it finishes (a streaming model response is the motivating
   * case). The hold is committed atomically against BOTH the per-tenant daily
   * budget AND the operator-global ceiling (`config.plans.operatorCeiling[quota]`,
   * a tenant-independent denial-of-wallet cap); both must fit or nothing is held.
   * Over-budget is a hard stop: it dispatches `TenantQuotaExceeded` and throws
   * `QuotaExceededException`, having committed nothing.
   *
   * Reconcile the actual usage with {@link settle} as it becomes known, and
   * return the remainder with {@link release} in a `finally`. The hold is a Redis
   * key scored by its absolute expiry, so a process that crashes between reserve
   * and settle/release has its budget reclaimed automatically when the TTL
   * elapses — there is no reaper process and no scalar counter that could leak.
   *
   * FAIL-CLOSED BY CONSTRUCTION. Unlike {@link consume} (which honours
   * `resilience.redis.quota`, defaulting fail-open to favour availability), a
   * reservation gates an expensive provider call: if Redis is unreachable we
   * cannot prove the budget, so we refuse with a 503
   * (`DependencyUnavailableException`) rather than let the cost race through
   * unheld. This is deliberately NOT configurable — a fail-open reservation would
   * reintroduce the very cost-race the seam closes.
   *
   * When neither a per-tenant limit nor an operator ceiling applies to the quota,
   * there is nothing to enforce and an inert no-op handle is returned (no Redis
   * round-trip), mirroring `consume`'s unlimited-plan path.
   *
   * IMPORTANT: a quota name must be metered by exactly ONE mechanism, either
   * `consume`/`track` (discrete counts) or `reserve`/`settle`/`release` (held
   * cost). `reserve` sees `consume`'s committed counter, but `consume`/`check`/
   * `getUsage` read only that counter and are blind to outstanding reservations,
   * so metering the same quota through both double-counts. Use distinct quota
   * names for the two.
   */
  async reserve(
    tenant: TenantModelContract,
    quota: string,
    worstCase: number
  ): Promise<QuotaReservation> {
    // Once-per-stream: a full span. Wraps the whole body so the fail-closed throw
    // (DependencyUnavailableException) and the refusal (QuotaExceededException)
    // are both captured, with an `outcome` attribute disambiguating them.
    return TelemetryService.withSpan(
      OBS_SPAN.quotaReserve,
      { [OBS_ATTR.tenantId]: tenant.id, [OBS_ATTR.quota]: quota },
      async (span) => {
        const worst = Math.floor(worstCase)
        if (!(worst > 0)) {
          throw new Error(
            `QuotaService.reserve: worstCase must be a positive integer, got ${worstCase}`
          )
        }
        span.setAttribute(OBS_ATTR.worstCase, worst)

        const tLimit = await this.getLimit(tenant, quota)
        const oLimit = getConfig().plans?.operatorCeiling?.[quota] ?? Number.POSITIVE_INFINITY
        const tenantEnforced = Number.isFinite(tLimit)
        const opEnforced = Number.isFinite(oLimit)

        // Nothing to enforce: no per-tenant limit and no operator ceiling. Mirrors
        // consume()'s "unlimited plan" path — return an inert handle, touch no Redis.
        if (!tenantEnforced && !opEnforced) {
          span.setAttribute(OBS_ATTR.outcome, RESERVE_OUTCOME.ok)
          return {
            id: '',
            tenantId: tenant.id,
            quota,
            day: '',
            worstCase: worst,
            ttl: 0,
            op: false,
          }
        }

        const day = periodToday()
        const id = randomUUID()
        const now = Date.now()
        const resTtl = getConfig().plans?.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS

        const result = await resilience.run<[number, number, number, string?]>({
          dependency: 'redis',
          operation: 'quota.reserve',
          policy: 'fail-closed',
          tenantId: tenant.id,
          // fail-closed never invokes the fallback (ResilienceService rethrows the
          // outage as DependencyUnavailableException); present to satisfy the type.
          fallback: () => {
            throw new Error('quota.reserve: fail-closed fallback must not be invoked')
          },
          run: async () =>
            (await (
              await this.requireRedis()
            ).eval(
              QUOTA_RESERVE_LUA,
              6,
              committedKey(tenant.id, day, quota),
              holdsKey(tenant.id, day, quota),
              amtKey(tenant.id, day, quota),
              opCommittedKey(day, quota),
              opHoldsKey(day, quota),
              opAmtKey(day, quota),
              String(tenantEnforced ? tLimit : -1),
              String(opEnforced ? oLimit : -1),
              String(worst),
              id,
              String(now),
              String(resTtl),
              String(RESERVATION_CONTAINER_TTL_MS)
            )) as [number, number, number, string?],
        })

        const [ok, tEff, oEff, scope] = result
        if (ok === -1) {
          // Duplicate hold id: cryptographically impossible from randomUUID, so this
          // means a caller replayed a handle. Refuse rather than double-hold.
          throw new Error('QuotaService.reserve: duplicate reservation id')
        }
        if (ok === 0) {
          const overCeiling = scope === 'g'
          const limit = overCeiling ? oLimit : tLimit
          const current = overCeiling ? oEff : tEff
          TelemetryService.addEvent(span, OBS_EVENT.refused, { [OBS_ATTR.scope]: scope ?? 't' })
          span.setAttribute(
            OBS_ATTR.outcome,
            overCeiling ? RESERVE_OUTCOME.ceiling : RESERVE_OUTCOME.overBudget
          )
          await TenantQuotaExceeded.dispatch(tenant, quota, limit, current, worst)
          throw new QuotaExceededException({
            tenantId: tenant.id,
            quota,
            limit,
            current,
            attempted: worst,
          })
        }

        TelemetryService.addEvent(span, OBS_EVENT.holdPlaced, {
          [OBS_ATTR.effectiveTenant]: tEff,
          [OBS_ATTR.effectiveCeiling]: oEff,
        })
        span.setAttribute(OBS_ATTR.outcome, RESERVE_OUTCOME.ok)
        return {
          id,
          tenantId: tenant.id,
          quota,
          day,
          worstCase: worst,
          ttl: resTtl,
          op: opEnforced,
        }
      }
    )
  }

  /**
   * Reconcile the actual usage of a {@link reserve} hold. `cumulativeUsed` is the
   * TOTAL used so far for the reservation (it only grows across a stream); the
   * service commits the forward delta since the previous settle and clamps the
   * total to `[0, worstCase]`, so a misreporting provider can never settle past
   * the hold and a repeated or smaller total is a no-op. A live hold's expiry is
   * refreshed (bounded, never accumulating) so a progressing stream is not
   * reaped mid-flight.
   *
   * Best-effort (fail-open): the budget guarantee is the up-front `reserve` hold,
   * and the hold's TTL reclaims anything a missed settle leaves behind, so a
   * transient Redis blip must never break the streaming `finally`. A hold already
   * reclaimed by TTL (a crashed then resumed stream) settles nothing — a crashed
   * stream is never over-charged.
   *
   * Safe against a forged/tampered handle by construction: every key below is
   * built from the handle's own (tenantId, day, quota) via the `*Key` builders,
   * and the hold is a member named by `reservation.id`. A handle whose tenantId
   * (or quota/day/id) was swapped addresses a different namespace, so the hold is
   * not found and the Lua settles nothing — no cross-tenant charge is possible.
   * `check-quota-key-tenant-scoped.mjs` + `security_quota_handle_tamper.spec.ts`
   * pin this so a refactor cannot regress it.
   */
  async settle(reservation: QuotaReservation, cumulativeUsed: number): Promise<void> {
    if (!reservation.id) return

    const requested = Number.isFinite(cumulativeUsed) ? Math.max(0, Math.floor(cumulativeUsed)) : 0
    const res = await resilience.run<unknown>({
      dependency: 'redis',
      operation: 'quota.settle',
      policy: 'fail-open',
      tenantId: reservation.tenantId,
      fallback: () => null,
      run: async () =>
        (await this.requireRedis()).eval(
          QUOTA_SETTLE_LUA,
          6,
          committedKey(reservation.tenantId, reservation.day, reservation.quota),
          holdsKey(reservation.tenantId, reservation.day, reservation.quota),
          amtKey(reservation.tenantId, reservation.day, reservation.quota),
          opCommittedKey(reservation.day, reservation.quota),
          opHoldsKey(reservation.day, reservation.quota),
          opAmtKey(reservation.day, reservation.quota),
          // Coerce defensively: a non-finite total would stringify to "NaN",
          // which Lua's tonumber rejects, aborting the EVAL. Under fail-open that
          // would be swallowed as a phantom Redis outage and silently drop the
          // charge (a cost dodge). Treat garbage as 0 used.
          String(requested),
          String(Date.now()),
          String(reservation.ttl),
          String(ROLLING_TTL_SECONDS),
          reservation.op ? '1' : '0',
          reservation.id
        ),
    })

    // Per-fragment: hot. Record the committed delta as an EVENT on whatever span
    // is active (the caller's stream span, or none) — never a span per fragment,
    // which would explode trace volume. `res` is [delta, newSettled, worst], or
    // null when a fail-open Redis blip swallowed the settle.
    if (Array.isArray(res)) {
      const worst = Number(res[2])
      TelemetryService.addEventOnActive(OBS_EVENT.settle, {
        [OBS_ATTR.delta]: Number(res[0]) || 0,
        [OBS_ATTR.clamped]: Number.isFinite(worst) && requested > worst,
      })
    }
  }

  /**
   * Return the unused remainder of a {@link reserve} hold (`worstCase` minus what
   * was settled) and drop the hold. Idempotent: a second call frees `0`, so the
   * streaming seam's `finally` is safe under a double abort (a client disconnect
   * and a timeout both firing). Best-effort (fail-open) for the same reason as
   * {@link settle}. Returns the amount freed.
   */
  async release(reservation: QuotaReservation): Promise<number> {
    if (!reservation.id) return 0

    // Once-per-stream (the streaming `finally`): a full span carrying the freed
    // remainder.
    return TelemetryService.withSpan(
      OBS_SPAN.quotaRelease,
      { [OBS_ATTR.tenantId]: reservation.tenantId, [OBS_ATTR.quota]: reservation.quota },
      async (span) => {
        const freed = await resilience.run<number>({
          dependency: 'redis',
          operation: 'quota.release',
          policy: 'fail-open',
          tenantId: reservation.tenantId,
          fallback: () => 0,
          run: async () => {
            const arr = (await (
              await this.requireRedis()
            ).eval(
              QUOTA_RELEASE_LUA,
              4,
              holdsKey(reservation.tenantId, reservation.day, reservation.quota),
              amtKey(reservation.tenantId, reservation.day, reservation.quota),
              opHoldsKey(reservation.day, reservation.quota),
              opAmtKey(reservation.day, reservation.quota),
              reservation.id,
              reservation.op ? '1' : '0'
            )) as [number]
            return Number(arr?.[0]) || 0
          },
        })
        TelemetryService.addEvent(span, OBS_EVENT.release, { [OBS_ATTR.freed]: freed })
        return freed
      }
    )
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
      await redis.del(rollingKey(tenant.id, quota))
      await redis.del(snapshotKey(tenant.id, quota))
      return
    }
    // wildcard cleanup for the tenant
    const pattern = tenantKeyPattern(tenant.id)
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
}
