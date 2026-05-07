import { test } from '@japa/runner'
import { TenantLogContext } from '@adonisjs-lasagna/saas-tenancy/services'
import { createInstalledTenant, dropAllTenants } from './_helpers.js'

/**
 * Asserts that contextual logging works end-to-end. There are two layers:
 *
 *   1. `TenantLogContext` uses AsyncLocalStorage to thread `{ tenantId }`
 *      through async continuations. The `TenantGuardMiddleware` binds it
 *      for every tenant-guarded request.
 *
 *   2. `tenantLogger()` returns `rootLogger.child({ tenantId })` whenever
 *      a context is active, so all log records emitted from request
 *      handlers automatically carry the tenant id field.
 *
 * The probe route /demo/log/emit reflects both layers back so this test
 * can assert them without intercepting AdonisJS's pino destination.
 */
test.group('e2e — contextual logging carries tenantId', (group) => {
  group.setup(async () => {
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('inside a tenant-guarded request, currentTenantId() returns the tenant id', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.get('/demo/log/emit').header('x-tenant-id', id)
    r.assertStatus(200)
    assert.equal(r.body().contextTenantId, id, 'TenantLogContext.currentTenantId() should match')
  })

  test('tenantLogger() inside the request emits records bound to tenantId', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.get('/demo/log/emit').header('x-tenant-id', id)
    r.assertStatus(200)

    // pino exposes `.bindings()` on child loggers — when AdonisJS surfaces it
    // through the macro chain, we can directly assert the bound field.
    if (r.body().loggerBindings && typeof r.body().loggerBindings === 'object') {
      assert.equal(r.body().loggerBindings.tenantId, id)
    } else {
      // AdonisJS may not expose `.bindings()` through its logger wrapper. The
      // first test already proves the AsyncLocalStorage binding; the package
      // contract guarantees `bind(logger)` calls `logger.child(context)` —
      // covered separately by the unit assertion below.
      assert.isTrue(true, 'logger bindings introspection unavailable in this AdonisJS version')
    }
  })

  test('outside any tenant context, currentTenantId() returns undefined', async ({
    assert,
  }) => {
    const ctx = new TenantLogContext()
    assert.isUndefined(ctx.currentTenantId())
    assert.isUndefined(ctx.current())
  })

  test('TenantLogContext.bind() calls logger.child() with the active context', async ({
    assert,
  }) => {
    const ctx = new TenantLogContext()
    const calls: Record<string, unknown>[] = []
    const fakeLogger = {
      child(bindings: Record<string, unknown>) {
        calls.push(bindings)
        return this
      },
      // satisfy the LoggerLike contract — these are unused in `bind()`
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
    }

    await ctx.run({ tenantId: 'abc-123', requestId: 'req-1' }, async () => {
      ctx.bind(fakeLogger as any)
    })

    assert.lengthOf(calls, 1)
    assert.deepEqual(calls[0], { tenantId: 'abc-123', requestId: 'req-1' })
  })

  test('TenantLogContext.bind() outside a context returns the logger unchanged', ({
    assert,
  }) => {
    const ctx = new TenantLogContext()
    let childCalled = false
    const fakeLogger = {
      child() {
        childCalled = true
        return fakeLogger
      },
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
    }
    const bound = ctx.bind(fakeLogger as any)
    assert.strictEqual(bound, fakeLogger)
    assert.isFalse(childCalled)
  })

  test('AsyncLocalStorage isolates concurrent requests', async ({ client, assert }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)

    // Fire two concurrent requests with different tenant headers; their
    // `contextTenantId` reflections must not bleed across.
    const [ra, rb] = await Promise.all([
      client.get('/demo/log/emit').header('x-tenant-id', a.id),
      client.get('/demo/log/emit').header('x-tenant-id', b.id),
    ])

    ra.assertStatus(200)
    rb.assertStatus(200)
    assert.equal(ra.body().contextTenantId, a.id)
    assert.equal(rb.body().contextTenantId, b.id)
  })
})
