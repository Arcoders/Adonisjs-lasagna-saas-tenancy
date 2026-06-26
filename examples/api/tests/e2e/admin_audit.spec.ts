import { test } from '@japa/runner'
import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { ADMIN_HEADERS, createInstalledTenant, dropAllTenants } from './_helpers.js'

/**
 * End-to-end proof that the admin REST API attributes every mutation in the
 * append-only audit log, that the acting admin flows from `resolveAdminActor`
 * (here the `x-admin-id` header wired in start/routes.ts), and that idempotent
 * no-ops leave no row. The impersonation REST flow (start -> revoke) is
 * exercised here too, since the demo mount now wires the actor resolver.
 *
 * `tenant_audit_logs.actor_id` is a uuid column in the demo, so the admin id is
 * a uuid. Rows are scoped by tenant id, so they never collide across tests.
 */
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HEADERS = { ...ADMIN_HEADERS, 'x-admin-id': ADMIN_ID }

/** The latest audit row for a tenant + action, or null. Parses JSON metadata. */
async function latestAudit(tenantId: string, action: string) {
  const row = await TenantAuditLog.query()
    .where('tenant_id', tenantId)
    .where('action', action)
    .orderBy('created_at', 'desc')
    .first()
  if (!row) return null
  const raw = row.metadata as unknown
  const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
    string,
    unknown
  > | null
  return { actorId: row.actorId, actorType: row.actorType, metadata }
}

async function countAudit(tenantId: string, action: string): Promise<number> {
  const rows = await TenantAuditLog.query().where('tenant_id', tenantId).where('action', action)
  return rows.length
}

test.group('e2e — admin audit attribution', (group) => {
  group.setup(async () => {
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('webhook create writes an attributed admin:webhook:create row', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    const res = await client
      .post(`/admin/tenants/${id}/webhooks`)
      .headers(HEADERS)
      .json({ url: 'https://example.com/hook', events: ['user.created'] })
    res.assertStatus(201)
    const webhookId = res.body().data.id

    const row = await latestAudit(id, 'admin:webhook:create')
    assert.isNotNull(row, 'an admin:webhook:create row was written')
    assert.equal(row!.actorType, 'admin')
    assert.equal(row!.actorId, ADMIN_ID)
    assert.equal(row!.metadata?.webhookId, webhookId)
    assert.equal(row!.metadata?.secretGenerated, true)
    // The generated secret must NEVER appear in the metadata.
    assert.notProperty(row!.metadata, 'secret')
  })

  test('feature flag create writes an attributed admin:feature_flag:create row', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    const res = await client
      .post(`/admin/tenants/${id}/feature-flags`)
      .headers(HEADERS)
      .json({ flag: 'beta_dashboard', enabled: true })
    res.assertStatus(201)

    const row = await latestAudit(id, 'admin:feature_flag:create')
    assert.isNotNull(row)
    assert.equal(row!.actorId, ADMIN_ID)
    assert.equal(row!.metadata?.flag, 'beta_dashboard')
    assert.equal(row!.metadata?.enabled, true)
  })

  test('an idempotent no-op writes no audit row', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    // The tenant is already active, so activate is a no-op (unchanged: true).
    const res = await client.post(`/admin/tenants/${id}/activate`).headers(HEADERS)
    res.assertStatus(200)
    assert.equal(res.body().unchanged, true)

    assert.equal(
      await countAudit(id, 'admin:tenant:activate'),
      0,
      'a no-op activate must not write an audit row'
    )
  })

  test('deleting a missing webhook 404s and writes no delete row', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    const res = await client
      .delete(`/admin/tenants/${id}/webhooks/99999999-9999-4999-8999-999999999999`)
      .headers(HEADERS)
    res.assertStatus(404)
    assert.equal(
      await countAudit(id, 'admin:webhook:delete'),
      0,
      'a phantom delete must not write an audit row'
    )
  })

  test('impersonation REST flow: start → use → revoke, all audited', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    const targetUserId = '11111111-2222-4333-8444-555555555555'

    // start
    const start = await client
      .post(`/admin/tenants/${id}/impersonations`)
      .headers(HEADERS)
      .json({ userId: targetUserId, reason: 'support ticket #7' })
    start.assertStatus(201)
    const token = start.body().data.token as string
    assert.isString(token)

    const startRow = await latestAudit(id, 'admin:impersonate:start')
    assert.isNotNull(startRow, 'impersonation start was audited')
    assert.equal(startRow!.actorId, ADMIN_ID)
    assert.equal(startRow!.metadata?.targetUserId, targetUserId)

    // use: a request carrying the token resolves to the impersonation context
    const used = await client
      .get('/demo/impersonation-check')
      .header('x-impersonation-token', token)
    used.assertStatus(200)
    const ctx = used.body().impersonation
    assert.isNotNull(ctx, 'the token resolves to an impersonation context end to end')
    assert.equal(ctx.adminId, ADMIN_ID)
    // The session's targetUserId surfaces on the context as `userId`.
    assert.equal(ctx.userId, targetUserId)

    // revoke
    const stop = await client.delete(`/admin/impersonations/${token}`).headers(HEADERS)
    stop.assertStatus(200)
    assert.equal(stop.body().revoked, true)

    const stopRow = await latestAudit(id, 'admin:impersonate:stop')
    assert.isNotNull(stopRow, 'impersonation stop was audited')
  })
})
