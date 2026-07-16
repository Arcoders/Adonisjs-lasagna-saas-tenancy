import { test } from '@japa/runner'
import { TenantSsoConfig } from '@adonisjs-lasagna/sso'
import { createInstalledTenant, dropAllTenants } from './_helpers.js'

/**
 * E2E coverage of the feature flags / branding / SSO satellites via the demo
 * HTTP controllers added in `app/controllers/demo/`. Service-level coverage
 * (CRUD edge cases, cache behaviour, encryption-at-rest) lives in
 * `tests/integration/services/`. This file only exercises the wiring at
 * the HTTP layer.
 */
test.group('e2e — satellites: feature flags, branding, SSO (HTTP)', (group) => {
  group.setup(async () => {
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  // ─── Feature flags ───────────────────────────────────────────────
  test('POST /demo/feature-flags persists per-tenant flags', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client
      .post('/demo/feature-flags')
      .header('x-tenant-id', id)
      .json({ flag: 'beta_widgets', enabled: true, config: { rollout: 50 } })
    r.assertStatus(201)
    assert.equal(r.body().flag, 'beta_widgets')
    assert.isTrue(r.body().enabled)
    assert.deepEqual(r.body().config, { rollout: 50 })
  })

  test('GET /demo/feature-flags lists flags for the active tenant only', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)

    await client
      .post('/demo/feature-flags')
      .header('x-tenant-id', a.id)
      .json({ flag: 'flag_for_a', enabled: true })
    await client
      .post('/demo/feature-flags')
      .header('x-tenant-id', b.id)
      .json({ flag: 'flag_for_b', enabled: false })

    const listA = await client.get('/demo/feature-flags').header('x-tenant-id', a.id)
    listA.assertStatus(200)
    const flagsA = listA.body().flags.map((f: any) => f.flag)
    assert.include(flagsA, 'flag_for_a')
    assert.notInclude(flagsA, 'flag_for_b')

    const listB = await client.get('/demo/feature-flags').header('x-tenant-id', b.id)
    const flagsB = listB.body().flags.map((f: any) => f.flag)
    assert.include(flagsB, 'flag_for_b')
    assert.notInclude(flagsB, 'flag_for_a')
  })

  test('DELETE /demo/feature-flags/:flag removes the row', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    await client
      .post('/demo/feature-flags')
      .header('x-tenant-id', id)
      .json({ flag: 'temp_flag', enabled: true })

    const del = await client.delete('/demo/feature-flags/temp_flag').header('x-tenant-id', id)
    del.assertStatus(200)

    const list = await client.get('/demo/feature-flags').header('x-tenant-id', id)
    const flags = list.body().flags.map((f: any) => f.flag)
    assert.notInclude(flags, 'temp_flag')
  })

  test('POST /demo/feature-flags rejects requests without a flag name', async ({ client }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client
      .post('/demo/feature-flags')
      .header('x-tenant-id', id)
      .json({ enabled: true })
    // VineJS surfaces validation failures as 422.
    r.assertStatus(422)
  })

  // ─── Branding ────────────────────────────────────────────────────
  test('GET /demo/branding returns sane defaults when no row exists', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.get('/demo/branding').header('x-tenant-id', id)
    r.assertStatus(200)
    assert.isFalse(r.body().hasRow)
    assert.isString(r.body().branding.fromName)
    assert.isString(r.body().branding.fromEmail)
    assert.isString(r.body().branding.primaryColor)
  })

  test('PUT /demo/branding upserts and is read back via GET', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    const put = await client.put('/demo/branding').header('x-tenant-id', id).json({
      fromName: 'Acme',
      fromEmail: 'no-reply@acme.test',
      primaryColor: '#FF00FF',
      supportUrl: 'https://acme.test/help',
    })
    put.assertStatus(200)
    assert.equal(put.body().branding.fromName, 'Acme')
    assert.equal(put.body().branding.primaryColor, '#FF00FF')

    const get = await client.get('/demo/branding').header('x-tenant-id', id)
    get.assertStatus(200)
    assert.isTrue(get.body().hasRow)
    assert.equal(get.body().branding.fromEmail, 'no-reply@acme.test')
    assert.equal(get.body().branding.supportUrl, 'https://acme.test/help')
  })

  test('branding rows are isolated between tenants', async ({ client, assert }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)

    await client.put('/demo/branding').header('x-tenant-id', a.id).json({ fromName: 'A-Co' })
    await client.put('/demo/branding').header('x-tenant-id', b.id).json({ fromName: 'B-Co' })

    const ga = await client.get('/demo/branding').header('x-tenant-id', a.id)
    const gb = await client.get('/demo/branding').header('x-tenant-id', b.id)
    assert.equal(ga.body().branding.fromName, 'A-Co')
    assert.equal(gb.body().branding.fromName, 'B-Co')
  })

  // ─── SSO ─────────────────────────────────────────────────────────
  test('GET /demo/sso reports configured: false before any upsert', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.get('/demo/sso').header('x-tenant-id', id)
    r.assertStatus(200)
    assert.isFalse(r.body().configured)
  })

  test('PUT /demo/sso persists the config and never echoes the secret', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client
      .put('/demo/sso')
      .header('x-tenant-id', id)
      .json({
        clientId: 'my-client',
        clientSecret: 'super-secret-do-not-leak',
        issuerUrl: 'https://acme.okta.com',
        redirectUri: 'https://acme.test/auth/callback',
        scopes: ['openid', 'email'],
      })
    r.assertStatus(200)
    assert.isTrue(r.body().configured)
    assert.equal(r.body().clientId, 'my-client')
    assert.equal(r.body().issuerUrl, 'https://acme.okta.com')
    assert.isTrue(r.body().hasClientSecret)

    // The secret must NOT round-trip back through any response field.
    const flat = JSON.stringify(r.body())
    assert.notInclude(flat, 'super-secret-do-not-leak')
  })

  test('PUT /demo/sso rejects requests missing required fields', async ({ client }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.put('/demo/sso').header('x-tenant-id', id).json({ clientId: 'only-id' })
    // VineJS surfaces validation failures as 422.
    r.assertStatus(422)
  })

  test('SSO config row is queryable directly via the satellite model', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    await client.put('/demo/sso').header('x-tenant-id', id).json({
      clientId: 'cid',
      clientSecret: 'csec',
      issuerUrl: 'https://acme.okta.com',
      redirectUri: 'https://acme.test/cb',
    })

    const row = await TenantSsoConfig.query().where('tenant_id', id).firstOrFail()
    assert.equal(row.clientId, 'cid')
    // The package's SsoService stores the secret as-is today (encrypt-at-rest
    // is intentionally not applied, see services/sso_service.ts). The check
    // here confirms the row exists with the expected client id.
    assert.isString(row.clientSecret)
  })
})
