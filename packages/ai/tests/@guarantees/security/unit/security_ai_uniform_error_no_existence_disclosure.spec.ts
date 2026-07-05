import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { TenantAccessForbiddenException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import { authorizeAiAccess, resolveRequestTenant } from '../../../../src/gateway/access_gate.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * WS-AI-8 / T5 — vector #17 (cross-tenant existence disclosure / side channel).
 * A caller must not be able to tell "this tenant does not exist / is not resolvable"
 * apart from "this tenant exists but you are not a member": both must be the SAME
 * uniform 403 with the SAME message, and neither may echo the tenant id. Otherwise an
 * attacker probes which tenant ids are real. This pins the uniform-error mitigation the
 * ARCHITECTURE claims for #17.
 */

const SECRET_TENANT_ID = 'acme-prod-7f3a1c'
const tenant = { id: SECRET_TENANT_ID } as unknown as TenantModelContract
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function aiWith(overrides: Partial<AiConfig>): AiConfig {
  return { allowedProviders: ['claude'], ...overrides } as AiConfig
}

/** A ctx whose `request.tenant()` resolves to null (a non-existent / unresolvable tenant). */
const ctxNoTenant = { request: { tenant: async () => null } } as never
const ctxAny = {} as never

async function capture<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (err) {
    return err
  }
}

test.group('AI uniform error — no cross-tenant existence disclosure (#17)', (group) => {
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

  test('a non-existent tenant and an unauthorized tenant fail identically (same class, status, message)', async ({
    assert,
  }) => {
    // Non-existent / unresolvable tenant: request.tenant() yields null.
    const nonExistent = await capture(() => resolveRequestTenant(ctxNoTenant))
    // Existent tenant, but the membership hook denies.
    const unauthorized = await capture(() =>
      authorizeAiAccess(ctxAny, tenant, aiWith({ authorizeAIAccess: () => false }))
    )
    await settle()

    assert.instanceOf(nonExistent, TenantAccessForbiddenException)
    assert.instanceOf(unauthorized, TenantAccessForbiddenException)

    const a = nonExistent as TenantAccessForbiddenException
    const b = unauthorized as TenantAccessForbiddenException

    // Uniform status and message: an attacker cannot distinguish the two cases.
    assert.equal(a.status, 403)
    assert.equal(b.status, 403)
    assert.equal(a.status, b.status)
    assert.equal(a.message, b.message)
    assert.equal(a.code, b.code)
  })

  test('the forbidden message never echoes the tenant id or a "not found" tell', async ({
    assert,
  }) => {
    const nonExistent = (await capture(() =>
      resolveRequestTenant(ctxNoTenant)
    )) as TenantAccessForbiddenException
    const unauthorized = (await capture(() =>
      authorizeAiAccess(ctxAny, tenant, aiWith({ authorizeAIAccess: () => false }))
    )) as TenantAccessForbiddenException
    await settle()

    for (const message of [nonExistent.message, unauthorized.message]) {
      assert.notInclude(
        message,
        SECRET_TENANT_ID,
        'the tenant id must not leak into the error message'
      )
      assert.notMatch(
        message,
        /not\s+found|does\s+not\s+exist|no\s+such\s+tenant/i,
        'an existence tell (not found / does not exist) discloses which tenant ids are real'
      )
    }
  })
})
