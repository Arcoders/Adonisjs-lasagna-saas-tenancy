import { test } from '@japa/runner'
import { assertAiConfig } from '../../../../src/validate_config.js'
import { defineAiConfig } from '../../../../src/define_config.js'

/**
 * Composition smoke for the AI satellite, run through the shared integration
 * harness (a real Ignitor + the kit DDL). It proves the package's public config
 * surface loads and behaves under the real module graph and runtime, the same
 * path the provider `boot()` exercises. Depth lives in the streaming service and
 * provider specs; this is the boot canary that keeps the integration tier honest
 * and produces the package's integration coverage artifact.
 */
test.group('ai config surface (integration)', () => {
  test('a valid ai block round-trips and boot-validates', ({ assert }) => {
    const cfg = defineAiConfig({
      allowedProviders: ['claude'],
      defaultProvider: 'claude',
      claude: { apiKey: 'sk-test', defaultModel: 'claude-opus-4-8' },
    })
    assert.doesNotThrow(() => assertAiConfig(cfg))
  })

  test('a bad ai block fails boot-validation loudly', ({ assert }) => {
    assert.throws(
      () => assertAiConfig({ allowedProviders: [] }),
      /allowedProviders must be a non-empty array/
    )
  })
})
