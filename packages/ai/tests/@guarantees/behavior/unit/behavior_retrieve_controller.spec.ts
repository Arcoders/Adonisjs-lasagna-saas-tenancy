import { test } from '@japa/runner'
import AiRetrieveController from '../../../../src/gateway/ai_retrieve_controller.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type RetrievalService from '../../../../src/services/retrieval_service.js'
import type { RetrievalRequest, RetrievalResult } from '../../../../src/services/retrieval_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The /ai/retrieve controller happy + error behavior: it resolves the document
 * ACL scope, validates the body, and returns the matches as JSON. A retrieval
 * failure maps to the AIException's pinned HTTP status.
 */
const matches = [
  { id: 'm1', content: 'nearest', metadata: { a: 1 }, distance: 0.1 },
  { id: 'm2', content: 'next', metadata: { a: 2 }, distance: 0.4 },
]

function capturingRetrieval(
  result: RetrievalResult = { matches, model: 'text-embed', tokens: 5 }
): { service: RetrievalService; requests: RetrievalRequest[] } {
  const requests: RetrievalRequest[] = []
  const service = {
    providerFingerprint: 'fp',
    async retrieve(_tenant: unknown, request: RetrievalRequest) {
      requests.push(request)
      return result
    },
  } as unknown as RetrievalService
  return { service, requests }
}

function build(over: Partial<AiConfig>, service: RetrievalService) {
  return new AiRetrieveController({
    retrieval: service,
    liveness: new TenantLivenessWatcher(),
    config: { allowedProviders: ['claude'], authorizeAIAccess: () => true, ...over } as AiConfig,
  })
}

test.group('AiRetrieveController behavior', () => {
  test('returns the matches as JSON with a 200', async ({ assert }) => {
    const { service } = capturingRetrieval()
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: 'refund policy' },
      auth: { user: { id: 'u1' } },
    })
    await build({}, service).retrieve(ctx)
    assert.equal(responseFacade.sentStatus, 200)
    assert.deepEqual(responseFacade.sentBody, { matches })
  })

  test('passes the retrievalFilter scope through to the service, and clamps the limit', async ({
    assert,
  }) => {
    const { service, requests } = capturingRetrieval()
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: 'refund policy', limit: 999 },
      auth: { user: { id: 'u1' } },
    })
    await build(
      {
        retrieval: {
          maxLimit: 25,
          retrievalFilter: () => ({ kind: 'sources', sources: ['kb-1'] }),
        },
      },
      service
    ).retrieve(ctx)
    assert.lengthOf(requests, 1)
    assert.deepEqual(requests[0].scope, { kind: 'sources', sources: ['kb-1'] })
    assert.equal(requests[0].limit, 25, 'a requested limit over maxLimit is clamped')
    assert.equal(requests[0].query, 'refund policy')
  })

  test('a missing query is a 400 before any retrieval', async ({ assert }) => {
    const { service, requests } = capturingRetrieval()
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: {}, auth: { user: { id: 'u1' } } })
    await assert.rejects(() => build({}, service).retrieve(ctx), /query must be a non-empty string/)
    assert.lengthOf(requests, 0)
  })

  test('a retrieval AIException maps to its pinned status and { error: code } body', async ({
    assert,
  }) => {
    const service = {
      providerFingerprint: 'fp',
      async retrieve() {
        throw new AIException('over_budget', 'the ai cost governor rejected the reservation')
      },
    } as unknown as RetrievalService
    const { ctx, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: { query: 'refund policy' },
      auth: { user: { id: 'u1' } },
    })
    await build({}, service).retrieve(ctx)
    assert.equal(responseFacade.sentStatus, 402)
    assert.deepEqual(responseFacade.sentBody, { error: 'over_budget' })
  })
})
