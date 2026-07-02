import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import type AiIdempotencyService from '../../../../src/gateway/idempotency.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * G7: an idempotent replay may only be shared within a known principal. A
 * request that presents an Idempotency-Key but resolves NO principal gets no
 * idempotency at all: the cache is neither read nor written, because a
 * principal-less cache slot would be shareable across unknown callers.
 */

const chatBody = { messages: [{ role: 'user', content: 'hola' }] }

function spyIdempotency() {
  const calls = { lookup: 0, save: 0 }
  const spy = {
    lookup: async () => {
      calls.lookup += 1
      return null
    },
    save: async () => {
      calls.save += 1
    },
    bumpEpoch: async () => {},
    entryKey: () => 'unused',
  } as unknown as AiIdempotencyService
  return { spy, calls }
}

function buildController(config: AiConfig, idempotency: AiIdempotencyService) {
  const { svc } = makeService()
  const registry = new AIProviderRegistry()
  registry.register(new MockAIProvider({ name: 'claude', contractVersion: 1 }), {
    activate: true,
  })
  return new AiChatController({
    stream: svc,
    registry,
    idempotency,
    liveness: new TenantLivenessWatcher(),
    config,
  })
}

const baseConfig = { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig

test.group('chat controller principal-gated idempotency', () => {
  test('a key with NO principal (no auth, no hook) touches the cache not at all', async ({
    assert,
  }) => {
    const { spy, calls } = spyIdempotency()
    const controller = buildController(baseConfig, spy)
    const { ctx, res } = fakeHttpContext({
      tenant: fakeTenant,
      body: chatBody,
      headers: { 'idempotency-key': 'retry-1' },
    })

    await controller.chat(ctx)

    assert.isTrue(res.ended, 'the stream itself still runs normally')
    assert.equal(calls.lookup, 0)
    assert.equal(calls.save, 0)
  })

  test('a resolvePrincipal hook returning null disables idempotency the same way', async ({
    assert,
  }) => {
    const { spy, calls } = spyIdempotency()
    const controller = buildController(
      { ...baseConfig, resolvePrincipal: () => null } as AiConfig,
      spy
    )
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: chatBody,
      headers: { 'idempotency-key': 'retry-1' },
      auth: { user: { id: 'ignored-by-hook' } },
    })

    await controller.chat(ctx)

    assert.equal(calls.lookup, 0)
    assert.equal(calls.save, 0)
  })

  test('control: a resolvable principal turns the cache on', async ({ assert }) => {
    const { spy, calls } = spyIdempotency()
    const controller = buildController(baseConfig, spy)
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: chatBody,
      headers: { 'idempotency-key': 'retry-1' },
      auth: { user: { id: 'u1' } },
    })

    await controller.chat(ctx)

    assert.equal(calls.lookup, 1)
    assert.equal(calls.save, 1)
  })

  test('no header means no cache traffic even WITH a principal', async ({ assert }) => {
    const { spy, calls } = spyIdempotency()
    const controller = buildController(baseConfig, spy)
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: chatBody,
      auth: { user: { id: 'u1' } },
    })

    await controller.chat(ctx)

    assert.equal(calls.lookup, 0)
    assert.equal(calls.save, 0)
  })
})
