import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { QuotaExceededException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Real-Redis proof of the reserve/settle/release accounting. The model is
 * "derive, never store": no scalar reserved-counter exists, the outstanding
 * reserved amount is recomputed from the live members of a sorted set scored by
 * absolute expiry, and every reserve first evicts members whose score has passed
 * (that eviction IS the reaper). These specs pin the properties that only real
 * Redis can prove: single-EVAL atomicity, the both-or-neither operator ceiling,
 * the monotonic clamp, idempotent release, and orphan reclaim by TTL with no
 * leaked counter. The key format is asserted here on purpose (it is the contract
 * `reset()`'s wildcard depends on).
 */
function fakeTenant(id: string): TenantModelContract {
  return { id, name: `q-${id}` } as unknown as TenantModelContract
}

const QUOTA = 'aiTokens'
const day = () => DateTime.utc().toFormat('yyyy-MM-dd')
const tHolds = (tid: string) => `quota:${tid}:${day()}:${QUOTA}:holds`
const opCommitted = () => `quota:op:${day()}:${QUOTA}`
const opHolds = () => `quota:op:${day()}:${QUOTA}:holds`
const opAmt = () => `quota:op:${day()}:${QUOTA}:amt`

test.group('QuotaService.reserve/settle/release (integration, real Redis)', (group) => {
  let svc: QuotaService
  let tenantId: string
  let tenant: TenantModelContract
  let originalConfig: ReturnType<typeof getConfig>

  function configure(opts: { limit?: number; ceiling?: number; ttlMs?: number } = {}): void {
    const limits = opts.limit === undefined ? {} : { [QUOTA]: opts.limit }
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'p',
        definitions: { p: { limits } },
        ...(opts.ceiling !== undefined ? { operatorCeiling: { [QUOTA]: opts.ceiling } } : {}),
        ...(opts.ttlMs !== undefined ? { reservationTtlMs: opts.ttlMs } : {}),
      },
    } as never)
  }

  group.each.setup(async () => {
    svc = await app.container.make(QuotaService)
    tenantId = randomUUID()
    tenant = fakeTenant(tenantId)
    originalConfig = getConfig()
  })

  group.each.teardown(async () => {
    await svc.reset(tenant).catch(() => {})
    // Operator-global keys are not tenant-scoped, so reset() cannot clear them.
    await redis.del(opCommitted(), opHolds(), opAmt()).catch(() => {})
    setConfig(originalConfig)
  })

  test('two concurrent reserves where only one fits: exactly one is placed', async ({ assert }) => {
    configure({ limit: 100 })
    const results = await Promise.allSettled([
      svc.reserve(tenant, QUOTA, 60),
      svc.reserve(tenant, QUOTA, 60),
    ])
    const placed = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r) => r.status === 'rejected')
    assert.lengthOf(placed, 1, 'single-EVAL atomicity: exactly one hold committed')
    assert.lengthOf(refused, 1)
    assert.instanceOf((refused[0] as PromiseRejectedResult).reason, QuotaExceededException)
    assert.equal(await redis.zcard(tHolds(tenantId)), 1, 'only the winner left a member')
  })

  test('over-budget reserve is a hard stop and commits nothing', async ({ assert }) => {
    configure({ limit: 100 })
    await assert.rejects(() => svc.reserve(tenant, QUOTA, 200), QuotaExceededException)
    assert.equal(await redis.zcard(tHolds(tenantId)), 0, 'no hold committed')
    assert.equal(await svc.getUsage(tenant, QUOTA), 0, 'committed usage untouched')
  })

  test('operator ceiling refuses both-or-neither (tenant fits, ceiling does not)', async ({
    assert,
  }) => {
    configure({ limit: 1000, ceiling: 100 })
    await assert.rejects(() => svc.reserve(tenant, QUOTA, 150), QuotaExceededException)
    assert.equal(await redis.zcard(tHolds(tenantId)), 0, 'tenant hold not committed')
    assert.equal(await redis.zcard(opHolds()), 0, 'operator hold not committed')
  })

  test('operator ceiling refuses both-or-neither (ceiling fits, tenant does not)', async ({
    assert,
  }) => {
    configure({ limit: 50, ceiling: 100000 })
    await assert.rejects(() => svc.reserve(tenant, QUOTA, 80), QuotaExceededException)
    assert.equal(await redis.zcard(tHolds(tenantId)), 0, 'tenant hold not committed')
    assert.equal(await redis.zcard(opHolds()), 0, 'operator hold not committed')
  })

  test('settle is monotonic and clamps cumulative usage to [0, worstCase]', async ({ assert }) => {
    configure({ limit: 1000 })
    const r = await svc.reserve(tenant, QUOTA, 100)
    await svc.settle(r, 30)
    assert.equal(await svc.getUsage(tenant, QUOTA), 30)
    await svc.settle(r, 20) // smaller total => no-op
    assert.equal(await svc.getUsage(tenant, QUOTA), 30)
    await svc.settle(r, 120) // clamp to worstCase 100
    assert.equal(await svc.getUsage(tenant, QUOTA), 100)
    await svc.settle(r, 150) // already at worst => no-op
    assert.equal(await svc.getUsage(tenant, QUOTA), 100)
  })

  test('release returns the unused remainder and is idempotent under a double abort', async ({
    assert,
  }) => {
    configure({ limit: 1000 })
    const r = await svc.reserve(tenant, QUOTA, 100)
    await svc.settle(r, 30)
    assert.equal(await svc.release(r), 70, 'first release frees worst - settled')
    assert.equal(await svc.release(r), 0, 'second release frees nothing (idempotent)')
    assert.equal(await svc.getUsage(tenant, QUOTA), 30, 'settled usage stands')
    assert.equal(await redis.zcard(tHolds(tenantId)), 0, 'hold removed')
  })

  test('an orphaned hold is reclaimed by TTL with no leaked budget', async ({ assert }) => {
    configure({ limit: 100, ttlMs: 200 })
    // Reserve the whole budget, then simulate a crash: never settle or release.
    await svc.reserve(tenant, QUOTA, 100)
    // Immediately, the budget is fully held: a second reserve is refused.
    await assert.rejects(() => svc.reserve(tenant, QUOTA, 100), QuotaExceededException)
    // After the TTL elapses, the next reserve reaps the orphan and succeeds,
    // proving the capacity was reclaimed with no scalar counter left inflated.
    await new Promise((r) => setTimeout(r, 350))
    const r = await svc.reserve(tenant, QUOTA, 100)
    assert.isNotEmpty(r.id, 'capacity reclaimed after the orphan expired')
    assert.equal(await redis.zcard(tHolds(tenantId)), 1, 'only the fresh hold remains')
  })

  test('settle on an already-reaped hold neither charges nor resurrects it', async ({ assert }) => {
    configure({ limit: 1000, ttlMs: 150 })
    const r = await svc.reserve(tenant, QUOTA, 100)
    await new Promise((res) => setTimeout(res, 300)) // let the hold expire
    // A later reserve would reap it; force the reap by touching the same keys.
    await svc.reserve(tenant, QUOTA, 1)
    await svc.settle(r, 50) // the original hold is gone
    // The reaped hold contributes nothing; only the tiny live hold's settle (none) counts.
    assert.equal(await svc.getUsage(tenant, QUOTA), 0, 'a reaped hold is never charged')
    // settle returns early at the HGET-nil guard (the amt was reaped together
    // with the member), so the member is never recreated.
    assert.equal(
      await redis.zscore(tHolds(tenantId), r.id),
      null,
      'the reaped hold is not recreated'
    )
  })

  test('settle does not inflate the shared operator counter after another tenant reaps the op hold (C1)', async ({
    assert,
  }) => {
    configure({ limit: 1000, ceiling: 100000, ttlMs: 150 })
    // Tenant B (the group tenant) reserves against the SHARED operator ceiling.
    const rB = await svc.reserve(tenant, QUOTA, 100)
    // Its op hold expires...
    await new Promise((res) => setTimeout(res, 300))
    // ...then ANOTHER tenant's reserve reaps every expired member of the shared
    // op set, including B's, while B's own tenant hold (separate keys) survives.
    const tenantA = fakeTenant(randomUUID())
    await svc.reserve(tenantA, QUOTA, 1)
    // B settles: its tenant hold is charged, but the reaped op member must NOT be,
    // or the shared operator counter would be inflated permanently.
    await svc.settle(rB, 50)
    assert.equal(Number(await redis.get(opCommitted())) || 0, 0, 'operator counter not inflated')
    assert.equal(await svc.getUsage(tenant, QUOTA), 50, 'the tenant is still charged its usage')
    await svc.reset(tenantA).catch(() => {})
  })

  test('release clears the shared operator hold even after reset(tenant) mid-stream (C5)', async ({
    assert,
  }) => {
    configure({ limit: 1000, ceiling: 100000 })
    const r = await svc.reserve(tenant, QUOTA, 100)
    await svc.settle(r, 30)
    assert.equal(await redis.zcard(opHolds()), 1, 'operator hold placed')
    await svc.reset(tenant) // DELs quota:<tid>:* but never quota:op:*
    await svc.release(r)
    assert.equal(await redis.zcard(opHolds()), 0, 'release cleaned the operator hold too')
  })
})
