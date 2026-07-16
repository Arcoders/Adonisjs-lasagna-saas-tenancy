import { test } from '@japa/runner'
import AiChatController from '../../../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
} from '../../../../src/gateway/idempotency.js'
import {
  hashAuditPrincipal,
  type AiGatewayAuditEvent,
  type AiGatewayAuditSink,
} from '../../../../src/gateway/audit_seam.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { makeService, fakeTenant } from '../../../helpers/stream_doubles.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The G1 forward contract on the WS-AI-7 audit seam: the event field set is
 * pinned EXACTLY (a new field is a reviewed decision, and content can never
 * slip in silently), the principal is one-way hashed, and no prompt or
 * response text appears anywhere in a serialized event.
 */

const PINNED_FIELDS = [
  'fragments',
  'idempotentReplay',
  'model',
  'occurredAt',
  'outcome',
  'principalHash',
  'provider',
  'reason',
  'tenantId',
  'tokensSettled',
]

const PROMPT = 'the-secret-prompt-text'
const COMPLETION = 'the-secret-completion-text'

function capturingSink() {
  const events: AiGatewayAuditEvent[] = []
  const sink: AiGatewayAuditSink = {
    append: (event) => {
      events.push(event)
    },
  }
  return { sink, events }
}

function buildController(sink: AiGatewayAuditSink) {
  const { svc } = makeService()
  const registry = new AIProviderRegistry()
  registry.register(
    new MockAIProvider({
      name: 'claude',
      contractVersion: 2,
      fragments: [{ data: COMPLETION, tokens: 4 }],
    }),
    { activate: true }
  )
  return new AiChatController({
    stream: svc,
    registry,
    idempotency: new AiIdempotencyService({
      store: { get: async () => undefined, set: async () => {} },
      macKey: deriveAiIdempotencyMacKey('test-app-key'),
    }),
    liveness: new TenantLivenessWatcher(),
    config: { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
    audit: sink,
  })
}

test.group('audit seam non-PII contract', () => {
  test('a completed stream lands exactly one event with the pinned field set', async ({
    assert,
  }) => {
    const { sink, events } = capturingSink()
    const controller = buildController(sink)
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: PROMPT }] },
      auth: { user: { id: 'user-1' } },
    })

    await controller.chat(ctx)

    assert.lengthOf(events, 1)
    assert.deepEqual(
      Object.keys(events[0]).sort(),
      PINNED_FIELDS,
      'the audit event field set is FROZEN; extending it is a reviewed WS-AI-7 decision'
    )
    assert.equal(events[0].outcome, 'completed')
    assert.equal(events[0].tenantId, 't1')
    assert.equal(events[0].provider, 'claude')
    assert.equal(events[0].tokensSettled, 4)
    assert.isFalse(events[0].idempotentReplay)
  })

  test('the principal is one-way hashed, never raw', async ({ assert }) => {
    const { sink, events } = capturingSink()
    const controller = buildController(sink)
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: PROMPT }] },
      auth: { user: { id: 'user-1' } },
    })

    await controller.chat(ctx)

    assert.equal(events[0].principalHash, hashAuditPrincipal('user-1'))
    assert.match(events[0].principalHash!, /^[0-9a-f]{64}$/)
    assert.notInclude(JSON.stringify(events[0]), 'user-1')
  })

  test('no prompt or completion content ever reaches the event', async ({ assert }) => {
    const { sink, events } = capturingSink()
    const controller = buildController(sink)
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: PROMPT }] },
    })

    await controller.chat(ctx)

    const serialized = JSON.stringify(events)
    assert.notInclude(serialized, PROMPT)
    assert.notInclude(serialized, COMPLETION)
  })

  test('an anonymous request lands a null principalHash (not an empty hash)', async ({
    assert,
  }) => {
    const { sink, events } = capturingSink()
    const controller = buildController(sink)
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { messages: [{ role: 'user', content: PROMPT }] },
    })

    await controller.chat(ctx)

    assert.isNull(events[0].principalHash)
    assert.isNull(hashAuditPrincipal(null))
  })
})
