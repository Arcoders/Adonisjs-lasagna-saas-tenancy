import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { ComplianceReportService, AuditLogService } from '@adonisjs-lasagna/saas-tenancy/services'
import { type TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy/models/satellites'

/**
 * Proves the compliance posture controls detect REAL database state, not a
 * stubbed snapshot: the audit-immutability control's catalog query must see the
 * three triggers the migration installs, and AuditLogService.exportStream must
 * stream the rows it wrote back, in order, filtered by tenant and date range.
 */
async function purge(tenantId: string) {
  await db.rawQuery(
    'ALTER TABLE backoffice.tenant_audit_logs DISABLE TRIGGER tenant_audit_logs_no_delete'
  )
  try {
    await db
      .connection('backoffice')
      .query()
      .from('tenant_audit_logs')
      .where('tenant_id', tenantId)
      .delete()
  } finally {
    await db.rawQuery(
      'ALTER TABLE backoffice.tenant_audit_logs ENABLE TRIGGER tenant_audit_logs_no_delete'
    )
  }
}

test.group('compliance — audit-immutability control (real PG)', () => {
  test('detects the three append-only triggers as satisfied', async ({ assert }) => {
    const svc = await app.container.make(ComplianceReportService)
    const report = await svc.run({ controls: ['audit-immutability'] })
    assert.lengthOf(report.controls, 1)
    assert.equal(report.controls[0].status, 'satisfied')
    assert.match(report.controls[0].evidence, /BEFORE UPDATE\/DELETE\/TRUNCATE/)
  })
})

test.group('compliance — AuditLogService.exportStream (real PG)', (group) => {
  const probe = randomUUID()
  const other = randomUUID()

  group.setup(async () => {
    const audit = await app.container.make(AuditLogService)
    // Insert with explicit, ascending timestamps via the model, then backdate
    // two rows so the range filter has something to exclude.
    for (const action of ['a', 'b', 'c']) {
      await audit.log({ tenantId: probe, actorType: 'system', action: `export.${action}` })
    }
    await audit.log({ tenantId: other, actorType: 'system', action: 'export.other' })

    // Backdate the first probe row to 2020 so a 2026 lower-bound excludes it.
    await db.rawQuery(
      'ALTER TABLE backoffice.tenant_audit_logs DISABLE TRIGGER tenant_audit_logs_no_update'
    )
    try {
      await db
        .connection('backoffice')
        .query()
        .from('tenant_audit_logs')
        .where('tenant_id', probe)
        .where('action', 'export.a')
        .update({ created_at: '2020-01-01T00:00:00Z' })
    } finally {
      await db.rawQuery(
        'ALTER TABLE backoffice.tenant_audit_logs ENABLE TRIGGER tenant_audit_logs_no_update'
      )
    }
  })

  group.teardown(async () => {
    await purge(probe)
    await purge(other)
  })

  async function collect(opts: Parameters<AuditLogService['exportStream']>[0]) {
    const audit = await app.container.make(AuditLogService)
    const rows: TenantAuditLog[] = []
    for await (const batch of audit.exportStream(opts)) rows.push(...batch)
    return rows
  }

  test('streams only the requested tenant, oldest first', async ({ assert }) => {
    const rows = await collect({ tenantId: probe })
    assert.lengthOf(rows, 3)
    assert.deepEqual(
      rows.map((r) => r.action),
      ['export.a', 'export.b', 'export.c']
    )
    assert.isTrue(rows.every((r) => r.tenantId === probe))
  })

  test('honors the from bound', async ({ assert }) => {
    const rows = await collect({ tenantId: probe, from: new Date('2026-01-01T00:00:00Z') })
    assert.deepEqual(
      rows.map((r) => r.action),
      ['export.b', 'export.c']
    )
  })

  test('batches without dropping rows when batchSize < total', async ({ assert }) => {
    const rows = await collect({ tenantId: probe, batchSize: 2 })
    assert.lengthOf(rows, 3)
  })
})
