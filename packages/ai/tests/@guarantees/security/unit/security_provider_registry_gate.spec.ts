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
      registry.register(new MockAIProvider({ name: 'claude', contractVersion: 2 }))
    )
    assert.isTrue(registry.has('claude'))
  })

  test('throws for a provider declaring a newer contract version', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.throws(
      () => registry.register(new MockAIProvider({ name: 'future', contractVersion: 3 })),
      /requires extension contract v3/
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

/**
 * The EXT-3 shape gate backing the v2 bump. `assertContractCompat` only WARNS an
 * older provider, so a v1 provider claiming a v2 capability would otherwise boot
 * and crash mid-stream. Tool support IS contract v2, so a provider declaring
 * `capabilities.tools` against a pre-v2 contract is incoherent and fails closed at
 * registration. A v1 provider that makes no such claim stays welcome,
 * because every member v2 added is optional and the chat controller never hands a
 * tool turn to a provider that did not declare the capability.
 */
test.group('AIProviderRegistry: v2 tool-capability shape gate (EXT-3)', () => {
  test('fail-closes a provider claiming tools against a pre-v2 contract', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.throws(
      () =>
        registry.register(new MockAIProvider({ name: 'stale', contractVersion: 1, tools: true })),
      /declares capabilities\.tools but was built against contract v1/
    )
    assert.isFalse(registry.has('stale'), 'a refused provider is never registered')
  })

  test('fail-closes an unversioned provider claiming tools', ({ assert }) => {
    // Absent is the worst case: it cannot have been written against v2's wire shapes.
    const registry = new AIProviderRegistry()
    assert.throws(
      () => registry.register(new MockAIProvider({ name: 'unversioned', tools: true })),
      /contract v\(unversioned\)/
    )
    assert.isFalse(registry.has('unversioned'))
  })

  test('accepts a v2 provider declaring tools', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.doesNotThrow(() =>
      registry.register(new MockAIProvider({ name: 'claude', contractVersion: 2, tools: true }))
    )
    assert.isTrue(registry.has('claude'))
  })

  test('a v1 provider that claims no tools still registers (v2 is additive for it)', ({
    assert,
  }) => {
    const registry = new AIProviderRegistry()
    assert.doesNotThrow(() =>
      registry.register(new MockAIProvider({ name: 'plain', contractVersion: 1, tools: false }))
    )
    assert.doesNotThrow(() => registry.register(new MockAIProvider({ name: 'silent' })))
    assert.isTrue(registry.has('plain'))
    assert.isTrue(registry.has('silent'), 'the gate only fires on an actual tools claim')
  })

  test('the shipped providers satisfy their own gate', ({ assert }) => {
    // ClaudeProvider / OpenAICompatibleProvider declare capabilities.tools, so they
    // must also declare contract v2, or the gate would refuse the built-ins.
    const registry = new AIProviderRegistry()
    assert.doesNotThrow(() =>
      registry.register(new MockAIProvider({ name: 'deepseek', contractVersion: 2, tools: true }))
    )
    assert.isTrue(registry.has('deepseek'))
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
    assert.equal((err as unknown as AIException).aiCode, 'provider_not_allowed')
  })

  test('forTenant throws provider_unavailable when the selected provider is unregistered', ({
    assert,
  }) => {
    const registry = new AIProviderRegistry()
    const err = assert.throws(() => registry.forTenant(tenant, configWith()), /not registered/)
    assert.equal((err as unknown as AIException).aiCode, 'provider_unavailable')
  })

  test('resolveTenantProviderSelection throws config_missing without a config block', ({
    assert,
  }) => {
    const err = assert.throws(
      () => resolveTenantProviderSelection(tenant, undefined),
      /ai config block is absent/
    )
    assert.equal((err as unknown as AIException).aiCode, 'config_missing')
  })

  test('resolveTenantProviderSelection returns the provider and its default model', ({
    assert,
  }) => {
    const selection = resolveTenantProviderSelection(tenant, configWith())
    assert.equal(selection.provider, 'claude')
    assert.equal(selection.model, 'claude-opus-4-8')
  })
})
