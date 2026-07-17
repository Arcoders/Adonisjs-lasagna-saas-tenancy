import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import { TenantAccessForbiddenException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import { authorizeAiAccess } from '../../../../src/gateway/access_gate.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The per-request AI membership gate (G4). Every denial is a 403
 * `TenantAccessForbiddenException` plus a `guard.ai_access` emission whose
 * metadata names WHY (denied, hook_error, no_gate), and a throwing hook is a
 * denial (fail-closed), never a 500.
 */

const tenant = { id: 'tenant-1' } as unknown as TenantModelContract
const ctx = {} as never
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function aiWith(overrides: Partial<AiConfig>): AiConfig {
  return { allowedProviders: ['claude'], ...overrides } as AiConfig
}

test.group('AI access gate', (group) => {
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

  test('a hook returning false denies with 403 and reason "denied"', async ({ assert }) => {
    let threw: unknown
    try {
      await authorizeAiAccess(ctx, tenant, aiWith({ authorizeAIAccess: () => false }))
    } catch (err) {
      threw = err
    }
    await settle()

    assert.instanceOf(threw, TenantAccessForbiddenException)
    assert.equal((threw as TenantAccessForbiddenException).status, 403)
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.id, 'guard.ai_access')
    assert.equal(captured[0]!.tenantId, 'tenant-1')
    assert.equal(captured[0]!.metadata.reason, 'denied')
  })

  test('an async hook resolving false denies the same way', async ({ assert }) => {
    let threw: unknown
    try {
      await authorizeAiAccess(ctx, tenant, aiWith({ authorizeAIAccess: async () => false }))
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, TenantAccessForbiddenException)
  })

  test('a THROWING hook is a fail-closed denial (403 with cause), never a 500', async ({
    assert,
  }) => {
    const backendDown = new Error('membership backend unreachable')
    let threw: unknown
    try {
      await authorizeAiAccess(
        ctx,
        tenant,
        aiWith({
          authorizeAIAccess: () => {
            throw backendDown
          },
        })
      )
    } catch (err) {
      threw = err
    }
    await settle()

    assert.instanceOf(threw, TenantAccessForbiddenException)
    assert.equal((threw as TenantAccessForbiddenException).status, 403)
    assert.equal((threw as Error).cause, backendDown)
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.metadata.reason, 'hook_error')
  })

  test('a hook returning true passes without emitting', async ({ assert }) => {
    await authorizeAiAccess(ctx, tenant, aiWith({ authorizeAIAccess: () => true }))
    await settle()
    assert.lengthOf(captured, 0)
  })

  test('no hook + explicit acknowledgement passes without emitting', async ({ assert }) => {
    await authorizeAiAccess(ctx, tenant, aiWith({ acknowledgeNoMembershipGate: true }))
    await settle()
    assert.lengthOf(captured, 0)
  })

  test('no hook and no acknowledgement denies (the mount-gate runtime backstop)', async ({
    assert,
  }) => {
    let threw: unknown
    try {
      await authorizeAiAccess(ctx, tenant, aiWith({}))
    } catch (err) {
      threw = err
    }
    await settle()

    assert.instanceOf(threw, TenantAccessForbiddenException)
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.metadata.reason, 'no_gate')
  })

  test('an absent ai block denies (nothing to authorize against)', async ({ assert }) => {
    let threw: unknown
    try {
      await authorizeAiAccess(ctx, tenant, undefined)
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, TenantAccessForbiddenException)
  })
})
