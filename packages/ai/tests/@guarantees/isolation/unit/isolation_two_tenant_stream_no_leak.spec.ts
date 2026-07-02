import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../../../../src/gateway/idempotency.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { makeService } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * Two tenants through the full controller path: each stream carries only its
 * own provider content, and identical Idempotency-Key + principal + prompt
 * land in DISJOINT cache entries (the tenant id is inside the MAC), so a
 * replay can never cross tenants.
 */

const tenantA = { id: 'tenant-a' } as unknown as TenantModelContract
const tenantB = { id: 'tenant-b' } as unknown as TenantModelContract
const chatBody = { messages: [{ role: 'user', content: 'the same prompt' }] }

function sharedMapStore(): { store: AiIdempotencyStore; data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    store: {
      async get(tenantId, key) {
        return data.get(`${tenantId}|${key}`)
      },
      async set(tenantId, key, value) {
        data.set(`${tenantId}|${key}`, value)
      },
    },
  }
}

function controllerFor(secret: string, store: AiIdempotencyStore) {
  const { svc } = makeService()
  const registry = new AIProviderRegistry()
  registry.register(
    new MockAIProvider({
      name: 'claude',
      contractVersion: 1,
      fragments: [{ data: secret, tokens: 1 }],
    }),
    { activate: true }
  )
  return new AiChatController({
    stream: svc,
    registry,
    idempotency: new AiIdempotencyService({
      store,
      macKey: deriveAiIdempotencyMacKey('shared-app-key'),
    }),
    liveness: new TenantLivenessWatcher(),
    config: { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
  })
}

test.group('two-tenant stream isolation', () => {
  test('each tenant sees only its own stream, and cache entries are disjoint', async ({
    assert,
  }) => {
    const shared = sharedMapStore()
    const controllerA = controllerFor('secret-of-tenant-A', shared.store)
    const controllerB = controllerFor('secret-of-tenant-B', shared.store)
    const request = (tenant: TenantModelContract) =>
      fakeHttpContext({
        tenant,
        body: chatBody,
        headers: { 'idempotency-key': 'retry-shared' },
        auth: { user: { id: 'user-shared' } },
      })

    const a = request(tenantA)
    const b = request(tenantB)
    await controllerA.chat(a.ctx)
    await controllerB.chat(b.ctx)

    assert.include(a.res.output, 'secret-of-tenant-A')
    assert.notInclude(a.res.output, 'secret-of-tenant-B')
    assert.include(b.res.output, 'secret-of-tenant-B')
    assert.notInclude(b.res.output, 'secret-of-tenant-A')

    const entryKeys = [...shared.data.keys()].filter((k) => !k.endsWith('ai:idem:epoch'))
    assert.lengthOf(entryKeys, 2, 'identical scope inputs, two tenants, two entries')
    assert.notEqual(entryKeys[0], entryKeys[1])
  })

  test('a replay stays inside its tenant', async ({ assert }) => {
    const shared = sharedMapStore()
    const controllerA = controllerFor('secret-of-tenant-A', shared.store)
    const controllerB = controllerFor('secret-of-tenant-B', shared.store)
    const request = (tenant: TenantModelContract) =>
      fakeHttpContext({
        tenant,
        body: chatBody,
        headers: { 'idempotency-key': 'retry-shared' },
        auth: { user: { id: 'user-shared' } },
      })

    await controllerA.chat(request(tenantA).ctx)
    await controllerB.chat(request(tenantB).ctx)

    const replayA = request(tenantA)
    await controllerA.chat(replayA.ctx)

    assert.equal(replayA.res.headers['x-ai-idempotent-replay'], '1')
    assert.include(replayA.res.output, 'secret-of-tenant-A')
    assert.notInclude(replayA.res.output, 'secret-of-tenant-B')
  })
})
