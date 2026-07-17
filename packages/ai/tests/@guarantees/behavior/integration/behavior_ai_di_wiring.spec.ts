import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { TenantSuspended } from '@adonisjs-lasagna/saas-tenancy/events'
import AiProvider from '../../../../providers/ai_provider.js'
import StreamExtensionService from '../../../../src/gateway/stream_extension.js'
import VectorStoreService from '../../../../src/services/vector_store_service.js'
import AiAuditWriter from '../../../../src/services/ai_audit_writer.js'
import {
  PgChatAuditSink,
  PgEmbeddingAuditSink,
  PgRetrievalAuditSink,
} from '../../../../src/gateway/audit_sinks.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import AiComplianceService from '../../../../src/services/ai_compliance_service.js'
import TenantLivenessWatcher, {
  wireAiTenantLiveness,
} from '../../../../src/services/tenant_liveness_watcher.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import EmbeddingProviderRegistry from '../../../../src/services/embedding_provider_registry.js'
import MockEmbeddingProvider from '../../../../src/testing/mock_embedding_provider.js'
import OpenAICompatibleEmbeddingProvider from '../../../../src/providers/openai_compatible_embedding_provider.js'

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
    new AiProvider(app).register?.()

    const service = await app.container.make(StreamExtensionService)
    assert.instanceOf(service, StreamExtensionService)

    const registry = await app.container.make(AIProviderRegistry)
    registry.register(new MockAIProvider({ name: 'claude', contractVersion: 2 }))
    assert.isTrue(registry.has('claude'))
  })

  test('the embedding-provider registry binds as a singleton, defaults to the configured provider, and honours a host override (2A)', async ({
    assert,
  }) => {
    new AiProvider(app).register?.()
    const reg = await app.container.make(EmbeddingProviderRegistry)
    assert.instanceOf(reg, EmbeddingProviderRegistry)

    const cfg = {
      provider: 'openai-compatible',
      baseUrl: 'https://embeddings.example',
      dimension: 8,
    } as never
    try {
      // Default: no host override -> the configured OpenAI-compatible backend,
      // byte-identical to the pre-seam inline construction.
      assert.isFalse(reg.has())
      assert.instanceOf(reg.resolve(cfg), OpenAICompatibleEmbeddingProvider)

      // Override: a host registers its own (e.g. the offline mock for e2e) and it
      // supersedes the default. The ingestion/retrieval singletons resolve this
      // registry at make-time, so a boot-time host registration is always in force.
      const mock = new MockEmbeddingProvider({ dimension: 8 })
      reg.register(mock)
      assert.isTrue(reg.has())
      assert.strictEqual(
        reg.resolve(cfg),
        mock,
        'the host override supersedes the configured default'
      )
    } finally {
      reg.clear()
    }
  })

  test('registers a resolvable VectorStoreService (driver + lucid.db + tenancy scope seal)', async ({
    assert,
  }) => {
    new AiProvider(app).register?.()
    // Resolving proves getActiveDriver, the `lucid.db` container alias, and the
    // tenancy scope accessor are all makeable from the real booted container (the
    // DI a unit test with a fake db cannot cover).
    const store = await app.container.make(VectorStoreService)
    assert.instanceOf(store, VectorStoreService)
  })

  test('registers a resolvable AiAuditWriter and the three audit sinks (WS-AI-7)', async ({
    assert,
  }) => {
    new AiProvider(app).register?.()
    // Audit is on by default, so the writer + the three sinks bind and resolve
    // against the real container (the writer's backoffice connection + tenancy
    // scope seam are makeable; the sinks resolve the writer).
    const writer = await app.container.make(AiAuditWriter)
    assert.instanceOf(writer, AiAuditWriter)
    assert.instanceOf(await app.container.make(PgChatAuditSink), PgChatAuditSink)
    assert.instanceOf(await app.container.make(PgEmbeddingAuditSink), PgEmbeddingAuditSink)
    assert.instanceOf(await app.container.make(PgRetrievalAuditSink), PgRetrievalAuditSink)
  })

  test('registers a resolvable AiComplianceService (WS-AI-9 purge orchestrator)', async ({
    assert,
  }) => {
    new AiProvider(app).register?.()
    // Resolving proves its memory + vector + idempotency seams, the kernel audit
    // logger, tenancy.run and the redis lock are all makeable from the real
    // container (the DI a unit test with fakes cannot cover).
    const compliance = await app.container.make(AiComplianceService)
    assert.instanceOf(compliance, AiComplianceService)
  })

  test('the liveness watcher resolves and a real TenantSuspended dispatch aborts its signals', async ({
    assert,
  }) => {
    new AiProvider(app).register?.()

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
