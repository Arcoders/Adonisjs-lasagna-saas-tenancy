import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { collectSnapshot, renderPrometheus } from '@adonisjs-lasagna/saas-tenancy/health'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { AI_TAG } from '../../../helpers/tags.js'

/**
 * Observability for the operator-ceiling gauges: they render on the Prometheus scrape,
 * derived at collect time from live Redis. This drives a real reserve against a
 * configured ceiling, then renders the snapshot the /metrics endpoint serves and
 * asserts the three gauges appear with correct values and are labelled by `quota`
 * only, NEVER `tenant_id` (the cardinality rule, enforced at runtime here).
 */
function fakeTenant(id: string): TenantModelContract {
  return { id, name: `q-${id}` } as unknown as TenantModelContract
}

const QUOTA = 'aiTokens'
const day = () => DateTime.utc().toFormat('yyyy-MM-dd')
const opCommitted = () => `quota:op:${day()}:${QUOTA}`
const opHolds = () => `quota:op:${day()}:${QUOTA}:holds`
const opAmt = () => `quota:op:${day()}:${QUOTA}:amt`

/** The `multitenancy_quota_ceiling_*` lines from a rendered scrape. */
function ceilingLines(scrape: string): string[] {
  return scrape.split('\n').filter((l) => l.startsWith('multitenancy_quota_ceiling_'))
}

test.group('operator ceiling gauges on the /metrics scrape (integration, real Redis)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))

  let svc: QuotaService
  let tenant: TenantModelContract
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    svc = await app.container.make(QuotaService)
    tenant = fakeTenant(randomUUID())
    originalConfig = getConfig()
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'p',
        definitions: { p: { limits: { [QUOTA]: 1_000_000 } } },
        operatorCeiling: { [QUOTA]: 1000 },
      },
    } as never)
  })

  group.each.teardown(async () => {
    await svc.reset(tenant).catch(() => {})
    await redis.del(opCommitted(), opHolds(), opAmt()).catch(() => {})
    setConfig(originalConfig)
  })

  test('a live reservation surfaces committed/outstanding/utilization labelled by quota only', async ({
    assert,
  }) => {
    // Reserve 200 of a 1000 ceiling: outstanding=200, committed=0, utilization=0.2.
    await svc.reserve(tenant, QUOTA, 200)

    const snapshot = await collectSnapshot({ includeTenants: false, includeQueues: false })
    const scrape = renderPrometheus(snapshot)
    const lines = ceilingLines(scrape)

    assert.isNotEmpty(lines, 'the ceiling gauges render when an operator ceiling is configured')
    assert.include(
      lines,
      `multitenancy_quota_ceiling_outstanding{quota="${QUOTA}"} 200`,
      'outstanding reflects the live hold remainder'
    )
    assert.include(
      lines,
      `multitenancy_quota_ceiling_committed{quota="${QUOTA}"} 0`,
      'committed is zero before any settle'
    )
    assert.include(
      lines,
      `multitenancy_quota_ceiling_utilization_ratio{quota="${QUOTA}"} 0.2`,
      'utilization is (committed+outstanding)/ceiling'
    )

    // The cardinality rule: operator gauges carry `quota`, never `tenant_id`.
    for (const line of lines) {
      assert.notInclude(
        line,
        'tenant_id',
        'operator ceiling gauges must not be labelled by tenant_id'
      )
    }
  })
})
