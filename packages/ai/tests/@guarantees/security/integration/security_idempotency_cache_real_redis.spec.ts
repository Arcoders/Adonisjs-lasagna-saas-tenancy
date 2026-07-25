import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import AiProvider from '../../../../providers/ai_provider.js'
import AiIdempotencyService, {
  type AiIdempotencyScope,
  type CachedAiResponse,
} from '../../../../src/gateway/idempotency.js'

/**
 * The idempotency cache against the REAL kernel cache stack (memory L1 +
 * Redis L2 via `cacheFor`): tenant namespaces are disjoint, the TTL is
 * honoured end to end, and the epoch bump invalidates on real
 * infrastructure, not just the Map double.
 */

const completed: CachedAiResponse = {
  v: 1,
  frames: ['id: 1\nevent: token\ndata: real\n\n'],
  result: { tokensSettled: 3, fragments: 1, lastEventId: '1' },
}

function scopeFor(tenantId: string): AiIdempotencyScope {
  return { tenantId, principal: 'user-1', sessionId: 's1', headerKey: 'retry-int-1' }
}

test.group('idempotency cache on real Redis (integration)', (group) => {
  let service: AiIdempotencyService

  group.setup(async () => {
    new AiProvider(app).register?.()
    service = await app.container.make(AiIdempotencyService)
  })

  test('two tenants with an identical scope land in disjoint namespaces', async ({ assert }) => {
    const a = scopeFor('11111111-1111-4111-8111-11111111a001')
    const b = scopeFor('11111111-1111-4111-8111-11111111b001')

    await service.save(a, completed)

    assert.deepEqual(await service.lookup(a), completed)
    assert.isNull(await service.lookup(b), 'tenant B must never see tenant A entries')
  })

  test('two principals in the same tenant with an identical key land in disjoint slots', async ({
    assert,
  }) => {
    const tenantId = '11111111-1111-4111-8111-11111111e001'
    const userA: AiIdempotencyScope = {
      tenantId,
      principal: 'user-A',
      sessionId: 's1',
      headerKey: 'retry-int-1',
    }
    const userB: AiIdempotencyScope = {
      tenantId,
      principal: 'user-B',
      sessionId: 's1',
      headerKey: 'retry-int-1',
    }

    await service.save(userA, completed)

    assert.deepEqual(await service.lookup(userA), completed)
    assert.isNull(
      await service.lookup(userB),
      "principal B must never read principal A's cached completion within the same tenant"
    )
  })

  test('the epoch bump invalidates on the real stack', async ({ assert }) => {
    const scope = scopeFor('11111111-1111-4111-8111-11111111c001')
    await service.save(scope, completed)
    assert.deepEqual(await service.lookup(scope), completed)

    await service.bumpEpoch(scope.tenantId)
    assert.isNull(await service.lookup(scope))
  })

  test('an entry expires with its TTL', async ({ assert }) => {
    const shortLived = new AiIdempotencyService({
      store: {
        async get(tenantId, key) {
          const { cacheFor } = await import('@adonisjs-lasagna/saas-tenancy/services')
          return await cacheFor(tenantId).get<string>({ key })
        },
        async set(tenantId, key, value, ttlMs) {
          const { cacheFor } = await import('@adonisjs-lasagna/saas-tenancy/services')
          await cacheFor(tenantId).set({ key, value, ttl: ttlMs })
        },
      },
      macKey: Buffer.alloc(32, 7),
      ttlMs: 150,
    })
    const scope = scopeFor('11111111-1111-4111-8111-11111111d001')

    await shortLived.save(scope, completed)
    assert.deepEqual(await shortLived.lookup(scope), completed)

    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.isNull(await shortLived.lookup(scope), 'the TTL must reap the entry')
  })
})
