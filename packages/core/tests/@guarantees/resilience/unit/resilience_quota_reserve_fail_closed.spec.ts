import { test } from '@japa/runner'
import QuotaService from '../../../../src/services/quota_service.js'
import DependencyUnavailableException from '../../../../src/exceptions/dependency_unavailable_exception.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig, testConfig } from '../../../helpers/config.js'

/**
 * `QuotaService.reserve` is FAIL-CLOSED BY CONSTRUCTION, the deliberate opposite
 * of `consume` (which honours `resilience.redis.quota`, defaulting fail-open to
 * favour availability). A reservation gates an expensive streaming provider call:
 * if Redis is unreachable the budget cannot be proven, so the hold is refused
 * with a 503 rather than let the cost race through unheld. `settle`/`release` are
 * best-effort (fail-open): the up-front hold is the guarantee and its TTL reaps
 * anything a missed settle leaves, so a Redis blip must not break the streaming
 * finally. The outage is injected through the `protected requireRedis()` seam.
 */
class OutageQuotaService extends QuotaService {
  protected async requireRedis(): Promise<any> {
    throw new Error('simulated redis outage')
  }
}

function configure(quotaPolicy?: 'fail-open' | 'fail-closed'): void {
  setupTestConfig({
    ...testConfig,
    plans: { defaultPlan: 'pro', definitions: { pro: { limits: { aiTokens: 100 } } } },
    ...(quotaPolicy ? { resilience: { redis: { quota: quotaPolicy } } } : {}),
  } as never)
}

const handle = () =>
  ({
    id: 'h1',
    tenantId: buildTestTenant().id,
    quota: 'aiTokens',
    day: '2026-07-01',
    worstCase: 10,
    ttl: 1000,
    op: false,
  }) as never

test.group('QuotaService.reserve — fail-closed by construction', () => {
  test('a Redis outage during reserve throws, never granting an unheld reservation', async ({
    assert,
  }) => {
    configure()
    const svc = new OutageQuotaService()
    await assert.rejects(
      () => svc.reserve(buildTestTenant(), 'aiTokens', 10),
      DependencyUnavailableException
    )
  })

  test('reserve stays fail-closed even when resilience.redis.quota is set to fail-open', async ({
    assert,
  }) => {
    // Under this exact config `consume()` returns 0 (allows). `reserve()` must
    // NOT inherit that posture: it reads its own hard-coded fail-closed policy.
    configure('fail-open')
    const svc = new OutageQuotaService()
    await assert.rejects(
      () => svc.reserve(buildTestTenant(), 'aiTokens', 10),
      DependencyUnavailableException
    )
  })

  test('settle and release stay best-effort (fail-open) under a Redis outage', async ({
    assert,
  }) => {
    configure('fail-closed')
    const svc = new OutageQuotaService()
    const r = handle()
    await svc.settle(r, 5) // must resolve, not throw
    const freed = await svc.release(r)
    assert.equal(freed, 0, 'release fails open to 0 freed')
  })
})
