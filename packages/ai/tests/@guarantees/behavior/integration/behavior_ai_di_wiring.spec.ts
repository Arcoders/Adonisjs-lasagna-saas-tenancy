import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { TenantSuspended } from '@adonisjs-lasagna/saas-tenancy/events'
import AiProvider from '../../../../providers/ai_provider.js'
import StreamExtensionService from '../../../../src/gateway/stream_extension.js'
import VectorStoreService from '../../../../src/services/vector_store_service.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher, {
  wireAiTenantLiveness,
} from '../../../../src/services/tenant_liveness_watcher.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'

/**
 * Integration: the AI provider's container wiring resolves against the real,
 * booted app. `register()` binds the provider registry and the streaming service;
 * resolving the latter proves its quota / breaker / metrics seams are all makeable
 * from the real container (the DI a unit test cannot cover). Runs through the
 * shared kit Ignitor.
 */
test.group('ai provider DI wiring (integration)', () => {
  test('registers a resolvable StreamExtensionService and provider registry', async ({
    assert,
  }) => {
    new AiProvider(app).register()

    const service = await app.container.make(StreamExtensionService)
    assert.instanceOf(service, StreamExtensionService)

    const registry = await app.container.make(AIProviderRegistry)
    registry.register(new MockAIProvider({ name: 'claude', contractVersion: 1 }))
    assert.isTrue(registry.has('claude'))
  })

  test('registers a resolvable VectorStoreService (driver + lucid.db + tenancy scope seal)', async ({
    assert,
  }) => {
    new AiProvider(app).register()
    // Resolving proves getActiveDriver, the `lucid.db` container alias, and the
    // tenancy scope accessor are all makeable from the real booted container (the
    // DI a unit test with a fake db cannot cover).
    const store = await app.container.make(VectorStoreService)
    assert.instanceOf(store, VectorStoreService)
  })

  test('the liveness watcher resolves and a real TenantSuspended dispatch aborts its signals', async ({
    assert,
  }) => {
    new AiProvider(app).register()

    const watcher = await app.container.make(TenantLivenessWatcher)
    assert.instanceOf(watcher, TenantLivenessWatcher)

    // Wire against the REAL emitter (what AiProvider.ready() does) and drive it
    // with a genuine event dispatch through the booted app.
    const emitter = await app.container.make('emitter')
    const teardown = wireAiTenantLiveness(emitter, watcher)
    try {
      const live = watcher.acquire('t-liveness-int')
      const bystander = watcher.acquire('t-bystander-int')

      await emitter.emit(TenantSuspended, new TenantSuspended({ id: 't-liveness-int' } as never))

      assert.isTrue(live.signal.aborted, 'the suspended tenant’s stream must abort')
      assert.isFalse(bystander.signal.aborted, 'other tenants are untouched')
      bystander.dispose()
    } finally {
      teardown()
    }
  })
})
