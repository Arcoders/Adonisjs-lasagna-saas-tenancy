import { test } from '@japa/runner'
import TenantGuardMiddleware from '../../../src/middleware/tenant_guard_middleware.js'
import TenantSuspendedException from '../../../src/exceptions/tenant_suspended_exception.js'
import TenantNotReadyException from '../../../src/exceptions/tenant_not_ready_exception.js'
import { getConfig } from '../../../src/config.js'
import { setupTestConfig } from '../../helpers/config.js'

function makeMockCtx(url: string, tenantOverrides: Record<string, boolean> = {}) {
  const tenant = {
    id: 'test-tenant-id',
    isActive: true,
    isSuspended: false,
    isProvisioning: false,
    isFailed: false,
    isDeleted: false,
    ...tenantOverrides,
  }
  return {
    request: {
      url: (_full: boolean) => url,
      tenant: async () => tenant,
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

test.group('TenantGuardMiddleware — ignorePaths logic', (group) => {
  group.each.setup(() => setupTestConfig())

  test('ignorePaths list contains expected default entries', ({ assert }) => {
    const cfg = getConfig()
    assert.include(cfg.ignorePaths, '/health')
    assert.include(cfg.ignorePaths, '/admin')
    assert.include(cfg.ignorePaths, '/api/webhooks')
  })

  test('exact path match is ignored', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    let nextCalled = false
    await middleware.handle(makeMockCtx('/health'), async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('sub-path of ignored path is also ignored', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    let nextCalled = false
    await middleware.handle(makeMockCtx('/admin/dashboard'), async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('path with query string is handled correctly', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    let nextCalled = false
    await middleware.handle(makeMockCtx('/health?check=all'), async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('path that is a prefix of an ignored path is NOT ignored', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    const err = await catchError(() => middleware.handle(makeMockCtx('/adm'), async () => {}))
    assert.isDefined(err)
  })

  test('substring of ignored path is NOT ignored', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    const err = await catchError(() =>
      middleware.handle(makeMockCtx('/healthcheck'), async () => {})
    )
    assert.isDefined(err)
  })
})

test.group('TenantGuardMiddleware — tenant status enforcement', (group) => {
  group.each.setup(() => setupTestConfig())

  test('throws TenantSuspendedException for suspended tenant', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    const err = await catchError(() =>
      middleware.handle(makeMockCtx('/tenant/users', { isSuspended: true, isActive: false }), async () => {})
    )
    assert.instanceOf(err, TenantSuspendedException)
  })

  test('throws TenantSuspendedException for deleted tenant', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    const err = await catchError(() =>
      middleware.handle(makeMockCtx('/tenant/users', { isDeleted: true, isActive: false }), async () => {})
    )
    assert.instanceOf(err, TenantSuspendedException)
  })

  test('throws TenantNotReadyException for provisioning tenant', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    const err = await catchError(() =>
      middleware.handle(
        makeMockCtx('/tenant/users', { isProvisioning: true, isActive: false }),
        async () => {}
      )
    )
    assert.instanceOf(err, TenantNotReadyException)
  })

  test('throws TenantNotReadyException for failed tenant', async ({ assert }) => {
    const middleware = new TenantGuardMiddleware()
    const err = await catchError(() =>
      middleware.handle(
        makeMockCtx('/tenant/users', { isFailed: true, isActive: false }),
        async () => {}
      )
    )
    assert.instanceOf(err, TenantNotReadyException)
  })
})
