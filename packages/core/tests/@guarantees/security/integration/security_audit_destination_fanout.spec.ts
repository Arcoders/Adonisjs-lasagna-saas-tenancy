import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  AuditLogService,
  AuditLogDestinationRegistry,
  AUDIT_CONTRACT_VERSION,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { AuditLogEntry } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../../../integration/helpers/tenant.js'

/**
 * The audit destination fan-out. The canonical DB row stays authoritative: a
 * slow or throwing host destination must never fail the audited operation nor
 * change what `log()` returns. A healthy destination still receives the entry.
 */
test.group('AuditLogService — destination fan-out (integration)', (group) => {
  const svc = new AuditLogService()
  const tenantIds: string[] = []
  const received: AuditLogEntry[] = []

  group.setup(async () => {
    const registry = await app.container.make(AuditLogDestinationRegistry)
    if (!registry.has('recorder')) {
      registry.register({
        name: 'recorder',
        contractVersion: AUDIT_CONTRACT_VERSION,
        write: (entry) => {
          received.push(entry)
        },
      })
    }
    if (!registry.has('boom')) {
      registry.register({
        name: 'boom',
        contractVersion: AUDIT_CONTRACT_VERSION,
        write: () => {
          throw new Error('sink down')
        },
      })
    }
  })

  // Clear our destinations after the suite so other audit suites see the empty
  // default registry (their log() calls must not fan out to our doubles).
  group.teardown(async () => {
    const registry = await app.container.make(AuditLogDestinationRegistry)
    registry.clear()
  })

  group.each.setup(() => {
    received.length = 0
  })

  group.each.teardown(async () => {
    while (tenantIds.length) {
      const id = tenantIds.pop()!
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

  test('a throwing destination never breaks the DB write or the return value', async ({
    assert,
  }) => {
    const t = await createTestTenant()
    tenantIds.push(t.id)

    const row = await svc.log({ tenantId: t.id, action: 'thing.done' })

    // The canonical row is returned despite the 'boom' destination throwing.
    assert.equal(row.action, 'thing.done')
    assert.equal(row.tenantId, t.id)

    // The healthy destination still received the persisted entry.
    assert.lengthOf(received, 1)
    assert.equal(received[0].id, row.id)
    assert.equal(received[0].action, 'thing.done')
    assert.equal(received[0].tenantId, t.id)
  })
})
