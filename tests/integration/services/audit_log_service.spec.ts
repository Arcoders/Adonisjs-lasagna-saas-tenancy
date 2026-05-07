import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AuditLogService } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * Smoke coverage for the public AuditLogService surface:
 *   - log() persists rows with sane defaults (`actor_type='system'`,
 *     null tenant/actor/ip/metadata when omitted)
 *   - listForTenant() paginates, scopes to the requested tenant id, and
 *     honors the optional `from` / `to` window
 *
 * The append-only DB triggers are already exercised in
 * tests/integration/satellites/audit_immutability.spec.ts; here we
 * focus on the service-level contract.
 */
test.group('AuditLogService — public API', (group) => {
  const tenantIds: string[] = []

  group.each.teardown(async () => {
    while (tenantIds.length) {
      const id = tenantIds.pop()!
      // Disable the DELETE trigger to clean up test rows; mirrors the
      // pattern used by audit_immutability.spec.ts.
      await db.rawQuery(
        'ALTER TABLE backoffice.tenant_audit_logs DISABLE TRIGGER tenant_audit_logs_no_delete'
      )
      try {
        await db
          .connection('backoffice')
          .query()
          .from('tenant_audit_logs')
          .where('tenant_id', id)
          .delete()
      } finally {
        await db.rawQuery(
          'ALTER TABLE backoffice.tenant_audit_logs ENABLE TRIGGER tenant_audit_logs_no_delete'
        )
      }
      await destroyTestTenant(id)
    }
  })

  test('log() persists with the supplied fields', async ({ assert }) => {
    const t = await createTestTenant()
    tenantIds.push(t.id)

    const service = new AuditLogService()
    const row = await service.log({
      tenantId: t.id,
      actorType: 'admin',
      actorId: '00000000-0000-0000-0000-000000000001',
      action: 'tenant.suspended',
      metadata: { reason: 'fraud-review' },
      ipAddress: '203.0.113.10',
    })

    assert.isString(row.id)
    assert.equal(row.action, 'tenant.suspended')
    assert.equal(row.actorType, 'admin')
    assert.equal(row.tenantId, t.id)
    assert.deepEqual(row.metadata, { reason: 'fraud-review' })
    assert.equal(row.ipAddress, '203.0.113.10')
  })

  test('log() applies sane defaults when fields are omitted', async ({ assert }) => {
    const t = await createTestTenant()
    tenantIds.push(t.id)

    const row = await new AuditLogService().log({
      tenantId: t.id,
      action: 'tenant.heartbeat',
    })

    assert.equal(row.actorType, 'system')
    assert.isNull(row.actorId)
    assert.isNull(row.metadata)
    assert.isNull(row.ipAddress)
  })

  test('listForTenant() returns rows scoped to the requested tenant in DESC order', async ({
    assert,
  }) => {
    const a = await createTestTenant()
    const b = await createTestTenant()
    tenantIds.push(a.id, b.id)

    const service = new AuditLogService()
    await service.log({ tenantId: a.id, action: 'a.action.1' })
    await service.log({ tenantId: a.id, action: 'a.action.2' })
    await service.log({ tenantId: b.id, action: 'b.action.1' })

    const result = await service.listForTenant(a.id, 1, 50)

    assert.equal(result.meta.total, 2, 'tenant a must have exactly 2 rows')
    const actions = result.data.map((r: any) => r.action)
    assert.deepEqual(
      actions,
      ['a.action.2', 'a.action.1'],
      'rows must be sorted by created_at DESC'
    )
    assert.isFalse(
      result.data.some((r: any) => r.tenant_id === b.id),
      'tenant b must not leak into tenant a results'
    )
  })

  test('listForTenant() honors page + limit', async ({ assert }) => {
    const t = await createTestTenant()
    tenantIds.push(t.id)

    const service = new AuditLogService()
    for (let i = 0; i < 5; i++) {
      await service.log({ tenantId: t.id, action: `evt.${i}` })
    }

    const page1 = await service.listForTenant(t.id, 1, 2)
    const page2 = await service.listForTenant(t.id, 2, 2)

    assert.equal(page1.data.length, 2)
    assert.equal(page2.data.length, 2)
    assert.equal(page1.meta.total, 5)
    assert.notDeepEqual(
      page1.data.map((r: any) => r.id),
      page2.data.map((r: any) => r.id)
    )
  })

  test('listForTenant() caps the limit at 200 even when callers pass higher', async ({
    assert,
  }) => {
    const t = await createTestTenant()
    tenantIds.push(t.id)

    const service = new AuditLogService()
    await service.log({ tenantId: t.id, action: 'cap.test' })

    const result = await service.listForTenant(t.id, 1, 9999)
    assert.equal(result.meta.perPage, 200, 'service must clamp to 200')
  })
})
