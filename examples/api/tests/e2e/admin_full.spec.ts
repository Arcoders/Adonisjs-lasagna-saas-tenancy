import { test } from '@japa/runner'
import {
  ADMIN_HEADERS,
  createInstalledTenant,
  dropAllTenants,
  installInline,
} from './_helpers.js'
import { randomUUID } from 'node:crypto'

/**
 * Full coverage of the package's REST admin API mounted at `/admin/*`.
 *
 * Endpoints exercised:
 *   GET    /admin/tenants                   (already covered in full.spec.ts)
 *   GET    /admin/tenants/:id               show
 *   POST   /admin/tenants/:id/activate      activate
 *   POST   /admin/tenants/:id/suspend       suspend
 *   POST   /admin/tenants/:id/destroy       destroy (+ optional keepSchema)
 *   POST   /admin/tenants/:id/restore       restore
 *   GET    /admin/tenants/:id/queue/stats   queueStats
 *
 * Negative paths: missing token → 401; unknown tenant → 404.
 */
test.group('e2e — admin REST endpoints', (group) => {
  group.setup(async () => {
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('GET /admin/tenants/:id without token → 401', async ({ client }) => {
    const r = await client.get(`/admin/tenants/${randomUUID()}`)
    r.assertStatus(401)
  })

  test('GET /admin/tenants/:id with token → 200 + serialized tenant', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { plan: 'pro' })
    const r = await client.get(`/admin/tenants/${id}`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.equal(r.body().data.id, id)
    assert.equal(r.body().data.status, 'active')
    assert.isString(r.body().data.schemaName)
  })

  test('GET /admin/tenants/:id with token + unknown id → 404', async ({ client, assert }) => {
    const r = await client.get(`/admin/tenants/${randomUUID()}`).headers(ADMIN_HEADERS)
    r.assertStatus(404)
    assert.equal(r.body().error, 'tenant_not_found')
  })

  test('POST /admin/tenants/:id/suspend → status flips to suspended', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.post(`/admin/tenants/${id}/suspend`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.equal(r.body().data.status, 'suspended')

    // Re-read via show to confirm it persisted
    const show = await client.get(`/admin/tenants/${id}`).headers(ADMIN_HEADERS)
    assert.equal(show.body().data.status, 'suspended')
  })

  test('POST /admin/tenants/:id/suspend twice → second call returns unchanged: true', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    await client.post(`/admin/tenants/${id}/suspend`).headers(ADMIN_HEADERS)
    const r = await client.post(`/admin/tenants/${id}/suspend`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.equal(r.body().unchanged, true)
  })

  test('POST /admin/tenants/:id/activate → status flips back to active', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    await client.post(`/admin/tenants/${id}/suspend`).headers(ADMIN_HEADERS)
    const r = await client.post(`/admin/tenants/${id}/activate`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.equal(r.body().data.status, 'active')
  })

  test('POST /admin/tenants/:id/activate when already active → unchanged: true', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.post(`/admin/tenants/${id}/activate`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.equal(r.body().unchanged, true)
  })

  test('POST /admin/tenants/:id/destroy with keepSchema=true preserves the schema', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client
      .post(`/admin/tenants/${id}/destroy`)
      .headers(ADMIN_HEADERS)
      .json({ keepSchema: true })
    r.assertStatus(200)
    assert.equal(r.body().schemaDropped, false)
    assert.isString(r.body().data.deletedAt)

    // The tenant is now soft-deleted; show should still find it via includeDeleted
    const show = await client.get(`/admin/tenants/${id}`).headers(ADMIN_HEADERS)
    show.assertStatus(200)
    assert.isNotNull(show.body().data.deletedAt)
  })

  test('POST /admin/tenants/:id/destroy without keepSchema drops the schema', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.post(`/admin/tenants/${id}/destroy`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.equal(r.body().schemaDropped, true)
  })

  test('POST /admin/tenants/:id/restore clears deletedAt', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    await client
      .post(`/admin/tenants/${id}/destroy`)
      .headers(ADMIN_HEADERS)
      .json({ keepSchema: true })

    const r = await client.post(`/admin/tenants/${id}/restore`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.isNull(r.body().data.deletedAt)
  })

  test('POST /admin/tenants/:id/restore on a non-deleted tenant → unchanged: true', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.post(`/admin/tenants/${id}/restore`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.equal(r.body().unchanged, true)
  })

  test('GET /admin/tenants/:id/queue/stats returns BullMQ stats shape', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const r = await client.get(`/admin/tenants/${id}/queue/stats`).headers(ADMIN_HEADERS)
    r.assertStatus(200)
    const data = r.body().data
    assert.equal(data.tenantId, id)
    assert.isString(data.queueName)
    for (const k of ['waiting', 'active', 'completed', 'failed', 'delayed']) {
      assert.isNumber(data[k], `queue stat "${k}" should be numeric`)
    }
  })

  test('every admin endpoint rejects requests without the token', async ({ client }) => {
    const id = randomUUID()
    const calls = [
      client.get(`/admin/tenants/${id}`),
      client.post(`/admin/tenants/${id}/activate`),
      client.post(`/admin/tenants/${id}/suspend`),
      client.post(`/admin/tenants/${id}/destroy`),
      client.post(`/admin/tenants/${id}/restore`),
      client.get(`/admin/tenants/${id}/queue/stats`),
    ]
    const responses = await Promise.all(calls)
    for (const res of responses) res.assertStatus(401)
  })

  test('admin /tenants?includeDeleted=true returns soft-deleted rows', async ({
    client,
    assert,
  }) => {
    // Build one live + one soft-deleted tenant
    const live = await createInstalledTenant(client)
    const dead = await createInstalledTenant(client)
    await client
      .post(`/admin/tenants/${dead.id}/destroy`)
      .headers(ADMIN_HEADERS)
      .json({ keepSchema: true })

    const without = await client.get('/admin/tenants').headers(ADMIN_HEADERS)
    without.assertStatus(200)
    const idsWithout = without.body().data.map((t: any) => t.id)
    assert.include(idsWithout, live.id)
    assert.notInclude(idsWithout, dead.id)

    const withDeleted = await client
      .get('/admin/tenants?includeDeleted=true')
      .headers(ADMIN_HEADERS)
    withDeleted.assertStatus(200)
    const idsWith = withDeleted.body().data.map((t: any) => t.id)
    assert.include(idsWith, live.id)
    assert.include(idsWith, dead.id)
  })

  test('admin /tenants?status=suspended filters by status', async ({ client, assert }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)
    await client.post(`/admin/tenants/${b.id}/suspend`).headers(ADMIN_HEADERS)

    const r = await client.get('/admin/tenants?status=suspended').headers(ADMIN_HEADERS)
    r.assertStatus(200)
    const ids = r.body().data.map((t: any) => t.id)
    assert.include(ids, b.id)
    assert.notInclude(ids, a.id)
  })

  // Reference: ensures POST /admin/tenants exists and can also create tenants
  // (alongside the demo's `POST /demo/tenants` path).
  test('POST /admin/tenants creates + dispatches provisioning', async ({ client, assert }) => {
    const r = await client
      .post('/admin/tenants')
      .headers(ADMIN_HEADERS)
      .json({ name: 'AdminCreated', email: 'admin-created@e2e.test' })
    r.assertStatus(201)
    assert.equal(r.body().provisioning, true)
    assert.equal(r.body().data.status, 'provisioning')
    // Move it to active so teardown can drop the schema cleanly via dropAllTenants.
    await installInline(r.body().data.id)
  })
})
