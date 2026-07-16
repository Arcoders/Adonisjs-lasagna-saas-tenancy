import { test } from '@japa/runner'
import { assertAiConfig } from '../../../../src/validate_config.js'
import { defineAiConfig, type AiConfig } from '../../../../src/define_config.js'

/** A minimal, valid config: only claude allow-listed with its block present. */
function validClaudeOnly(): AiConfig {
  return {
    allowedProviders: ['claude'],
    defaultProvider: 'claude',
    claude: { apiKey: 'sk-test', defaultModel: 'claude-opus-4-8' },
  }
}

test.group('assertAiConfig', () => {
  test('undefined block passes (optional)', ({ assert }) => {
    assert.doesNotThrow(() => assertAiConfig(undefined))
    assert.doesNotThrow(() => assertAiConfig(null as unknown as AiConfig))
  })

  test('a valid single-provider config passes', ({ assert }) => {
    assert.doesNotThrow(() => assertAiConfig(validClaudeOnly()))
  })

  test('a valid multi-provider config with tunables passes', ({ assert }) => {
    const cfg = defineAiConfig({
      allowedProviders: ['claude', 'deepseek', 'kimi'],
      defaultProvider: 'deepseek',
      claude: { apiKey: 'k', defaultModel: 'claude-opus-4-8', apiVersion: '2023-06-01' },
      deepseek: {
        apiKey: 'k',
        defaultModel: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com',
        allowedModels: ['deepseek-chat'],
      },
      kimi: { apiKey: 'k', defaultModel: 'kimi-latest' },
      heartbeatMs: 15000,
      timeoutMs: 60000,
      maxTokens: 4096,
    })
    assert.doesNotThrow(() => assertAiConfig(cfg))
  })

  test('rejects a non-object block', ({ assert }) => {
    assert.throws(
      () => assertAiConfig('nope' as unknown as AiConfig),
      /config\.ai must be an object/
    )
  })

  test('rejects a missing or empty allow-list (default-deny)', ({ assert }) => {
    assert.throws(
      () => assertAiConfig({} as AiConfig),
      /allowedProviders must be a non-empty array/
    )
    assert.throws(
      () => assertAiConfig({ allowedProviders: [] }),
      /allowedProviders must be a non-empty array/
    )
  })

  test('rejects a non-string allow-list entry', ({ assert }) => {
    assert.throws(
      () => assertAiConfig({ allowedProviders: [123 as unknown as string] }),
      /allowedProviders entries must be non-empty strings/
    )
  })

  test('rejects a default provider outside the allow-list', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['deepseek'],
          defaultProvider: 'claude',
          deepseek: { apiKey: 'k', defaultModel: 'deepseek-chat' },
        }),
      /defaultProvider "claude" is not in allowedProviders/
    )
  })

  test('the effective default (claude) must itself be allow-listed', ({ assert }) => {
    // defaultProvider omitted => 'claude', but only deepseek is allow-listed.
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['deepseek'],
          deepseek: { apiKey: 'k', defaultModel: 'deepseek-chat' },
        }),
      /defaultProvider "claude" is not in allowedProviders/
    )
  })

  test('rejects an allow-listed built-in with a missing block', ({ assert }) => {
    assert.throws(
      () => assertAiConfig({ allowedProviders: ['claude'], defaultProvider: 'claude' }),
      /provider "claude" is allow-listed but config\.ai\.claude is missing/
    )
  })

  test('rejects a provider block missing the apiKey', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['claude'],
          claude: { apiKey: '', defaultModel: 'claude-opus-4-8' },
        }),
      /config\.ai\.claude\.apiKey must be a non-empty string/
    )
  })

  test('rejects a present-but-empty defaultModel, allows an omitted one', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['claude'],
          claude: { apiKey: 'k', defaultModel: '' },
        }),
      /config\.ai\.claude\.defaultModel, when set, must be a non-empty string/
    )
    // Omitted defaultModel is fine: the provider falls back to its built-in default.
    assert.doesNotThrow(() =>
      assertAiConfig({ allowedProviders: ['claude'], claude: { apiKey: 'k' } })
    )
  })

  test('rejects a non-https baseUrl and an unparseable baseUrl', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['deepseek'],
          defaultProvider: 'deepseek',
          deepseek: {
            apiKey: 'k',
            defaultModel: 'deepseek-chat',
            baseUrl: 'http://api.deepseek.com',
          },
        }),
      /baseUrl must be https/
    )
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['deepseek'],
          defaultProvider: 'deepseek',
          deepseek: { apiKey: 'k', defaultModel: 'deepseek-chat', baseUrl: 'not a url' },
        }),
      /baseUrl is not a valid URL/
    )
  })

  test('rejects a non-string allowedModels list', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['claude'],
          claude: {
            apiKey: 'k',
            defaultModel: 'claude-opus-4-8',
            allowedModels: [1 as unknown as string],
          },
        }),
      /allowedModels must be an array of strings/
    )
  })

  test('rejects a non-string apiVersion', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig({
          allowedProviders: ['claude'],
          claude: {
            apiKey: 'k',
            defaultModel: 'claude-opus-4-8',
            apiVersion: 1 as unknown as string,
          },
        }),
      /apiVersion must be a string/
    )
  })

  test('rejects non-positive-integer tunables', ({ assert }) => {
    const knobs = [
      'heartbeatMs',
      'timeoutMs',
      'maxTokens',
      'idempotencyTtlMs',
      'maxPromptChars',
    ] as const
    for (const knob of knobs) {
      assert.throws(
        () => assertAiConfig({ ...validClaudeOnly(), [knob]: 0 }),
        new RegExp(`config\\.ai\\.${knob} must be a positive integer`)
      )
      assert.throws(
        () => assertAiConfig({ ...validClaudeOnly(), [knob]: 1.5 }),
        new RegExp(`config\\.ai\\.${knob} must be a positive integer`)
      )
    }
  })

  test('accepts the gateway hooks and gate acknowledgement when well-typed', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertAiConfig({
        ...validClaudeOnly(),
        authorizeAIAccess: async () => true,
        acknowledgeNoMembershipGate: false,
        resolvePrincipal: () => 'user-1',
        idempotencyTtlMs: 60000,
        maxPromptChars: 32000,
      })
    )
  })

  test('rejects mistyped gateway hooks and acknowledgement', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig({
          ...validClaudeOnly(),
          authorizeAIAccess: true as unknown as AiConfig['authorizeAIAccess'],
        }),
      /authorizeAIAccess, when set, must be a function/
    )
    assert.throws(
      () =>
        assertAiConfig({
          ...validClaudeOnly(),
          acknowledgeNoMembershipGate: 'yes' as unknown as boolean,
        }),
      /acknowledgeNoMembershipGate, when set, must be a boolean/
    )
    assert.throws(
      () =>
        assertAiConfig({
          ...validClaudeOnly(),
          resolvePrincipal: 'user-1' as unknown as AiConfig['resolvePrincipal'],
        }),
      /resolvePrincipal, when set, must be a function/
    )
  })

  test('a custom (non-built-in) allow-listed provider needs no built-in block', ({ assert }) => {
    // A host-registered BYOK provider is validated by its own registration, not
    // by assertAiConfig, so allow-listing it without a claude/deepseek/kimi block
    // is fine as long as the default resolves.
    assert.doesNotThrow(() =>
      assertAiConfig({
        allowedProviders: ['my-byok', 'claude'],
        defaultProvider: 'my-byok',
        claude: { apiKey: 'k', defaultModel: 'claude-opus-4-8' },
      })
    )
  })
})

test.group('assertAiConfig — the embedding block (WS-AI-3)', () => {
  const withEmbedding = (embedding: Record<string, unknown>): AiConfig =>
    ({ ...validClaudeOnly(), embedding }) as unknown as AiConfig

  test('a valid embedding block passes', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertAiConfig(
        withEmbedding({
          apiKey: 'sk-embed',
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'text-embedding-3-small',
          dimension: 1536,
          maxEmbeddingTokens: 256,
        })
      )
    )
  })

  test('an omitted embedding block still passes', ({ assert }) => {
    assert.doesNotThrow(() => assertAiConfig(validClaudeOnly()))
  })

  test('requires an apiKey and a baseUrl', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withEmbedding({ baseUrl: 'https://api.openai.com/v1' })),
      /config\.ai\.embedding\.apiKey must be a non-empty string/
    )
    assert.throws(
      () => assertAiConfig(withEmbedding({ apiKey: 'k' })),
      /config\.ai\.embedding\.baseUrl is required/
    )
  })

  test('rejects a non-https baseUrl', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withEmbedding({ apiKey: 'k', baseUrl: 'http://api.openai.com/v1' })),
      /config\.ai\.embedding\.baseUrl must be https/
    )
  })

  test('rejects a dimension outside pgvector 1..2000', ({ assert }) => {
    for (const dimension of [0, 2001, 1.5]) {
      assert.throws(
        () =>
          assertAiConfig(
            withEmbedding({ apiKey: 'k', baseUrl: 'https://x.example.com', dimension })
          ),
        /dimension must be an integer in 1\.\.2000/
      )
    }
    assert.doesNotThrow(() =>
      assertAiConfig(
        withEmbedding({ apiKey: 'k', baseUrl: 'https://x.example.com', dimension: 2000 })
      )
    )
  })

  test('rejects a mistyped authorizeIngestion hook', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig(
          withEmbedding({
            apiKey: 'k',
            baseUrl: 'https://x.example.com',
            authorizeIngestion: 'yes',
          })
        ),
      /authorizeIngestion, when set, must be a function/
    )
  })
})
