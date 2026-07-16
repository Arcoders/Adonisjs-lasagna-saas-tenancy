import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { getAdminActorResolver, setAdminActorResolver } from '../../../../src/admin_actor.js'

/**
 * Pure module-state coverage for the admin actor resolver. It holds the only
 * trusted source of the acting admin id, wired once by `multitenancyAdminRoutes`.
 * No Ignitor: `admin_actor.ts` imports nothing app-coupled, so it unit-tests in
 * isolation (the controllers and the audit helper read it through here).
 */
test.group('admin actor resolver (module state)', (group) => {
  group.each.teardown(() => setAdminActorResolver(null))

  test('is null until wired', ({ assert }) => {
    setAdminActorResolver(null)
    assert.isNull(getAdminActorResolver())
  })

  test('set then get returns the same function reference', ({ assert }) => {
    const fn = () => 'admin-1'
    setAdminActorResolver(fn)
    assert.strictEqual(getAdminActorResolver(), fn)
  })

  test('resets to null', ({ assert }) => {
    setAdminActorResolver(() => 'x')
    setAdminActorResolver(null)
    assert.isNull(getAdminActorResolver())
  })

  test('supports an async resolver', async ({ assert }) => {
    setAdminActorResolver(async () => 'async-admin')
    const fn = getAdminActorResolver()
    assert.isNotNull(fn)
    assert.equal(await fn!({} as HttpContext), 'async-admin')
  })

  test('a resolver may return null to deny', async ({ assert }) => {
    setAdminActorResolver(() => null)
    const fn = getAdminActorResolver()
    assert.equal(await fn!({} as HttpContext), null)
  })
})
