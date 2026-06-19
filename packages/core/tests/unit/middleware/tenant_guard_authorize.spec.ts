import { test } from '@japa/runner'
import TenantGuardMiddleware from '../../../src/middleware/tenant_guard_middleware.js'
import TenantAccessForbiddenException from '../../../src/exceptions/tenant_access_forbidden_exception.js'
import { createTestAuthzContext } from '../../../src/testing/authz_context.js'
import type { TenantAccessAuthorizer } from '../../../src/types/config.js'
import { setupTestConfig } from '../../helpers/config.js'

function makeCtx(overrides: Record<string, any> = {}, headers: Record<string, string> = {}) {
  const tenant = {
    id: 'tid',
    isActive: true,
    isSuspended: false,
    isProvisioning: false,
    isFailed: false,
    isDeleted: false,
    isMaintenance: false,
    maintenanceMessage: null,
    ...overrides,
  }
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    auth: { user: overrides.user ?? null },
    request: {
      url: () => '/tenant/foo',
      tenant: async () => tenant,
      header: (key: string) => lower[key.toLowerCase()] ?? null,
    },
  } as any
}

async function catchError(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return undefined
}

test.group('TenantGuardMiddleware authorizeTenantAccess', (group) => {
  group.each.setup(() => setupTestConfig())

  test('denies with 403 TenantAccessForbiddenException when the hook returns false', async ({
    assert,
  }) => {
    setupTestConfig({ authorizeTenantAccess: () => false })
    const m = new TenantGuardMiddleware()
    let nextCalled = false
    const err = await catchError(() =>
      m.handle(makeCtx(), async () => {
        nextCalled = true
      })
    )
    assert.instanceOf(err, TenantAccessForbiddenException)
    assert.isFalse(nextCalled)
  })

  test('allows the request through when the hook returns true', async ({ assert }) => {
    let authorizeCalled = false
    setupTestConfig({
      authorizeTenantAccess: () => {
        authorizeCalled = true
        return true
      },
    })
    const m = new TenantGuardMiddleware()
    let nextCalled = false
    // The hook returns true, so the guard moves past the gate. The happy path then
    // reaches container.make(CircuitBreakerService), which throws outside a booted
    // app, so assert we got past the gate (hook consulted, no 403 raised) rather
    // than that next() ran.
    const err = await catchError(() =>
      m.handle(makeCtx(), async () => {
        nextCalled = true
      })
    )
    assert.isTrue(authorizeCalled)
    assert.notInstanceOf(err, TenantAccessForbiddenException)
    if (err === undefined) assert.isTrue(nextCalled)
  })

  test('with no hook configured, a tenant-id swap is served (the documented IDOR boundary)', async ({
    assert,
  }) => {
    // Default config has no authorizeTenantAccess, so a caller resolving to a
    // tenant they do not own is not blocked by the package; resolution is
    // trust-the-input and authorization is the host's job. This is the boundary
    // the hook exists to let hosts close.
    setupTestConfig()
    const m = new TenantGuardMiddleware()
    let nextCalled = false
    const err = await catchError(() =>
      m.handle(makeCtx({ id: 'victim-tenant' }), async () => {
        nextCalled = true
      })
    )
    // The guard never authorized anything, so it cannot have denied with a 403.
    assert.notInstanceOf(err, TenantAccessForbiddenException)
    if (err === undefined) assert.isTrue(nextCalled)
  })

  test('the hook receives (ctx, tenant) and is awaited', async ({ assert }) => {
    let seenTenantId: string | undefined
    let seenAuthUser: unknown
    const authorize: TenantAccessAuthorizer = async (ctx, tenant) => {
      seenTenantId = tenant.id
      seenAuthUser = (ctx as any).auth?.user
      return true
    }
    setupTestConfig({ authorizeTenantAccess: authorize })
    const m = new TenantGuardMiddleware()
    // Swallow the downstream container.make throw; we only assert the hook ran.
    await catchError(() => m.handle(makeCtx({ user: { id: 'u1' } }), async () => {}))
    assert.equal(seenTenantId, 'tid')
    assert.deepEqual(seenAuthUser, { id: 'u1' })
  })

  test('an async hook that throws bubbles its own error, not a swallowed 403', async ({
    assert,
  }) => {
    setupTestConfig({
      authorizeTenantAccess: async () => {
        throw new Error('boom')
      },
    })
    const m = new TenantGuardMiddleware()
    const err = (await catchError(() => m.handle(makeCtx(), async () => {}))) as Error
    assert.notInstanceOf(err, TenantAccessForbiddenException)
    assert.equal(err.message, 'boom')
  })
})

test.group('createTestAuthzContext helper', () => {
  test('builds a usable ctx/tenant pair for an auth-based membership check', async ({ assert }) => {
    const authorize: TenantAccessAuthorizer = (ctx, tenant) =>
      (ctx as any).auth?.user?.tenantId === tenant.id

    const ok = createTestAuthzContext('tid', { user: { tenantId: 'tid' } })
    assert.equal(ok.tenant.id, 'tid')
    assert.isTrue(await authorize(ok.ctx, ok.tenant))

    const denied = createTestAuthzContext('tid', { user: { tenantId: 'other-tenant' } })
    assert.isFalse(await authorize(denied.ctx, denied.tenant))
  })

  test('exposes headers to a header-based authorizer (no longer always null)', async ({
    assert,
  }) => {
    const authorize: TenantAccessAuthorizer = (ctx, tenant) =>
      ctx.request.header('x-principal-tenant') === tenant.id

    const ok = createTestAuthzContext('tid', { headers: { 'x-principal-tenant': 'tid' } })
    assert.isTrue(await authorize(ok.ctx, ok.tenant))

    const denied = createTestAuthzContext('tid', { headers: { 'x-principal-tenant': 'other' } })
    assert.isFalse(await authorize(denied.ctx, denied.tenant))
  })

  test('defaults the auth user to null when none is supplied', async ({ assert }) => {
    const { ctx } = createTestAuthzContext('tid')
    assert.isNull((ctx as any).auth.user)
  })
})
