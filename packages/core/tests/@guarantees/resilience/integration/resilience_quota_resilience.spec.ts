import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import emitter from '@adonisjs/core/services/emitter'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { DependencyUnavailableException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import { DependencyDegraded } from '@adonisjs-lasagna/saas-tenancy/events'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '../../../helpers/config.js'

/**
 * §1.1 / Fase B — QuotaService routes Redis through ResilienceService, so a
 * Redis outage is handled per `config.resilience.redis.quota`:
 *   - fail-open (default): consume() returns 0 (skips enforcement) + emits
 *     DependencyDegraded — no longer a SILENT no-op.
 *   - fail-closed: consume() throws DependencyUnavailableException (503).
 *
 * The outage is injected through the `protected requireRedis()` seam.
 */
class OutageQuotaService extends QuotaService {
  protected async requireRedis(): Promise<any> {
    throw new Error('simulated redis outage')
  }
}

test.group('QuotaService resilience policy (integration)', (group) => {
  let original: ReturnType<typeof getConfig>
  const captured: Array<{ payload: { dependency: string; operation: string; policy: string } }> = []
  const onDegraded = (e: any) => captured.push(e)

  group.each.setup(() => {
    original = getConfig()
    captured.length = 0
    emitter.on(DependencyDegraded, onDegraded)
  })

  group.each.teardown(() => {
    emitter.off(DependencyDegraded, onDegraded)
    setConfig(original)
  })

  function configure(policy?: 'fail-open' | 'fail-closed'): void {
    setConfig({
      ...testConfig,
      plans: {
        defaultPlan: 'pro',
        definitions: { pro: { limits: { apiRequests: 100 } } },
        storage: 'config-only',
        getPlan: () => 'pro',
      },
      ...(policy ? { resilience: { redis: { quota: policy } } } : {}),
    } as never)
  }

  test('fail-open (default): consume returns 0 + emits DependencyDegraded on Redis outage', async ({
    assert,
  }) => {
    configure() // no resilience block → quota defaults to fail-open
    const svc = new OutageQuotaService()
    const tenant = { id: randomUUID() } as any

    const result = await svc.consume(tenant, 'apiRequests', 1)
    assert.equal(result, 0, 'fail-open returns 0 instead of throwing')

    // The DependencyDegraded dispatch is best-effort/async — give it a tick.
    await new Promise((r) => setTimeout(r, 40))
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.payload.dependency, 'redis')
    assert.equal(captured[0]!.payload.operation, 'quota.consume')
    assert.equal(captured[0]!.payload.policy, 'fail-open')
  })

  test('fail-closed: consume throws DependencyUnavailableException on Redis outage', async ({
    assert,
  }) => {
    configure('fail-closed')
    const svc = new OutageQuotaService()
    const tenant = { id: randomUUID() } as any

    await assert.rejects(
      () => svc.consume(tenant, 'apiRequests', 1),
      DependencyUnavailableException
    )
  })
})
