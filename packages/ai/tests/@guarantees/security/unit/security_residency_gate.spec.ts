import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  enforceChatResidency,
  enforceEmbeddingResidency,
} from '../../../../src/services/residency_gate.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  snapshotAiGuardCounters,
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * WS-AI-9 residency / no-train gate (#7/#15, E7/E8/E17): request-time enforcement
 * on chat provider selection AND embedding egress, fail-closed on a bad resolver,
 * emitting `guard.ai_residency_denied`. `local-only` refuses any non-loopback
 * endpoint; an explicit `allowedProviders` posture narrows chat providers only.
 */

const tenant = { id: 'tenant-r' } as unknown as TenantModelContract
const cfg = (over: Partial<AiConfig>): AiConfig =>
  ({ allowedProviders: ['claude'], ...over }) as AiConfig

async function assertResidencyDenied(fn: () => Promise<void>) {
  let threw: unknown
  try {
    await fn()
  } catch (e) {
    threw = e
  }
  if (!(threw instanceof AIException) || threw.aiCode !== 'residency_denied') {
    throw new Error(`expected residency_denied, got ${String(threw)}`)
  }
}

test.group('security — residency gate (WS-AI-9)', (group) => {
  group.each.setup(() => {
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async () => {})
  })
  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('local-only refuses a remote chat provider and emits the guard', async ({ assert }) => {
    const ai = cfg({ residency: () => ({ mode: 'local-only' }), claude: { apiKey: 'k' } })
    await assertResidencyDenied(() => enforceChatResidency(tenant, 'claude', ai))
    assert.include(
      snapshotAiGuardCounters().rejected.map((r) => r.id),
      'guard.ai_residency_denied'
    )
  })

  test('local-only allows a loopback chat provider', async ({ assert }) => {
    const ai = cfg({
      residency: () => ({ mode: 'local-only' }),
      claude: { apiKey: 'k', baseUrl: 'https://127.0.0.1:8443' },
    })
    await enforceChatResidency(tenant, 'claude', ai)
    assert.isEmpty(snapshotAiGuardCounters().rejected)
  })

  test('an allowedProviders posture refuses a provider outside the list', async () => {
    const ai = cfg({ residency: () => ({ allowedProviders: ['claude'] }) })
    await enforceChatResidency(tenant, 'claude', ai) // in the list: allowed
    await assertResidencyDenied(() => enforceChatResidency(tenant, 'deepseek', ai))
  })

  test('a resolver that throws is fail-closed (E8)', async () => {
    const ai = cfg({
      residency: () => {
        throw new Error('residency backend down')
      },
    })
    await assertResidencyDenied(() => enforceChatResidency(tenant, 'claude', ai))
  })

  test('a malformed resolver return is fail-closed (E8)', async () => {
    const ai = cfg({ residency: () => 42 as never })
    await assertResidencyDenied(() => enforceChatResidency(tenant, 'claude', ai))
  })

  test('an absent residency resolver is unconstrained', async ({ assert }) => {
    await enforceChatResidency(tenant, 'claude', cfg({}))
    await enforceEmbeddingResidency(
      tenant,
      cfg({ embedding: { apiKey: 'k', baseUrl: 'https://api.x' } as never })
    )
    assert.isEmpty(snapshotAiGuardCounters().rejected)
  })

  test('local-only refuses a remote embedding backend (E7)', async () => {
    const ai = cfg({
      residency: () => ({ mode: 'local-only' }),
      embedding: { apiKey: 'k', baseUrl: 'https://api.openai.com/v1' } as never,
    })
    await assertResidencyDenied(() => enforceEmbeddingResidency(tenant, ai))
  })

  test('local-only allows a loopback embedding backend', async ({ assert }) => {
    const ai = cfg({
      residency: () => ({ mode: 'local-only' }),
      embedding: { apiKey: 'k', baseUrl: 'http://localhost:11434/v1' } as never,
    })
    await enforceEmbeddingResidency(tenant, ai)
    assert.isEmpty(snapshotAiGuardCounters().rejected)
  })

  test('an allowedProviders posture does not narrow the deploy-global embedding backend (honest limit)', async ({
    assert,
  }) => {
    const ai = cfg({
      residency: () => ({ allowedProviders: ['claude'] }),
      embedding: { apiKey: 'k', baseUrl: 'https://api.openai.com/v1' } as never,
    })
    await enforceEmbeddingResidency(tenant, ai)
    assert.isEmpty(snapshotAiGuardCounters().rejected)
  })
})
