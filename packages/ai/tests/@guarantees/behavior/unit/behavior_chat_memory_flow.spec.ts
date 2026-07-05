import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../../../../src/gateway/idempotency.js'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { FakeQuota, makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { FakeRedisLists } from '../../../helpers/fake_redis_lists.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The conversation-memory flow through the real chat controller (WS-AI-4): turn 1
 * mints a session and hands back X-Ai-Session, the completed exchange is
 * persisted, turn 2's token replays the prior turns into the provider context, a
 * forged token is a 400 before any cost, and an idempotent replay re-emits the
 * minted session so a dropped turn-1 is not lost.
 */

function mapStore(): { store: AiIdempotencyStore; data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    store: {
      async get(tenantId, key) {
        return data.get(`${tenantId}|${key}`)
      },
      async set(tenantId, key, value) {
        data.set(`${tenantId}|${key}`, value)
      },
    },
  }
}

function buildDeps(redis: FakeRedisLists, store?: AiIdempotencyStore) {
  const quota = new FakeQuota()
  const { svc } = makeService(quota)
  const provider = new MockAIProvider({
    name: 'claude',
    contractVersion: 1,
    fragments: [{ data: 'hi', tokens: 1 }],
  })
  const registry = new AIProviderRegistry()
  registry.register(provider, { activate: true })
  const config = {
    allowedProviders: ['claude'],
    authorizeAIAccess: () => true,
    memory: { maxTurns: 5, ttlMs: 60_000 },
  } as AiConfig
  const idempotency = new AiIdempotencyService({
    store: store ?? mapStore().store,
    macKey: deriveAiIdempotencyMacKey('test-app-key'),
  })
  const memory = new ConversationMemoryService({
    getRedis: async () => redis,
    macKey: Buffer.alloc(32, 4),
    encryptMemory: (plain) => `e:${plain}`,
    decryptMemory: (cipher) => {
      if (!cipher.startsWith('e:')) throw new Error('not ciphertext')
      return cipher.slice(2)
    },
    config: { maxTurns: 5, ttlMs: 60_000 },
  })
  const controller = new AiChatController({
    stream: svc,
    registry,
    idempotency,
    liveness: new TenantLivenessWatcher(),
    config,
    memory,
  })
  return { controller, provider }
}

const auth = { user: { id: 'u1' } }

test.group('chat controller — conversation memory flow', () => {
  test('turn 1 mints X-Ai-Session and turn 2 replays the prior exchange into the context', async ({
    assert,
  }) => {
    const { controller, provider } = buildDeps(new FakeRedisLists())

    const t1 = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'first' }] },
      auth,
    })
    await controller.chat(t1.ctx)

    const token = t1.res.headers['x-ai-session']
    assert.isString(token, 'turn 1 hands back a session token')
    assert.deepEqual(provider.calls[0].request.messages, [{ role: 'user', content: 'first' }])

    const t2 = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'second' }], sessionId: token },
      auth,
    })
    await controller.chat(t2.ctx)

    assert.deepEqual(
      provider.calls[1].request.messages,
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'second' },
      ],
      'the prior exchange is replayed as user/assistant data before the new turn'
    )
  })

  test('no principal ⇒ no session, no X-Ai-Session (memory inert)', async ({ assert }) => {
    const { controller } = buildDeps(new FakeRedisLists())
    const t = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      // no auth => no resolvable principal
    })
    await controller.chat(t.ctx)
    assert.isUndefined(t.res.headers['x-ai-session'])
  })

  test('a forged session token is a 400 memory_session_invalid before any provider call', async ({
    assert,
  }) => {
    const { controller, provider } = buildDeps(new FakeRedisLists())
    const t = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'hi' }], sessionId: 'forged.token' },
      auth,
    })
    await controller.chat(t.ctx)

    assert.equal(t.responseFacade.sentStatus, 400)
    assert.deepEqual(t.responseFacade.sentBody, { error: 'memory_session_invalid' })
    assert.lengthOf(provider.calls, 0, 'a forged token spends nothing')
  })

  test('an idempotent replay re-emits the minted X-Ai-Session (a dropped turn-1 is not lost)', async ({
    assert,
  }) => {
    const shared = mapStore()
    const { controller, provider } = buildDeps(new FakeRedisLists(), shared.store)
    const options = {
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'idempotency-key': 'retry-mem' },
      auth,
    }

    const first = fakeHttpContext(options)
    await controller.chat(first.ctx)
    const token = first.res.headers['x-ai-session']
    assert.isString(token)

    const second = fakeHttpContext(options)
    await controller.chat(second.ctx)

    assert.lengthOf(provider.calls, 1, 'the replay does not call the provider')
    assert.equal(second.res.headers['x-ai-idempotent-replay'], '1')
    assert.equal(second.res.headers['x-ai-session'], token, 'the replay re-emits the same session')
  })
})
