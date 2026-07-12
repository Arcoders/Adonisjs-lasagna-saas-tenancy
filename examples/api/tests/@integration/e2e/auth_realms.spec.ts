import { test } from '@japa/runner'
import Tenant from '#app/models/backoffice/tenant'
import { DEMO_OPERATOR, DEMO_TENANT_USER } from '#app/helpers/demo_credentials'
import { ADMIN_HEADERS, createInstalledTenant, dropAllTenants } from './_helpers.js'

/**
 * The two-auth-realms contract, attacked through the booted HTTP stack. One
 * realm per plane and they share nothing: operators live in
 * backoffice.backoffice_users with `bko_` tokens stored in the backoffice
 * schema; tenant users live in each tenant's own `users` table with `tnt_`
 * tokens stored in that same schema. Nothing here branches on the prefixes
 * (they are diagnostic only): every rejection below falls out of WHERE the
 * rows live plus the guard's timing-safe hash compare.
 *
 * No sleeps anywhere. Expiry is forced with an UPDATE on the tenant's own
 * connection, the same trick commands_failures uses for its raw checks.
 */

/** Logs the seeded demo user in against one tenant and returns its `tnt_` bearer. */
async function loginTenantUser(client: any, tenantId: string): Promise<string> {
  const r = await client
    .post('/demo/auth/login')
    .header('x-tenant-id', tenantId)
    .json({ email: DEMO_TENANT_USER.email, password: DEMO_TENANT_USER.password })
  if (r.status() !== 200) {
    throw new Error(
      `tenant login failed for ${tenantId}: ${r.status()} ${JSON.stringify(r.body())}`
    )
  }
  return r.body().token as string
}

test.group('e2e — two auth realms (operator vs tenant)', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('operator realm: login mints a bko_ bearer that opens /admin and /backoffice/me', async ({
    client,
    assert,
  }) => {
    const login = await client
      .post('/backoffice/login')
      .json({ email: DEMO_OPERATOR.email, password: DEMO_OPERATOR.password })
    login.assertStatus(200)
    const token = login.body().token as string
    assert.isTrue(token.startsWith('bko_'), 'operator tokens carry the diagnostic bko_ prefix')

    const list = await client.get('/admin/tenants').header('authorization', `Bearer ${token}`)
    list.assertStatus(200)

    const me = await client.get('/backoffice/me').header('authorization', `Bearer ${token}`)
    me.assertStatus(200)
    assert.equal(me.body().email, DEMO_OPERATOR.email)

    const garbage = await client
      .get('/admin/tenants')
      .header('authorization', 'Bearer bko_not-a-real-token')
    garbage.assertStatus(401)

    const absent = await client.get('/admin/tenants')
    absent.assertStatus(401)
  })

  test('tenant realm: the hook-seeded user logs in inside the resolved tenant', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client)

    const login = await client
      .post('/demo/auth/login')
      .header('x-tenant-id', a.id)
      .json({ email: DEMO_TENANT_USER.email, password: DEMO_TENANT_USER.password })
    login.assertStatus(200)
    const token = login.body().token as string
    assert.isTrue(token.startsWith('tnt_'), 'tenant tokens carry the diagnostic tnt_ prefix')

    const me = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', a.id)
      .header('authorization', `Bearer ${token}`)
    me.assertStatus(200)
    assert.equal(me.body().tenantId, a.id)
    assert.equal(me.body().email, DEMO_TENANT_USER.email)
  })

  test('cross-tenant isolation: a tenant-A token resolving tenant B is refused with 403', async ({
    client,
  }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)
    const tokenA = await loginTenantUser(client, a.id)

    const crossed = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', b.id)
      .header('authorization', `Bearer ${tokenA}`)
    crossed.assertStatus(403)
  })

  test('token row-id collision across schemas is rejected by the hash compare', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)
    const tokenA = await loginTenantUser(client, a.id)
    const tokenB = await loginTenantUser(client, b.id)

    // One login each, so both schemas hold exactly one token row with id=1.
    // The cross-use rejections below therefore cannot come from a missing
    // row: the id resolves, the stored hash does not match, and the guard's
    // timing-safe compare is what says no.
    for (const id of [a.id, b.id]) {
      const tenant = await Tenant.findOrFail(id)
      const r = await tenant.getConnection().rawQuery('SELECT id FROM auth_access_tokens')
      assert.deepEqual(
        r.rows.map((row: { id: number }) => row.id),
        [1],
        `tenant ${id} holds exactly one token row with id=1`
      )
    }

    const aTokenOnB = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', b.id)
      .header('authorization', `Bearer ${tokenA}`)
    aTokenOnB.assertStatus(403)

    const bTokenOnA = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', a.id)
      .header('authorization', `Bearer ${tokenB}`)
    bTokenOnA.assertStatus(403)
  })

  test('realm separation both ways: bko_ dies on tenant routes, tnt_ dies on /admin', async ({
    client,
  }) => {
    const a = await createInstalledTenant(client)
    const tokenA = await loginTenantUser(client, a.id)

    // The membership gate evaluates any bearer against the tenant guard and
    // denies before the route middleware runs, so an operator token answers
    // 403 here.
    const operatorOnTenant = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', a.id)
      .headers(ADMIN_HEADERS)
    operatorOnTenant.assertStatus(403)

    // /admin sits in ignorePaths, so the gate never runs there and the
    // backoffice guard is the only authority: a tenant token answers 401.
    const tenantOnAdmin = await client
      .get('/admin/tenants')
      .header('authorization', `Bearer ${tokenA}`)
    tenantOnAdmin.assertStatus(401)
  })

  test('an expired token stops working, deterministically (expiry forced in SQL)', async ({
    client,
  }) => {
    const a = await createInstalledTenant(client)
    const token = await loginTenantUser(client, a.id)

    const tenant = await Tenant.findOrFail(a.id)
    await tenant
      .getConnection()
      .rawQuery("UPDATE auth_access_tokens SET expires_at = now() - interval '1 hour'")

    const denied = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', a.id)
      .header('authorization', `Bearer ${token}`)
    denied.assertStatus(403)
  })

  test('logout revokes: tenant reuse answers 403, operator reuse answers 401', async ({
    client,
  }) => {
    const a = await createInstalledTenant(client)
    const token = await loginTenantUser(client, a.id)

    const out = await client
      .delete('/demo/auth/logout')
      .header('x-tenant-id', a.id)
      .header('authorization', `Bearer ${token}`)
    out.assertStatus(200)

    const reuse = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', a.id)
      .header('authorization', `Bearer ${token}`)
    reuse.assertStatus(403)

    // A fresh operator login gets its own token, so revoking it leaves the
    // suite-wide ADMIN_HEADERS bearer untouched.
    const login = await client
      .post('/backoffice/login')
      .json({ email: DEMO_OPERATOR.email, password: DEMO_OPERATOR.password })
    login.assertStatus(200)
    const opToken = login.body().token as string

    const opOut = await client
      .delete('/backoffice/logout')
      .header('authorization', `Bearer ${opToken}`)
    opOut.assertStatus(200)

    const opReuse = await client.get('/admin/tenants').header('authorization', `Bearer ${opToken}`)
    opReuse.assertStatus(401)
  })

  test('the same email is an independent identity in each tenant', async ({ client, assert }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)
    const tokenA = await loginTenantUser(client, a.id)
    const tokenB = await loginTenantUser(client, b.id)

    const meA = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', a.id)
      .header('authorization', `Bearer ${tokenA}`)
    meA.assertStatus(200)
    assert.equal(meA.body().tenantId, a.id)

    const meB = await client
      .get('/demo/auth/me')
      .header('x-tenant-id', b.id)
      .header('authorization', `Bearer ${tokenB}`)
    meB.assertStatus(200)
    assert.equal(meB.body().tenantId, b.id)
  })

  test('wrong credentials never mint a token, in either realm', async ({ client, assert }) => {
    const a = await createInstalledTenant(client)

    const tenantFail = await client
      .post('/demo/auth/login')
      .header('x-tenant-id', a.id)
      .json({ email: DEMO_TENANT_USER.email, password: 'not-the-password' })
    assert.oneOf(tenantFail.status(), [400, 401], 'the tenant fail path must not answer 200')
    assert.notProperty(tenantFail.body(), 'token')

    const operatorFail = await client
      .post('/backoffice/login')
      .json({ email: DEMO_OPERATOR.email, password: 'not-the-password' })
    assert.oneOf(operatorFail.status(), [400, 401], 'the operator fail path must not answer 200')
    assert.notProperty(operatorFail.body(), 'token')
  })

  test('login bodies are validated: missing or malformed fields answer 422', async ({ client }) => {
    const a = await createInstalledTenant(client)

    const missing = await client
      .post('/demo/auth/login')
      .header('x-tenant-id', a.id)
      .json({ email: DEMO_TENANT_USER.email })
    missing.assertStatus(422)

    const malformed = await client
      .post('/backoffice/login')
      .json({ email: 'not-an-email', password: 'whatever' })
    malformed.assertStatus(422)
  })
})
