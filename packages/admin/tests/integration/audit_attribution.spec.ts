import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { AuditLogService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { adminActionRegistry, ADMIN_CONTRACT_VERSION } from '@adonisjs-lasagna/admin'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * Integration proof that admin mutations write attributed, append-only audit
 * rows; that the actor flows from the wired `resolveAdminActor` (an `x-admin-id`
 * header in the fixture) including the null-actor branch; that truthful deletes
 * and idempotent no-ops write nothing; that a custom-action dispatch is
 * attributed; and that a failing audit write never fails the mutation (chaos).
 *
 * Isolated in its own group: a teardown disables the append-only delete trigger
 * to clean only this group's rows (scoped by tenant id, plus the null-tenant
 * dispatch rows), so suites that assume active triggers are unaffected.
 * `tenant_audit_logs.actor_id` is a uuid column, so the admin id is a uuid.
 */
const PREFIX = '/admin/multitenancy'
const ADMIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CUSTOM_ACTION = 'audit_probe_action'

function parseMetadata(row: TenantAuditLog): Record<string, unknown> | null {
  const raw = row.metadata as unknown
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | null
}

async function latest(tenantId: string | null, action: string): Promise<TenantAuditLog | null> {
  const q = TenantAuditLog.query().where('action', action).orderBy('created_at', 'desc')
  if (tenantId === null) q.whereNull('tenant_id')
  else q.where('tenant_id', tenantId)
  return q.first()
}

async function count(tenantId: string, action: string): Promise<number> {
  const rows = await TenantAuditLog.query().where('tenant_id', tenantId).where('action', action)
  return rows.length
}

test.group('Admin REST — audit attribution', (group) => {
  const tenantIds: string[] = []
  let tenantId: string

  group.each.setup(async () => {
    const t = await createTestTenant({ status: 'active' })
    tenantId = t.id
    tenantIds.push(t.id)
  })

  group.teardown(async () => {
    // Disable the append-only DELETE trigger to clean ONLY this group's rows.
    await db.rawQuery(
      'ALTER TABLE backoffice.tenant_audit_logs DISABLE TRIGGER tenant_audit_logs_no_delete'
    )
    try {
      for (const id of tenantIds) {
        await db
          .connection('backoffice')
          .query()
          .from('tenant_audit_logs')
          .where('tenant_id', id)
          .delete()
      }
      // The custom-action dispatch row has a null tenant id; clear it by action.
      await db
        .connection('backoffice')
        .query()
        .from('tenant_audit_logs')
        .where('action', 'admin:action:dispatch')
        .delete()
    } finally {
      await db.rawQuery(
        'ALTER TABLE backoffice.tenant_audit_logs ENABLE TRIGGER tenant_audit_logs_no_delete'
      )
    }
    for (const id of tenantIds) await destroyTestTenant(id)
    adminActionRegistry.clear()
  })

  test('webhook create writes an attributed admin:webhook:create row', async ({
    client,
    assert,
  }) => {
    const res = await client
      .post(`${PREFIX}/tenants/${tenantId}/webhooks`)
      .header('x-admin-id', ADMIN_ID)
      .json({ url: 'https://example.com/hook', events: ['user.created'] })
    res.assertStatus(201)
    const webhookId = (res.body() as any).data.id

    const row = await latest(tenantId, 'admin:webhook:create')
    assert.isNotNull(row)
    assert.equal(row!.actorType, 'admin')
    assert.equal(row!.actorId, ADMIN_ID)
    const meta = parseMetadata(row!)
    assert.equal(meta?.webhookId, webhookId)
    assert.equal(meta?.secretGenerated, true)
    assert.notProperty(meta, 'secret')
  })

  test('without x-admin-id the row is still written with a null actor', async ({
    client,
    assert,
  }) => {
    const res = await client
      .post(`${PREFIX}/tenants/${tenantId}/feature-flags`)
      .json({ flag: 'beta', enabled: true })
    res.assertStatus(201)

    const row = await latest(tenantId, 'admin:feature_flag:create')
    assert.isNotNull(row, 'a config mutation audits even without a resolvable actor')
    assert.equal(row!.actorType, 'admin')
    assert.isNull(row!.actorId)
  })

  test('deleting a missing webhook 404s and writes no delete row', async ({ client, assert }) => {
    const res = await client
      .delete(`${PREFIX}/tenants/${tenantId}/webhooks/${randomUUID()}`)
      .header('x-admin-id', ADMIN_ID)
    res.assertStatus(404)
    assert.equal(await count(tenantId, 'admin:webhook:delete'), 0)
  })

  test('deleting an existing webhook writes exactly one delete row', async ({ client, assert }) => {
    const created = await client
      .post(`${PREFIX}/tenants/${tenantId}/webhooks`)
      .header('x-admin-id', ADMIN_ID)
      .json({ url: 'https://example.com/del', events: ['user.created'] })
    created.assertStatus(201)
    const webhookId = (created.body() as any).data.id

    const del = await client
      .delete(`${PREFIX}/tenants/${tenantId}/webhooks/${webhookId}`)
      .header('x-admin-id', ADMIN_ID)
    del.assertStatus(204)
    assert.equal(await count(tenantId, 'admin:webhook:delete'), 1)
  })

  test('a no-op webhook update (empty body) audits nothing', async ({ client, assert }) => {
    const created = await client
      .post(`${PREFIX}/tenants/${tenantId}/webhooks`)
      .header('x-admin-id', ADMIN_ID)
      .json({ url: 'https://example.com/noop', events: ['user.created'] })
    created.assertStatus(201)
    const webhookId = (created.body() as any).data.id

    const upd = await client
      .put(`${PREFIX}/tenants/${tenantId}/webhooks/${webhookId}`)
      .header('x-admin-id', ADMIN_ID)
      .json({})
    upd.assertStatus(200)
    assert.equal((upd.body() as any).unchanged, true)
    assert.equal(await count(tenantId, 'admin:webhook:update'), 0)
  })

  test('a custom-action dispatch is attributed with the action name only', async ({
    client,
    assert,
  }) => {
    adminActionRegistry.register({
      name: CUSTOM_ACTION,
      description: 'probe',
      contractVersion: ADMIN_CONTRACT_VERSION,
      execute: () => ({ ok: true, secret: 'should-not-be-logged' }),
    })

    const res = await client
      .post(`${PREFIX}/actions/${CUSTOM_ACTION}`)
      .header('x-admin-id', ADMIN_ID)
    res.assertStatus(200)

    const row = await latest(null, 'admin:action:dispatch')
    assert.isNotNull(row)
    assert.equal(row!.actorId, ADMIN_ID)
    const meta = parseMetadata(row!)
    assert.equal(meta?.name, CUSTOM_ACTION)
    // The action's return value (which contains a secret) must not be logged.
    assert.notProperty(meta, 'secret')
  })

  test('a failing audit write never fails the mutation (chaos)', async ({ client, assert }) => {
    const throwing = {
      log: async () => {
        throw new Error('audit down')
      },
    } as unknown as AuditLogService
    app.container.singleton(AuditLogService, () => throwing)
    try {
      const res = await client
        .post(`${PREFIX}/tenants/${tenantId}/webhooks`)
        .header('x-admin-id', ADMIN_ID)
        .json({ url: 'https://example.com/chaos', events: ['user.created'] })
      // The mutation still succeeds even though the audit write throws.
      res.assertStatus(201)
      assert.isString((res.body() as any).data.id)
    } finally {
      app.container.singleton(AuditLogService, () => new AuditLogService())
    }
  })

  // ── Remaining families + verbs: one runtime attribution assertion each ──────

  test('webhook update (real change) writes an admin:webhook:update row', async ({
    client,
    assert,
  }) => {
    const created = await client
      .post(`${PREFIX}/tenants/${tenantId}/webhooks`)
      .header('x-admin-id', ADMIN_ID)
      .json({ url: 'https://example.com/upd', events: ['user.created'] })
    created.assertStatus(201)
    const webhookId = (created.body() as any).data.id

    const upd = await client
      .put(`${PREFIX}/tenants/${tenantId}/webhooks/${webhookId}`)
      .header('x-admin-id', ADMIN_ID)
      .json({ enabled: false })
    upd.assertStatus(200)

    const row = await latest(tenantId, 'admin:webhook:update')
    assert.isNotNull(row)
    const meta = parseMetadata(row!)
    assert.equal(meta?.webhookId, webhookId)
    assert.deepEqual(meta?.changed, ['enabled'])
  })

  test('feature flag update writes an admin:feature_flag:update row', async ({
    client,
    assert,
  }) => {
    await client
      .post(`${PREFIX}/tenants/${tenantId}/feature-flags`)
      .header('x-admin-id', ADMIN_ID)
      .json({ flag: 'ff_upd', enabled: true })
    const upd = await client
      .put(`${PREFIX}/tenants/${tenantId}/feature-flags/ff_upd`)
      .header('x-admin-id', ADMIN_ID)
      .json({ enabled: false })
    upd.assertStatus(200)

    const row = await latest(tenantId, 'admin:feature_flag:update')
    assert.isNotNull(row)
    const meta = parseMetadata(row!)
    assert.equal(meta?.flag, 'ff_upd')
    assert.equal(meta?.enabled, false)
  })

  test('feature flag delete: existing writes one row, missing 404s with none', async ({
    client,
    assert,
  }) => {
    await client
      .post(`${PREFIX}/tenants/${tenantId}/feature-flags`)
      .header('x-admin-id', ADMIN_ID)
      .json({ flag: 'ff_del', enabled: true })

    const del = await client
      .delete(`${PREFIX}/tenants/${tenantId}/feature-flags/ff_del`)
      .header('x-admin-id', ADMIN_ID)
    del.assertStatus(204)
    assert.equal(await count(tenantId, 'admin:feature_flag:delete'), 1)

    const missing = await client
      .delete(`${PREFIX}/tenants/${tenantId}/feature-flags/does_not_exist`)
      .header('x-admin-id', ADMIN_ID)
    missing.assertStatus(404)
    assert.equal(await count(tenantId, 'admin:feature_flag:delete'), 1)
  })

  test('branding update writes an admin:branding:update row with the changed keys', async ({
    client,
    assert,
  }) => {
    const upd = await client
      .put(`${PREFIX}/tenants/${tenantId}/branding`)
      .header('x-admin-id', ADMIN_ID)
      .json({ fromName: 'Acme', primaryColor: '#3b82f6' })
    upd.assertStatus(200)

    const row = await latest(tenantId, 'admin:branding:update')
    assert.isNotNull(row)
    const changed = parseMetadata(row!)?.changed as string[]
    assert.isTrue(changed.includes('fromName'))
    assert.isTrue(changed.includes('primaryColor'))
  })

  test('sso update/disable are attributed and never log the clientSecret', async ({
    client,
    assert,
  }) => {
    const upd = await client
      .put(`${PREFIX}/tenants/${tenantId}/sso`)
      .header('x-admin-id', ADMIN_ID)
      .json({
        clientId: 'cid',
        clientSecret: 'shh-not-logged',
        issuerUrl: 'https://issuer.test',
        redirectUri: 'https://app.test/callback',
        scopes: ['openid'],
      })
    upd.assertStatus(200)

    const updRow = await latest(tenantId, 'admin:sso:update')
    assert.isNotNull(updRow)
    const meta = parseMetadata(updRow!)
    assert.equal(meta?.clientId, 'cid')
    assert.equal(meta?.issuerUrl, 'https://issuer.test')
    assert.isString(meta?.provider)
    // The secret in scope at the call site must never reach the row.
    assert.notProperty(meta, 'clientSecret')
    assert.notProperty(meta, 'secret')

    const disable1 = await client
      .post(`${PREFIX}/tenants/${tenantId}/sso/disable`)
      .header('x-admin-id', ADMIN_ID)
    disable1.assertStatus(200)
    assert.equal(await count(tenantId, 'admin:sso:disable'), 1)

    // Already disabled → no-op, no second row.
    const disable2 = await client
      .post(`${PREFIX}/tenants/${tenantId}/sso/disable`)
      .header('x-admin-id', ADMIN_ID)
    disable2.assertStatus(200)
    assert.equal((disable2.body() as any).unchanged, true)
    assert.equal(await count(tenantId, 'admin:sso:disable'), 1)
  })

  test('quota set_usage and reset are attributed', async ({ client, assert }) => {
    const set = await client
      .put(`${PREFIX}/tenants/${tenantId}/quotas/usage`)
      .header('x-admin-id', ADMIN_ID)
      .json({ quota: 'seats', value: 5 })
    set.assertStatus(200)
    const setRow = await latest(tenantId, 'admin:quota:set_usage')
    assert.isNotNull(setRow)
    const setMeta = parseMetadata(setRow!)
    assert.equal(setMeta?.quota, 'seats')
    assert.equal(setMeta?.value, 5)

    const reset = await client
      .post(`${PREFIX}/tenants/${tenantId}/quotas/reset`)
      .header('x-admin-id', ADMIN_ID)
    reset.assertStatus(200)
    const resetRow = await latest(tenantId, 'admin:quota:reset')
    assert.isNotNull(resetRow)
    assert.equal(parseMetadata(resetRow!)?.quota, 'all')
  })

  test('REST suspend writes an attributed admin:tenant:suspend row', async ({ client, assert }) => {
    const res = await client
      .post(`${PREFIX}/tenants/${tenantId}/suspend`)
      .header('x-admin-id', ADMIN_ID)
    res.assertStatus(200)
    const row = await latest(tenantId, 'admin:tenant:suspend')
    assert.isNotNull(row)
    assert.equal(row!.actorType, 'admin')
    assert.equal(row!.actorId, ADMIN_ID)
    assert.equal(parseMetadata(row!)?.status, 'suspended')
  })

  test('REST destroy (schema dropped) writes admin:tenant:destroy with schemaDropped true', async ({
    client,
    assert,
  }) => {
    const res = await client
      .post(`${PREFIX}/tenants/${tenantId}/destroy`)
      .header('x-admin-id', ADMIN_ID)
    res.assertStatus(200)
    const row = await latest(tenantId, 'admin:tenant:destroy')
    assert.isNotNull(row)
    assert.equal(parseMetadata(row!)?.schemaDropped, true)
  })

  test('REST destroy (keepSchema) then restore are both attributed', async ({ client, assert }) => {
    const destroy = await client
      .post(`${PREFIX}/tenants/${tenantId}/destroy`)
      .header('x-admin-id', ADMIN_ID)
      .json({ keepSchema: true })
    destroy.assertStatus(200)
    assert.equal(
      parseMetadata((await latest(tenantId, 'admin:tenant:destroy'))!)?.schemaDropped,
      false
    )

    const restore = await client
      .post(`${PREFIX}/tenants/${tenantId}/restore`)
      .header('x-admin-id', ADMIN_ID)
    restore.assertStatus(200)
    const restoreRow = await latest(tenantId, 'admin:tenant:restore')
    assert.isNotNull(restoreRow)
    assert.equal(restoreRow!.actorId, ADMIN_ID)
  })
})
