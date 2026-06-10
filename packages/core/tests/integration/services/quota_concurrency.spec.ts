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
 * Proves the documented atomicity guarantee for QuotaService.consume():
 * the check-and-increment is a single Redis EVAL (Lua), so N parallel
 * callers against limit L produce EXACTLY L successes and N-L
 * QuotaExceededException — no race window, no under- or over-grant
 * (why.md "Quota atomicity", security.md "Atomic quota enforcement").
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
          ? (
              rejected.find(
                (r) => !((r as PromiseRejectedResult).reason instanceof QuotaExceededException)
              ) as PromiseRejectedResult | undefined
            )?.reason
          : 'n/a'
      })`
    )

    // Exactness, not a bound: the Lua script serializes concurrent callers
    // on the Redis server, so the only acceptable outcome is exactly
    // `limit` grants. Any other number (over OR under) means the atomic
    // guarantee the docs promise has regressed.
    assert.equal(
      fulfilled,
      limit,
      `Expected exactly ${limit} grants under ${parallelism}-way concurrency, got ${fulfilled}. ` +
        `QuotaService.consume()'s single-EVAL atomicity has regressed.`
    )

    assert.equal(
      quotaExceeded,
      parallelism - limit,
      `Expected exactly ${parallelism - limit} QuotaExceededException rejections, got ${quotaExceeded}.`
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
