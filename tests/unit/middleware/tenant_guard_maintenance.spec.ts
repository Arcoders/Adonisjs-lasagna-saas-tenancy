import { test } from '@japa/runner'
import TenantGuardMiddleware from '../../../src/middleware/tenant_guard_middleware.js'
import TenantMaintenanceException from '../../../src/exceptions/tenant_maintenance_exception.js'
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

test.group('TenantGuardMiddleware — maintenance mode', (group) => {
  group.each.setup(() => setupTestConfig())

  test('throws TenantMaintenanceException when isMaintenance is true', async ({ assert }) => {
    setupTestConfig({ maintenance: { retryAfterSeconds: 120, defaultMessage: 'See you soon' } })
    const m = new TenantGuardMiddleware()
    const err = (await catchError(() =>
      m.handle(makeCtx({ isMaintenance: true }), async () => {})
    )) as TenantMaintenanceException
    assert.instanceOf(err, TenantMaintenanceException)
    assert.equal(err.retryAfterSeconds, 120)
    assert.equal(err.tenantMessage, 'See you soon')
  })

  test('falls back to a default Retry-After when not configured', async ({ assert }) => {
    setupTestConfig()
    const m = new TenantGuardMiddleware()
    const err = (await catchError(() =>
      m.handle(makeCtx({ isMaintenance: true }), async () => {})
    )) as TenantMaintenanceException
    assert.equal(err.retryAfterSeconds, 600)
  })

  test('uses tenant.maintenanceMessage when present, ignoring the default', async ({ assert }) => {
    setupTestConfig({ maintenance: { defaultMessage: 'Default' } })
    const m = new TenantGuardMiddleware()
    const err = (await catchError(() =>
      m.handle(
        makeCtx({ isMaintenance: true, maintenanceMessage: 'Tenant-specific' }),
        async () => {}
      )
    )) as TenantMaintenanceException
    assert.equal(err.tenantMessage, 'Tenant-specific')
  })

  test('bypass header allows the request through', async ({ assert }) => {
    setupTestConfig({ maintenance: { bypassToken: 'sekret' } })
    const m = new TenantGuardMiddleware()
    let nextCalled = false
    // Container.make for CircuitBreakerService / TenantLogContext will throw
    // outside an Adonis app boot, so we expect either next() or that throw.
    // Both prove the maintenance check was bypassed (the test passes on the
    // bypass branch).
    try {
      await m.handle(
        makeCtx({ isMaintenance: true }, { 'x-tenant-bypass-maintenance': 'sekret' }),
        async () => {
          nextCalled = true
        }
      )
    } catch (err: any) {
      // Acceptable: the post-maintenance-check path tries to make the
      // CircuitBreakerService, which fails without a booted app. As long as
      // we don't throw TenantMaintenanceException, the bypass worked.
      assert.notInstanceOf(err, TenantMaintenanceException)
      return
    }
    assert.isTrue(nextCalled)
  })

  test('wrong bypass token still throws maintenance', async ({ assert }) => {
    setupTestConfig({ maintenance: { bypassToken: 'sekret' } })
    const m = new TenantGuardMiddleware()
    const err = await catchError(() =>
      m.handle(
        makeCtx({ isMaintenance: true }, { 'x-tenant-bypass-maintenance': 'WRONG' }),
        async () => {}
      )
    )
    assert.instanceOf(err, TenantMaintenanceException)
  })

  test('custom bypass header name is honored', async ({ assert }) => {
    setupTestConfig({
      maintenance: { bypassToken: 'sekret', bypassHeader: 'x-bypass' },
    })
    const m = new TenantGuardMiddleware()
    let nextCalled = false
    try {
      await m.handle(
        makeCtx({ isMaintenance: true }, { 'x-bypass': 'sekret' }),
        async () => {
          nextCalled = true
        }
      )
    } catch (err: any) {
      assert.notInstanceOf(err, TenantMaintenanceException)
      return
    }
    assert.isTrue(nextCalled)
  })
})
