import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import AiProvider from '../../../../providers/ai_provider.js'
import StreamExtensionService from '../../../../src/gateway/stream_extension.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
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
})
