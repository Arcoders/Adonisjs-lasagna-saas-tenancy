import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import {
  TenantLogContext,
  tenantLogger,
} from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * `tenantLogger()` is a thin async wrapper that resolves the singleton
 * TenantLogContext from the container and binds the active context to
 * the AdonisJS root logger. Outside a `tenancy.run()` scope it must
 * return the plain root logger; inside one, the returned logger must
 * carry the active tenantId in its bindings.
 *
 * The unit-level AsyncLocalStorage behaviour is already covered by
 * tests/unit/services/tenant_log_context.spec.ts; this spec proves
 * the integration wiring (container resolution + Pino child-logger
 * forwarding) hasn't drifted.
 */
test.group('tenantLogger() — container wiring', () => {
  test('returns a logger when called outside any run() scope', async ({ assert }) => {
    const log = await tenantLogger()
    assert.isFunction(log.info, 'logger must expose info()')
    assert.isFunction(log.child, 'logger must expose child()')
  })

  test('returned logger inside a run() scope carries the tenant binding', async ({ assert }) => {
    const ctx = await app.container.make(TenantLogContext)
    const tenantId = '11111111-1111-4111-8111-111111111111'

    await ctx.run({ tenantId, requestId: 'rq-test' }, async () => {
      const log = (await tenantLogger()) as any
      // Pino's child loggers expose `bindings()` so we can introspect
      // the accumulated context without intercepting writes.
      const bindings = typeof log.bindings === 'function' ? log.bindings() : {}
      assert.equal(bindings.tenantId, tenantId, 'logger must emit tenantId on every line')
      assert.equal(bindings.requestId, 'rq-test', 'arbitrary context fields must propagate')
    })
  })

  test('returned logger outside a scope has no leaked tenant binding', async ({ assert }) => {
    const ctx = await app.container.make(TenantLogContext)

    await ctx.run({ tenantId: 'transient' }, async () => {
      // burn a scope so the singleton has stored data internally
    })

    const log = (await tenantLogger()) as any
    const bindings = typeof log.bindings === 'function' ? log.bindings() : {}
    assert.isUndefined(
      bindings.tenantId,
      'tenantId must not leak past the end of the run() scope'
    )
  })
})
