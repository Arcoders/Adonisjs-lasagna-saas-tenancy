import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import { TenantQuotaExceeded } from '@adonisjs-lasagna/saas-tenancy/events'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import QuotaExceededBillingListener from '../../../../src/listeners/quota_exceeded_billing_listener.js'
import { setupBillingConfig } from '../../../helpers/helpers.js'

/**
 * The quota-exceeded notification dedupe is advisory and must FAIL OPEN: a Redis
 * outage downgrades to "no dedupe" rather than throwing or dropping the warning.
 * These cases pin every branch of the dedupe gate (off / first / deduped /
 * Redis-error / no-Redis) using deterministic doubles — no real Redis, no mail
 * transport. Failure is injected through the `resolveRedis` seam (a subclass),
 * never by mutating the shared `@adonisjs/redis` singleton, so nothing leaks
 * into sibling specs that share this Ignitor.
 */

/** In-memory Redis double with real `SET ... NX` semantics (first write wins). */
class FakeRedis {
  #store = new Map<string, string>()
  async set(key: string, value: string, ...rest: unknown[]): Promise<'OK' | null> {
    if (rest.includes('NX') && this.#store.has(key)) return null
    this.#store.set(key, value)
    return 'OK'
  }
}

/**
 * Drives the listener through its dedupe gate without real Redis or a mailer:
 * `resolveRedis` injects the chosen double; `dispatchWarning` just counts. Each
 * test builds its OWN instance + FakeRedis, so there is no shared state.
 */
class SpyListener extends QuotaExceededBillingListener {
  dispatched = 0
  constructor(private redisImpl: FakeRedis | 'throw' | null) {
    super()
  }
  protected resolveRedis(): Promise<any> {
    if (this.redisImpl === 'throw') {
      return Promise.resolve({
        set: async () => {
          throw new Error('redis down (simulated outage)')
        },
      })
    }
    return Promise.resolve(this.redisImpl)
  }
  protected async dispatchWarning(): Promise<void> {
    this.dispatched++
  }
}

function quotaEvent(quota = 'apiRequests', tenantId = randomUUID()): TenantQuotaExceeded {
  return new TenantQuotaExceeded(
    { id: tenantId } as unknown as TenantModelContract,
    quota,
    100,
    101,
    1
  )
}

test.group('QuotaExceededBillingListener — advisory dedupe fails open (integration)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(() => {
    originalConfig = getConfig()
  })
  group.each.teardown(() => {
    setConfig(originalConfig)
  })

  test('does nothing when notifyOnQuotaExceeded is off', async ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter', notifyOnQuotaExceeded: false })
    const listener = new SpyListener(new FakeRedis())
    await listener.handle(quotaEvent())
    assert.equal(listener.dispatched, 0)
  })

  test('happy path: dedupes per (tenant, quota) within the TTL window', async ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter', notifyOnQuotaExceeded: true })
    const listener = new SpyListener(new FakeRedis())
    const tenantId = randomUUID()

    await listener.handle(quotaEvent('apiRequests', tenantId))
    await listener.handle(quotaEvent('apiRequests', tenantId)) // same key → deduped
    assert.equal(listener.dispatched, 1)

    await listener.handle(quotaEvent('storage', tenantId)) // different quota → new key
    assert.equal(listener.dispatched, 2)
  })

  test('chaos: a Redis outage fails OPEN — still dispatches, never throws, logs a warning', async ({
    assert,
  }) => {
    setupBillingConfig({ defaultPlan: 'starter', notifyOnQuotaExceeded: true })
    const listener = new SpyListener('throw')

    // Scoped spy: capture warnings for this test, still passing them through to
    // the real logger. Restored by deleting the own-property override so the
    // prototype method is visible again — no bound shadow left on the shared
    // logger singleton.
    const warnings: string[] = []
    const origWarn = (logger as any).warn
    ;(logger as any).warn = (...args: any[]) => {
      const msg = typeof args[0] === 'string' ? args[0] : args[1]
      if (typeof msg === 'string') warnings.push(msg)
      return origWarn.apply(logger, args)
    }
    try {
      await assert.doesNotReject(() => listener.handle(quotaEvent()))
    } finally {
      delete (logger as any).warn
    }

    assert.equal(listener.dispatched, 1, 'dispatched despite the Redis outage (fail-open)')
    assert.isTrue(
      warnings.some((m) => m.includes('dedupe_unavailable')),
      'logged the dedupe_unavailable warning'
    )
  })

  test('degraded: no Redis peer → no dedupe, every event dispatches', async ({ assert }) => {
    setupBillingConfig({ defaultPlan: 'starter', notifyOnQuotaExceeded: true })
    const listener = new SpyListener(null)
    const tenantId = randomUUID()

    await listener.handle(quotaEvent('apiRequests', tenantId))
    await listener.handle(quotaEvent('apiRequests', tenantId))
    assert.equal(listener.dispatched, 2)
  })
})
