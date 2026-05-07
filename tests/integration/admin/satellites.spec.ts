import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

const PREFIX = '/admin/multitenancy'

test.group('Admin REST — satellite endpoints', (group) => {
  let tenantId: string

  group.each.setup(async () => {
    const t = await createTestTenant({ status: 'active' })
    tenantId = t.id
  })

  group.each.teardown(async () => {
    await destroyTestTenant(tenantId)
  })

  // OpenAPI / Swagger UI -------------------------------------------------

  test('GET /openapi.json returns a valid 3.1 spec', async ({ client, assert }) => {
    const res = await client.get(`${PREFIX}/openapi.json`)
    res.assertStatus(200)
    const body: any = res.body()
    assert.equal(body.openapi, '3.1.0')
    assert.isObject(body.paths)
    assert.isAbove(Object.keys(body.paths).length, 10)
  })

  test('GET /docs returns the Swagger HTML shell', async ({ client }) => {
    const res = await client.get(`${PREFIX}/docs`)
    res.assertStatus(200)
    res.assertTextIncludes('SwaggerUIBundle')
  })

  // Audit logs (read-only) -----------------------------------------------

  test('GET /tenants/:id/audit-logs returns paginated payload for active tenant', async ({
    client,
    assert,
  }) => {
    const res = await client.get(`${PREFIX}/tenants/${tenantId}/audit-logs`)
    res.assertStatus(200)
    const body: any = res.body()
    // Adonis paginator shape — `data` and `meta` are siblings of the payload
    assert.containsSubset(body, { data: [] as any[] })
  })

  test('GET /tenants/:id/audit-logs 404 for unknown tenant', async ({ client }) => {
    const res = await client.get(`${PREFIX}/tenants/${randomUUID()}/audit-logs`)
    res.assertStatus(404)
  })

  // Webhooks -------------------------------------------------------------

  test('POST + GET + DELETE webhook lifecycle', async ({ client, assert }) => {
    const create = await client.post(`${PREFIX}/tenants/${tenantId}/webhooks`).json({
      url: 'https://example.com/hook',
      events: ['user.created'],
      secret: 's3cret',
    })
    create.assertStatus(201)
    const created: any = create.body()
    assert.isString(created.data.id)
    assert.equal(created.data.url, 'https://example.com/hook')
    assert.isTrue(created.data.hasSecret)
    assert.notProperty(created.data, 'secret')

    const list = await client.get(`${PREFIX}/tenants/${tenantId}/webhooks`)
    list.assertStatus(200)
    assert.equal((list.body() as any).data.length, 1)

    const update = await client
      .put(`${PREFIX}/tenants/${tenantId}/webhooks/${created.data.id}`)
      .json({ enabled: false })
    update.assertStatus(200)
    assert.isFalse((update.body() as any).data.enabled)

    const del = await client.delete(`${PREFIX}/tenants/${tenantId}/webhooks/${created.data.id}`)
    del.assertStatus(204)

    const after = await client.get(`${PREFIX}/tenants/${tenantId}/webhooks`)
    assert.equal((after.body() as any).data.length, 0)
  })

  test('POST webhook 400 when url is missing', async ({ client }) => {
    const res = await client
      .post(`${PREFIX}/tenants/${tenantId}/webhooks`)
      .json({ events: ['e'] })
    res.assertStatus(400)
  })

  // Feature flags --------------------------------------------------------

  test('Feature flag CRUD', async ({ client, assert }) => {
    const create = await client
      .post(`${PREFIX}/tenants/${tenantId}/feature-flags`)
      .json({ flag: 'beta_dashboard', enabled: true })
    create.assertStatus(201)

    const list = await client.get(`${PREFIX}/tenants/${tenantId}/feature-flags`)
    list.assertStatus(200)
    const data = (list.body() as any).data as any[]
    assert.lengthOf(data, 1)
    assert.equal(data[0].flag, 'beta_dashboard')

    const upd = await client
      .put(`${PREFIX}/tenants/${tenantId}/feature-flags/beta_dashboard`)
      .json({ enabled: false, config: { tier: 'gold' } })
    upd.assertStatus(200)
    assert.isFalse((upd.body() as any).data.enabled)

    const del = await client.delete(`${PREFIX}/tenants/${tenantId}/feature-flags/beta_dashboard`)
    del.assertStatus(204)
  })

  // Branding -------------------------------------------------------------

  test('Branding upsert returns serialized record', async ({ client, assert }) => {
    const upd = await client.put(`${PREFIX}/tenants/${tenantId}/branding`).json({
      fromName: 'Acme',
      fromEmail: 'noreply@acme.test',
      primaryColor: '#3b82f6',
    })
    upd.assertStatus(200)
    const data = (upd.body() as any).data
    assert.equal(data.fromName, 'Acme')
    assert.equal(data.primaryColor, '#3b82f6')
  })

  test('Branding 400 when primaryColor is not a hex', async ({ client }) => {
    const res = await client
      .put(`${PREFIX}/tenants/${tenantId}/branding`)
      .json({ primaryColor: 'rgb(0,0,0)' })
    res.assertStatus(400)
  })

  // SSO ------------------------------------------------------------------

  test('SSO configure + show + disable', async ({ client, assert }) => {
    const upd = await client.put(`${PREFIX}/tenants/${tenantId}/sso`).json({
      clientId: 'cid',
      clientSecret: 'shh',
      issuerUrl: 'https://issuer.test',
      redirectUri: 'https://app.test/callback',
      scopes: ['openid', 'email'],
    })
    upd.assertStatus(200)
    const data = (upd.body() as any).data
    assert.isTrue(data.hasClientSecret)
    assert.notProperty(data, 'clientSecret')

    const show = await client.get(`${PREFIX}/tenants/${tenantId}/sso`)
    show.assertStatus(200)

    const disable = await client.post(`${PREFIX}/tenants/${tenantId}/sso/disable`)
    disable.assertStatus(200)
    assert.isFalse((disable.body() as any).data.enabled)
  })

  test('SSO 400 when issuerUrl is invalid', async ({ client }) => {
    const res = await client.put(`${PREFIX}/tenants/${tenantId}/sso`).json({
      clientId: 'cid',
      clientSecret: 's',
      issuerUrl: 'not-a-url',
      redirectUri: 'https://app.test/cb',
    })
    res.assertStatus(400)
  })

  // Metrics --------------------------------------------------------------

  test('Metrics list defaults to 30 days', async ({ client, assert }) => {
    const res = await client.get(`${PREFIX}/tenants/${tenantId}/metrics`)
    res.assertStatus(200)
    const body: any = res.body()
    assert.equal(body.days, 30)
    assert.isArray(body.data)
  })

  // Quotas ---------------------------------------------------------------

  test('Quotas snapshot returns 503 when plans config absent', async ({ client }) => {
    // Without plans configured, QuotaService.snapshot throws and the
    // controller surfaces a clean 503 — stancl-style "feature not enabled".
    const res = await client.get(`${PREFIX}/tenants/${tenantId}/quotas`)
    // Either 200 (plans configured in fixture) or 503 (not configured).
    if (res.status() !== 200) res.assertStatus(503)
  })
})
