import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { DependencyUnavailableException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { AI_TAG } from '../../helpers/tags.js'

/**
 * Fault-injection tier: a real Redis failure AT the reserve write.
 *
 * The resilience-tier unit spec (resilience_quota_reserve_fail_closed) proves the
 * policy — reserve is fail-closed by construction — with a stubbed outage. This
 * complements it against the booted app and REAL Redis: the reserve EVAL is made
 * to reject with a realistic connection error (mid-operation, after the limit
 * lookup), and we assert two things a unit test cannot: (1) the real
 * ResilienceService classifies it and rethrows DependencyUnavailableException
 * (a 503, never an unheld reservation), and (2) the REAL Redis is left with zero
 * holds for the tenant — the failed reserve leaked nothing. A recovery case then
 * proves the tenant reserves/settles/releases cleanly once Redis is healthy,
 * with no residue from the failed attempt.
 *
 * Injection follows the fault-tier stance: through the `protected requireRedis()`
 * seam on a subclass, so no shared singleton is mutated. requireRedis returns a
 * client whose `eval` rejects (the reserve write) while every other Redis access
 * — including this spec's own state assertions — uses the healthy singleton.
 */
function fakeTenant(id: string): TenantModelContract {
  return { id, name: `q-${id}` } as unknown as TenantModelContract
}

const QUOTA = 'aiTokens'
const day = () => DateTime.utc().toFormat('yyyy-MM-dd')
const tHolds = (tid: string) => `quota:${tid}:${day()}:${QUOTA}:holds`

/** A QuotaService whose reserve EVAL fails as if Redis dropped mid-write. */
class EvalOutageQuotaService extends QuotaService {
  protected async requireRedis(): Promise<any> {
    const err = new Error('read ECONNRESET')
    ;(err as any).code = 'ECONNRESET'
    return {
      eval: async () => {
        throw err
      },
    }
  }
}

test.group('QuotaService.reserve under a Redis outage (fault injection, real Redis)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))

  let realSvc: QuotaService
  let tenantId: string
  let tenant: TenantModelContract
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    realSvc = await app.container.make(QuotaService)
    tenantId = randomUUID()
    tenant = fakeTenant(tenantId)
    originalConfig = getConfig()
    setConfig({
      ...originalConfig,
      plans: { defaultPlan: 'p', definitions: { p: { limits: { [QUOTA]: 1000 } } } },
    } as never)
  })

  group.each.teardown(async () => {
    await realSvc.reset(tenant).catch(() => {})
    setConfig(originalConfig)
  })

  test('a Redis failure at the reserve write fails closed and leaks no hold', async ({
    assert,
  }) => {
    const outaged = new EvalOutageQuotaService()
    await assert.rejects(() => outaged.reserve(tenant, QUOTA, 100), DependencyUnavailableException)
    // Fail-closed committed nothing: the real store has no hold for the tenant.
    assert.equal(await redis.zcard(tHolds(tenantId)), 0, 'the refused reserve left no hold behind')
    assert.equal(await realSvc.getUsage(tenant, QUOTA), 0, 'no usage was committed')
  })

  test('the tenant reserves cleanly once Redis is healthy, with no residue', async ({ assert }) => {
    // Same tenant, now against the real (healthy) service resolved from the app.
    const r = await realSvc.reserve(tenant, QUOTA, 100)
    assert.isNotEmpty(r.id, 'the healthy reserve places a hold')
    assert.equal(
      await redis.zcard(tHolds(tenantId)),
      1,
      'exactly one hold, no leftover from the outage'
    )
    await realSvc.settle(r, 40)
    assert.equal(await realSvc.getUsage(tenant, QUOTA), 40, 'settle charges the real usage')
    assert.equal(await realSvc.release(r), 60, 'release frees the remainder')
    assert.equal(await redis.zcard(tHolds(tenantId)), 0, 'the hold is gone after release')
  })
})
