import { test } from '@japa/runner'
import AiRetrieveController from '../../../../src/gateway/ai_retrieve_controller.js'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
} from '../../../../src/gateway/idempotency.js'
import type RetrievalService from '../../../../src/services/retrieval_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { FakeQuota, makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AiConfig } from '../../../../src/define_config.js'
import type { AIMessage, AIProviderContract } from '../../../../src/types/ai_provider_contract.js'

/**
 * The fail-closed retrieval default (WS-AI-5, G2), mirroring the G4 mount gate.
 * With embeddings configured but NO `retrievalFilter` wired and NO
 * `acknowledgeUnscopedRetrieval`, BOTH retrieval entry points refuse with a 403
 * `retrieval_denied` and a `guard.ai_retrieval_denied` `{reason:
 * 'unscoped_unacknowledged'}` trip, before any reservation or query embed: a host
 * that never made the scoping decision cannot silently serve the whole corpus.
 */

const UNSCOPED = { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig

function retrievalSpy(): { service: RetrievalService; state: { calls: number } } {
  const state = { calls: 0 }
  const service = {
    providerFingerprint: 'fp',
    async retrieve() {
      state.calls += 1
      return { matches: [], model: 'm', tokens: 0 }
    },
  } as unknown as RetrievalService
  return { service, state }
}

function capturingProvider(): { provider: AIProviderContract; seen: AIMessage[][] } {
  const seen: AIMessage[][] = []
  const provider: AIProviderContract = {
    name: 'claude',
    contractVersion: 1,
    capabilities: { streaming: true },
    async verifyConfig() {},
    async *stream(request) {
      seen.push(request.messages.map((m) => ({ ...m })))
      yield { data: 'answer', tokens: 1 }
    },
  }
  return { provider, seen }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test.group('retrieval fail-closed default', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('/ai/retrieve refuses (403 retrieval_denied) and spends nothing', async ({ assert }) => {
    const { service, state } = retrievalSpy()
    const controller = new AiRetrieveController({
      retrieval: service,
      liveness: new TenantLivenessWatcher(),
      config: UNSCOPED,
    })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: 'refund policy' },
      auth: { user: { id: 'u1' } },
    })

    let threw: unknown
    try {
      await controller.retrieve(ctx)
    } catch (err) {
      threw = err
    }
    await settle()

    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'retrieval_denied')
    assert.equal((threw as AIException).httpStatus, 403)
    assert.equal(state.calls, 0, 'a refused retrieval never reaches the reserve/embed machine')
    assert.lengthOf(captured, 1)
    assert.equal(captured[0].id, 'guard.ai_retrieval_denied')
    assert.equal(captured[0].metadata.reason, 'unscoped_unacknowledged')
  })

  test('RAG-in-chat refuses (403 retrieval_denied) before the provider is reached', async ({
    assert,
  }) => {
    const { svc } = makeService(new FakeQuota())
    const { provider, seen } = capturingProvider()
    const registry = new AIProviderRegistry()
    registry.register(provider, { activate: true })
    const { service, state } = retrievalSpy()
    const controller = new AiChatController({
      stream: svc,
      registry,
      idempotency: new AiIdempotencyService({
        store: { async get() {}, async set() {} },
        macKey: deriveAiIdempotencyMacKey('test-app-key'),
      }),
      liveness: new TenantLivenessWatcher(),
      retrieval: service,
      config: UNSCOPED,
    })
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'q' }], retrieve: { query: 'x' } },
    })

    await controller.chat(ctx)
    await settle()

    assert.equal(responseFacade.sentStatus, 403)
    assert.deepEqual(responseFacade.sentBody, { error: 'retrieval_denied' })
    assert.lengthOf(seen, 0, 'the provider is never reached')
    assert.equal(state.calls, 0, 'the retrieval service is never called')
    assert.lengthOf(captured, 1)
    assert.equal(captured[0].id, 'guard.ai_retrieval_denied')
    assert.equal(captured[0].metadata.reason, 'unscoped_unacknowledged')
  })
})
