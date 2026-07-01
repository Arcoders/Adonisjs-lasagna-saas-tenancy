import { test } from '@japa/runner'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import { resolveTenantProviderSelection } from '../../../../src/services/tenant_provider_selection.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import type { AiConfig } from '../../../../src/define_config.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

const tenant = { id: 'tenant-1' } as unknown as TenantModelContract

function configWith(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    allowedProviders: ['claude'],
    defaultProvider: 'claude',
    claude: { apiKey: 'k', defaultModel: 'claude-opus-4-8' },
    ...overrides,
  }
}

test.group('AIProviderRegistry: streaming-presence gate', () => {
  test('fail-closes a non-streaming provider at registration', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.throws(
      () => registry.register(new MockAIProvider({ name: 'nostream', streaming: false })),
      /does not declare capabilities\.streaming/
    )
    assert.isFalse(registry.has('nostream'))
  })

  test('accepts a streaming provider (equal contract version is silent)', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.doesNotThrow(() =>
      registry.register(new MockAIProvider({ name: 'claude', contractVersion: 1 }))
    )
    assert.isTrue(registry.has('claude'))
  })

  test('throws for a provider declaring a newer contract version', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.throws(
      () => registry.register(new MockAIProvider({ name: 'future', contractVersion: 2 })),
      /requires extension contract v2/
    )
  })

  test('an older or absent contract version warns but registers', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.doesNotThrow(() =>
      registry.register(new MockAIProvider({ name: 'older', contractVersion: 0 }))
    )
    assert.doesNotThrow(() => registry.register(new MockAIProvider({ name: 'unversioned' })))
    assert.isTrue(registry.has('older'))
    assert.isTrue(registry.has('unversioned'))
  })
})

test.group('AIProviderRegistry: per-tenant selection (default-deny)', () => {
  test('forTenant resolves the configured default provider', ({ assert }) => {
    const registry = new AIProviderRegistry()
    const claude = new MockAIProvider({ name: 'claude' })
    registry.register(claude)
    assert.strictEqual(registry.forTenant(tenant, configWith()), claude)
  })

  test('forTenant default-denies a provider outside the allow-list', ({ assert }) => {
    // A default that is not allow-listed is refused by the selection seam.
    const registry = new AIProviderRegistry()
    registry.register(new MockAIProvider({ name: 'claude' }))
    const err = assert.throws(
      () =>
        registry.forTenant(
          tenant,
          configWith({ allowedProviders: ['deepseek'], defaultProvider: 'claude' })
        ),
      /not allow-listed/
    )
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'provider_not_allowed')
  })

  test('forTenant throws provider_unavailable when the selected provider is unregistered', ({
    assert,
  }) => {
    const registry = new AIProviderRegistry()
    const err = assert.throws(() => registry.forTenant(tenant, configWith()), /not registered/)
    assert.equal((err as AIException).aiCode, 'provider_unavailable')
  })

  test('resolveTenantProviderSelection throws config_missing without a config block', ({
    assert,
  }) => {
    const err = assert.throws(
      () => resolveTenantProviderSelection(tenant, undefined),
      /ai config block is absent/
    )
    assert.equal((err as AIException).aiCode, 'config_missing')
  })

  test('resolveTenantProviderSelection returns the provider and its default model', ({
    assert,
  }) => {
    const selection = resolveTenantProviderSelection(tenant, configWith())
    assert.equal(selection.provider, 'claude')
    assert.equal(selection.model, 'claude-opus-4-8')
  })
})
