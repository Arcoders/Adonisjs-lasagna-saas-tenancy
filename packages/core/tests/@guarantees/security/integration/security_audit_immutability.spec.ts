import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { createTestTenant, destroyTestTenant } from '../../../integration/helpers/tenant.js'

/**
 * S1-2: enforces that audit rows are append-only at the DATABASE
 * level, not just by convention. The migration stub installs PG
 * triggers that raise on UPDATE/DELETE; the integration bootstrap
 * mirrors them. If a host app strips the triggers (or runs against
 * an old schema), this test fails loudly.
 */
test.group('tenant_audit_logs — append-only enforcement', (group) => {
  const cleanup: string[] = []

  group.each.teardown(async () => {
    while (cleanup.length) {
      const id = cleanup.pop()!
      // INSERT on audit logs is allowed — clean up via a privileged path
      // that bypasses the DELETE trigger. We disable the trigger for the
      // lifetime of this transaction, delete the rows, and restore.
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

  test('INSERT succeeds (append is allowed)', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const log = await TenantAuditLog.create({
      tenantId: t.id,
      actorType: 'admin',
      actorId: null,
      action: 'tenant.created',
      metadata: { source: 'test' },
      ipAddress: '127.0.0.1',
    })
    assert.isString(log.id)
    assert.equal(log.action, 'tenant.created')
  })

  test('UPDATE raises an exception — audit rows are immutable', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const log = await TenantAuditLog.create({
      tenantId: t.id,
      actorType: 'admin',
      actorId: null,
      action: 'tenant.created',
      metadata: null,
      ipAddress: null,
    })

    // Two paths a hostile actor might try: ORM .save() and a raw query
    // that bypasses Lucid hooks. Both must hit the trigger.
    log.action = 'spoofed.action'
    await assert.rejects(
      () => log.save(),
      /append-only|UPDATE\/DELETE is forbidden|insufficient_privilege/i
    )
    await assert.rejects(
      () =>
        db
          .connection('backoffice')
          .query()
          .from('tenant_audit_logs')
          .where('id', log.id)
          .update({ action: 'raw.spoof' }),
      /append-only|UPDATE\/DELETE is forbidden|insufficient_privilege/i
    )

    // Confirm the row is unchanged on disk after both attempts.
    const fresh = await TenantAuditLog.find(log.id)
    assert.equal(fresh!.action, 'tenant.created', 'audit row content must not have shifted')
  })

  test('DELETE raises an exception — audit rows cannot be erased', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const log = await TenantAuditLog.create({
      tenantId: t.id,
      actorType: 'admin',
      actorId: null,
      action: 'sensitive.read',
      metadata: null,
      ipAddress: null,
    })

    await assert.rejects(
      () => log.delete(),
      /append-only|UPDATE\/DELETE is forbidden|insufficient_privilege/i
    )
    await assert.rejects(
      () =>
        db.connection('backoffice').query().from('tenant_audit_logs').where('id', log.id).delete(),
      /append-only|UPDATE\/DELETE is forbidden|insufficient_privilege/i
    )

    const fresh = await TenantAuditLog.find(log.id)
    assert.isNotNull(fresh, 'audit row must still exist after rejected DELETE attempts')
    assert.equal(fresh!.action, 'sensitive.read')
  })

  test('TRUNCATE is blocked — statement-level trigger closes the per-row bypass', async ({
    assert,
  }) => {
    // PG quirk: per-row DELETE triggers do NOT fire on TRUNCATE.
    // The migration installs a separate BEFORE TRUNCATE statement-level
    // trigger to close that gap. Without it, an attacker with table-
    // level privileges could erase the entire audit history in one shot.
    const t = await createTestTenant()
    cleanup.push(t.id)

    await TenantAuditLog.create({
      tenantId: t.id,
      actorType: 'admin',
      actorId: null,
      action: 'truncate.canary',
      metadata: null,
      ipAddress: null,
    })

    await assert.rejects(
      () => db.rawQuery('TRUNCATE backoffice.tenant_audit_logs'),
      /append-only|UPDATE\/DELETE is forbidden|insufficient_privilege/i
    )

    // The canary must still be there.
    const survivor = await TenantAuditLog.query()
      .where('tenant_id', t.id)
      .where('action', 'truncate.canary')
      .first()
    assert.isNotNull(survivor, 'TRUNCATE must not have erased the canary row')
  })
})
