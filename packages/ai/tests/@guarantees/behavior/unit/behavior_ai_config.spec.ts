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
          authorizeAIAccess: true,
        } as unknown as AiConfig),
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
          resolvePrincipal: 'user-1',
        } as unknown as AiConfig),
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

test.group('assertAiConfig: the embedding block', () => {
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

  test('accepts the content-at-rest flags when boolean', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertAiConfig(
        withEmbedding({
          apiKey: 'k',
          baseUrl: 'https://x.example.com',
          encryptContent: true,
          encryptMetadata: false,
        })
      )
    )
  })

  test('rejects non-boolean content-at-rest flags', ({ assert }) => {
    assert.throws(
      () =>
        assertAiConfig(
          withEmbedding({ apiKey: 'k', baseUrl: 'https://x.example.com', encryptContent: 'yes' })
        ),
      /config\.ai\.embedding\.encryptContent, when set, must be a boolean/
    )
    assert.throws(
      () =>
        assertAiConfig(
          withEmbedding({ apiKey: 'k', baseUrl: 'https://x.example.com', encryptMetadata: 1 })
        ),
      /config\.ai\.embedding\.encryptMetadata, when set, must be a boolean/
    )
  })
})

test.group('assertAiConfig: the memory block (encryption mode)', () => {
  const withMemory = (memory: Record<string, unknown>): AiConfig =>
    ({ ...validClaudeOnly(), memory }) as unknown as AiConfig

  test('accepts both encryption modes and an omitted one (default app-key)', ({ assert }) => {
    assert.doesNotThrow(() => assertAiConfig(withMemory({})))
    assert.doesNotThrow(() => assertAiConfig(withMemory({ encryption: 'app-key' })))
    assert.doesNotThrow(() => assertAiConfig(withMemory({ encryption: 'tenant-dek' })))
  })

  test('rejects an encryption mode outside the validated union', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withMemory({ encryption: 'kms' })),
      /config\.ai\.memory\.encryption, when set, must be one of app-key \| tenant-dek/
    )
  })

  test('still validates the existing memory bounds', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withMemory({ maxTurns: 0 })),
      /config\.ai\.memory\.maxTurns must be a positive integer/
    )
  })
})

test.group('assertAiConfig: the tools block', () => {
  const readTool = (over: Record<string, unknown> = {}) => ({
    name: 'count_bookings',
    description: 'count bookings by status',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ count: 0 }),
    ...over,
  })
  const withTools = (tools: Record<string, unknown>): AiConfig =>
    ({ ...validClaudeOnly(), tools }) as unknown as AiConfig

  test('a valid tools block (registry + hooks + bounds) passes', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertAiConfig(
        withTools({
          registry: [readTool()],
          resolveTools: async () => [readTool({ name: 'other' })],
          authorizeTool: () => ({ kind: 'allow' }),
          acknowledgeUnauthorizedTools: false,
          actionTools: { enabled: false },
          maxRounds: 4,
          toolTimeoutMs: 5000,
          maxConcurrentPerTenant: 8,
          surfaceToolArgs: true,
        })
      )
    )
  })

  test('an omitted tools block passes', ({ assert }) => {
    assert.doesNotThrow(() => assertAiConfig(validClaudeOnly()))
  })

  test('rejects a non-object tools block', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withTools('nope' as unknown as Record<string, unknown>)),
      /config\.ai\.tools, when set, must be an object/
    )
  })

  test('rejects mistyped hooks and flags', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withTools({ resolveTools: 'x' })),
      /resolveTools, when set, must be a function/
    )
    assert.throws(
      () => assertAiConfig(withTools({ authorizeTool: 1 })),
      /authorizeTool, when set, must be a function/
    )
    assert.throws(
      () => assertAiConfig(withTools({ acknowledgeUnauthorizedTools: 'yes' })),
      /acknowledgeUnauthorizedTools, when set, must be a boolean/
    )
    assert.throws(
      () => assertAiConfig(withTools({ surfaceToolArgs: 1 })),
      /surfaceToolArgs, when set, must be a boolean/
    )
    assert.throws(
      () => assertAiConfig(withTools({ actionTools: true })),
      /actionTools, when set, must be an object/
    )
    assert.throws(
      () => assertAiConfig(withTools({ actionTools: { enabled: 'on' } })),
      /actionTools\.enabled, when set, must be a boolean/
    )
  })

  test('rejects a non-array registry and a malformed tool entry', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withTools({ registry: {} })),
      /registry, when set, must be an array/
    )
    assert.throws(
      () => assertAiConfig(withTools({ registry: [readTool({ name: '' })] })),
      /\.name must be a non-empty string/
    )
    assert.throws(
      () => assertAiConfig(withTools({ registry: [readTool({ description: '' })] })),
      /\.description must be a non-empty string/
    )
    assert.throws(
      () => assertAiConfig(withTools({ registry: [readTool({ inputSchema: [] })] })),
      /\.inputSchema must be an object/
    )
    assert.throws(
      () => assertAiConfig(withTools({ registry: [readTool({ handler: 'nope' })] })),
      /\.handler must be a function/
    )
    assert.throws(
      () => assertAiConfig(withTools({ registry: [readTool({ mode: 'write' })] })),
      /\.mode, when set, must be 'read' or 'action'/
    )
    assert.throws(
      () => assertAiConfig(withTools({ registry: [readTool({ parseInput: 3 })] })),
      /\.parseInput, when set, must be a function/
    )
  })

  test('rejects a bound above its ceiling or non-integer', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withTools({ maxRounds: 9 })),
      /tools\.maxRounds must be a positive integer <= 8/
    )
    assert.throws(
      () => assertAiConfig(withTools({ maxToolsPerRound: 9 })),
      /tools\.maxToolsPerRound must be a positive integer <= 8/
    )
    assert.throws(
      () => assertAiConfig(withTools({ maxToolCallsPerRequest: 17 })),
      /tools\.maxToolCallsPerRequest must be a positive integer <= 16/
    )
    assert.throws(
      () => assertAiConfig(withTools({ toolTimeoutMs: 30001 })),
      /tools\.toolTimeoutMs must be a positive integer <= 30000/
    )
    assert.throws(
      () => assertAiConfig(withTools({ maxToolResultChars: 16001 })),
      /tools\.maxToolResultChars must be a positive integer <= 16000/
    )
    assert.throws(
      () => assertAiConfig(withTools({ maxToolArgsChars: 16001 })),
      /tools\.maxToolArgsChars must be a positive integer <= 16000/
    )
    assert.throws(
      () => assertAiConfig(withTools({ maxConcurrentPerTenant: 33 })),
      /tools\.maxConcurrentPerTenant must be a positive integer <= 32/
    )
    assert.throws(
      () => assertAiConfig(withTools({ maxRounds: 2.5 })),
      /tools\.maxRounds must be a positive integer <= 8/
    )
    assert.throws(
      () => assertAiConfig(withTools({ maxRounds: 0 })),
      /tools\.maxRounds must be a positive integer <= 8/
    )
  })
})

test.group('assertAiConfig: the injection block', () => {
  const withInjection = (injection: Record<string, unknown>): AiConfig =>
    ({ ...validClaudeOnly(), injection }) as unknown as AiConfig

  test('an omitted injection block passes (structural boundary is the default)', ({ assert }) => {
    assert.doesNotThrow(() => assertAiConfig(validClaudeOnly()))
  })

  test('a valid injection block (classifier + onError + scanRetrieved) passes', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertAiConfig(
        withInjection({
          classifier: () => ({ action: 'allow' }),
          onError: 'closed',
          scanRetrieved: true,
        })
      )
    )
    // Every field is optional: an empty block is valid too.
    assert.doesNotThrow(() => assertAiConfig(withInjection({})))
  })

  test('rejects a non-object injection block', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withInjection('nope' as unknown as Record<string, unknown>)),
      /config\.ai\.injection, when set, must be an object/
    )
  })

  test('rejects a non-function classifier (boot fail-closed via guard.ai_config_invalid)', ({
    assert,
  }) => {
    assert.throws(
      () => assertAiConfig(withInjection({ classifier: 'a-string' })),
      /config\.ai\.injection\.classifier, when set, must be a function/
    )
  })

  test("rejects an onError outside {'open','closed'}", ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withInjection({ onError: 'maybe' })),
      /config\.ai\.injection\.onError, when set, must be 'open' or 'closed'/
    )
  })

  test('rejects a non-boolean scanRetrieved', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withInjection({ scanRetrieved: 'yes' })),
      /config\.ai\.injection\.scanRetrieved, when set, must be a boolean/
    )
  })

  test('never inspects the classifier RETURN value at boot (that is the request-time gate)', ({
    assert,
  }) => {
    // A classifier that would throw or return garbage at request time is still a
    // well-typed function here, so boot accepts it; the fail posture is enforced by
    // enforceInjectionClassifier at request time, not by config validation.
    assert.doesNotThrow(() =>
      assertAiConfig(
        withInjection({
          classifier: () => {
            throw new Error('would throw at request time')
          },
        })
      )
    )
  })
})

test.group('assertAiConfig: the audit consumption block', () => {
  const withAudit = (audit: Record<string, unknown>): AiConfig =>
    ({ ...validClaudeOnly(), audit }) as unknown as AiConfig

  test('a valid audit block (authorizeAudit + anomaly + onAnomaly + verify) passes', ({
    assert,
  }) => {
    assert.doesNotThrow(() =>
      assertAiConfig(
        withAudit({
          enabled: true,
          authorizeAudit: () => true,
          onAnomaly: () => {},
          anomaly: { windowMs: 30_000, threshold: 50 },
          verify: { schedule: '0 3 * * *' },
        })
      )
    )
  })

  test('rejects a non-function authorizeAudit (boot fail-closed via guard.ai_config_invalid)', ({
    assert,
  }) => {
    assert.throws(
      () => assertAiConfig(withAudit({ authorizeAudit: 'yes' })),
      /config\.ai\.audit\.authorizeAudit, when set, must be a function/
    )
  })

  test('rejects a non-function onAnomaly and a non-object anomaly', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withAudit({ onAnomaly: 1 })),
      /config\.ai\.audit\.onAnomaly, when set, must be a function/
    )
    assert.throws(
      () => assertAiConfig(withAudit({ anomaly: 'x' })),
      /config\.ai\.audit\.anomaly, when set, must be an object/
    )
  })

  test('rejects non-positive-integer anomaly bounds', ({ assert }) => {
    assert.throws(
      () => assertAiConfig(withAudit({ anomaly: { windowMs: 0 } })),
      /config\.ai\.audit\.anomaly\.windowMs must be a positive integer/
    )
    assert.throws(
      () => assertAiConfig(withAudit({ anomaly: { threshold: -1 } })),
      /config\.ai\.audit\.anomaly\.threshold must be a positive integer/
    )
  })

  test('rejects an empty/non-string verify.schedule (a cron, never a source literal)', ({
    assert,
  }) => {
    assert.throws(
      () => assertAiConfig(withAudit({ verify: { schedule: '' } })),
      /config\.ai\.audit\.verify\.schedule, when set, must be a non-empty cron string/
    )
    assert.throws(
      () => assertAiConfig(withAudit({ verify: 'nope' })),
      /config\.ai\.audit\.verify, when set, must be an object/
    )
  })
})
