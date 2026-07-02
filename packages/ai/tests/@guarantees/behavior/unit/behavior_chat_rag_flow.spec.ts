import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
} from '../../../../src/gateway/idempotency.js'
import type RetrievalService from '../../../../src/services/retrieval_service.js'
import type { RetrievalResult } from '../../../../src/services/retrieval_service.js'
import type {
  AiRetrievalAuditEvent,
  AiRetrievalAuditSink,
} from '../../../../src/gateway/audit_seam.js'
import { FakeQuota, makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'
import type { AIMessage, AIProviderContract } from '../../../../src/types/ai_provider_contract.js'

/**
 * RAG into /ai/chat (WS-AI-5): a `retrieve` ask embeds the query, searches under
 * the document ACL, and folds the fenced matches into the context as a user turn
 * right before the question, then streams as usual. Non-RAG chat is untouched;
 * asking to retrieve with embeddings unconfigured is a 400.
 */

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

function fakeRetrieval(
  result: RetrievalResult = { matches: [], model: 'text-embed', tokens: 3 }
): { service: RetrievalService; box: { calls: number } } {
  const box = { calls: 0 }
  const service = {
    providerFingerprint: 'fp',
    async retrieve() {
      box.calls += 1
      return result
    },
  } as unknown as RetrievalService
  return { service, box }
}

function capturingRetrievalAudit(): { sink: AiRetrievalAuditSink; events: AiRetrievalAuditEvent[] } {
  const events: AiRetrievalAuditEvent[] = []
  return { sink: { append: (e) => void events.push(e) }, events }
}

function build(opts: {
  retrieval?: RetrievalService
  config?: Partial<AiConfig>
  audit?: AiRetrievalAuditSink
}) {
  const { svc } = makeService(new FakeQuota())
  const { provider, seen } = capturingProvider()
  const registry = new AIProviderRegistry()
  registry.register(provider, { activate: true })
  const controller = new AiChatController({
    stream: svc,
    registry,
    idempotency: new AiIdempotencyService({
      store: { async get() {}, async set() {} },
      macKey: deriveAiIdempotencyMacKey('test-app-key'),
    }),
    liveness: new TenantLivenessWatcher(),
    retrieval: opts.retrieval,
    retrievalAudit: opts.audit,
    config: {
      allowedProviders: ['claude'],
      authorizeAIAccess: () => true,
      ...opts.config,
    } as AiConfig,
  })
  return { controller, seen }
}

test.group('chat RAG flow', () => {
  test('folds retrieved matches into a user turn right before the question', async ({ assert }) => {
    const { service } = fakeRetrieval({
      matches: [{ id: 'd1', content: 'REFUNDS ARE 30 DAYS', metadata: {}, distance: 0.1 }],
      model: 'text-embed',
      tokens: 4,
    })
    const audit = capturingRetrievalAudit()
    const { controller, seen } = build({ retrieval: service, audit: audit.sink })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: {
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'what is the refund policy?' },
        ],
        retrieve: { query: 'refunds' },
      },
    })

    await controller.chat(ctx)

    assert.lengthOf(seen, 1, 'the provider was called once')
    const messages = seen[0]
    assert.lengthOf(messages, 3, 'system + retrieved block + user question')
    assert.equal(messages[0].role, 'system')
    assert.equal(messages[1].role, 'user', 'the retrieved block is a user turn')
    assert.include(messages[1].content, 'REFUNDS ARE 30 DAYS')
    assert.match(messages[1].content, /<retrieved_context index="1">/)
    assert.equal(messages[2].content, 'what is the refund policy?', 'the question stays last')

    assert.lengthOf(audit.events, 1)
    assert.equal(audit.events[0].outcome, 'completed')
    assert.equal(audit.events[0].matchCount, 1)
  })

  test('no retrieve field: messages pass through unchanged and retrieval is never called', async ({
    assert,
  }) => {
    const { service, box } = fakeRetrieval()
    const { controller, seen } = build({ retrieval: service })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'plain question' }] },
    })

    await controller.chat(ctx)

    assert.deepEqual(seen[0], [{ role: 'user', content: 'plain question' }])
    assert.equal(box.calls, 0)
  })

  test('a retrieve request with embeddings unconfigured is a 400 before any stream', async ({
    assert,
  }) => {
    // No retrieval service injected (mirrors the route not resolving it when
    // config.ai.embedding is absent).
    const { controller, seen } = build({ retrieval: undefined })
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'q' }], retrieve: { query: 'x' } },
    })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 400)
    assert.deepEqual(responseFacade.sentBody, { error: 'invalid_request' })
    assert.lengthOf(seen, 0, 'the provider is never reached')
  })

  test('no matches: the messages are unchanged (nothing to inject)', async ({ assert }) => {
    const { service } = fakeRetrieval({ matches: [], model: 'text-embed', tokens: 2 })
    const { controller, seen } = build({ retrieval: service })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'q' }], retrieve: { query: 'x' } },
    })

    await controller.chat(ctx)
    assert.deepEqual(seen[0], [{ role: 'user', content: 'q' }])
  })
})
