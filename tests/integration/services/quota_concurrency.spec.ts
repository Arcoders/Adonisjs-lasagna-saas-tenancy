import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { QuotaExceededException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

function fakeTenant(id: string): TenantModelContract {
  return { id, name: `q-${id}` } as unknown as TenantModelContract
}

/**
 * S0-5: this test exercises the documented "near-atomic" caveat in
 * QuotaService.consume(). It runs N parallel callers against a small
 * limit and reports the actual fulfilled count.
 *
 * Outcome interpretation:
 *   - fulfilled <= limit  →  consume() is effectively atomic; docs may
 *                            keep the "near-atomic" wording.
 *   - fulfilled  >  limit →  drift is observable. Either rewrite
 *                            consume() in Lua (atomic INCR-and-check)
 *                            or strengthen the docs to call out the
 *                            exact over-shoot bound.
 */
test.group('QuotaService.consume — concurrency (integration)', (group) => {
  const planName = 's0_5_test_plan'
  const quotaName = 'apiRequests'
  const limit = 10
  const parallelism = 50

  let svc: QuotaService
  let tenantId: string
  let tenant: TenantModelContract
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    svc = await app.container.make(QuotaService)
    tenantId = randomUUID()
    tenant = fakeTenant(tenantId)

    originalConfig = getConfig()
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: planName,
        definitions: { [planName]: { limits: { [quotaName]: limit } } },
      },
    })
  })

  group.each.teardown(async () => {
    await svc.reset(tenant).catch(() => {})
    // Restore the original config so we don't leak `plans` into other specs.
    setConfig(originalConfig)
  })

  test('consume() rejects beyond the configured limit under N parallel callers', async ({
    assert,
  }) => {
    const results = await Promise.allSettled(
      Array.from({ length: parallelism }, () => svc.consume(tenant, quotaName))
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length
    const rejected = results.filter((r) => r.status === 'rejected')
    const quotaExceeded = rejected.filter(
      (r) => (r as PromiseRejectedResult).reason instanceof QuotaExceededException
    ).length
    const otherErrors = rejected.length - quotaExceeded

    // Every rejection MUST be a QuotaExceededException — anything else is
    // an unrelated bug (Redis dropped, dispatch threw, etc.).
    assert.equal(
      otherErrors,
      0,
      `consume() raised ${otherErrors} non-quota errors (sample: ${
        otherErrors > 0
          ? (rejected.find(
              (r) => !((r as PromiseRejectedResult).reason instanceof QuotaExceededException)
            ) as PromiseRejectedResult | undefined)?.reason
          : 'n/a'
      })`
    )

    // The hard bound: under no scenario should we OVER-grant the quota.
    // If this assertion fails, the documented "near-atomic" caveat has
    // graduated into a real correctness problem and consume() needs a
    // Lua-backed atomic INCRBY-and-check.
    assert.isAtMost(
      fulfilled,
      limit,
      `Quota over-shoot: ${fulfilled}/${limit} requests succeeded under ${parallelism}-way concurrency. ` +
        `This means QuotaService.consume() is NOT atomic — rewrite with Redis Lua, or update the docs to call out the exact over-shoot bound.`
    )

    // And we must have actually saturated — otherwise the test isn't
    // proving anything. With parallelism (50) > limit (10) we expect
    // significant rejections.
    assert.isAtLeast(
      quotaExceeded,
      parallelism - limit,
      `Expected at least ${parallelism - limit} rejections, got ${quotaExceeded}. ` +
        `Either parallelism is too low or the limit isn't being enforced.`
    )
  })

  test('consume() is exact when called serially (no race window)', async ({ assert }) => {
    let fulfilled = 0
    let rejected = 0
    for (let i = 0; i < parallelism; i++) {
      try {
        await svc.consume(tenant, quotaName)
        fulfilled++
      } catch (err) {
        if (err instanceof QuotaExceededException) {
          rejected++
        } else {
          throw err
        }
      }
    }
    assert.equal(fulfilled, limit, 'serial path must hit the limit exactly')
    assert.equal(rejected, parallelism - limit)
  })

  test('reset() clears the rolling counter so the limit refreshes', async ({ assert }) => {
    for (let i = 0; i < limit; i++) await svc.consume(tenant, quotaName)
    await assert.rejects(() => svc.consume(tenant, quotaName), QuotaExceededException)

    await svc.reset(tenant, quotaName)

    // After reset we should be able to consume the full limit again.
    for (let i = 0; i < limit; i++) await svc.consume(tenant, quotaName)
    await assert.rejects(() => svc.consume(tenant, quotaName), QuotaExceededException)
  })
})
