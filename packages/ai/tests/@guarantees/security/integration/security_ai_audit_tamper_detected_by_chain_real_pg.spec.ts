import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  setupRealAudit,
  realWriter,
  auditRow,
  centralConn,
} from '../../../helpers/real_audit_pg.js'

/**
 * The tamper-evidence proof on REAL Postgres: the triggers stop UPDATE/DELETE, but
 * a superuser can DISABLE a trigger, rewrite a row, and re-ENABLE it. The per-tenant
 * hash chain catches exactly that: after the rewrite, the recomputed checksum no
 * longer matches the stored one, so `verify()` reports the break at that seq. Uses
 * the DISABLE/ENABLE TRIGGER idiom from core's immutability spec. Self-skips locally.
 */
let ready = false

test.group('AI audit tamper is caught by the hash chain (real pg)', (group) => {
  group.setup(async () => {
    const s = await setupRealAudit()
    ready = s.ready
    return s.cleanup
  })

  test('a row rewritten past a disabled trigger breaks verify() at its seq', async ({ assert }) => {
    // tenant_id is a `uuid` column, so the id must be a real UUID.
    const tenant = randomUUID()
    const writer = realWriter(tenant)
    await writer.append(auditRow(tenant))
    const middle = await writer.append(auditRow(tenant))
    await writer.append(auditRow(tenant))

    assert.isTrue((await writer.verify(tenant)).ok, 'the untampered chain must verify clean')

    // A superuser disables the trigger, rewrites the MIDDLE row's payload without
    // re-signing it, and re-enables the trigger.
    const client = db.connection(centralConn())
    await client.rawQuery(
      'ALTER TABLE backoffice.ai_audit_logs DISABLE TRIGGER ai_audit_logs_no_update'
    )
    try {
      await client.rawQuery('UPDATE backoffice.ai_audit_logs SET tokens = 99999 WHERE id = ?', [
        middle.id,
      ])
    } finally {
      await client.rawQuery(
        'ALTER TABLE backoffice.ai_audit_logs ENABLE TRIGGER ai_audit_logs_no_update'
      )
    }

    const result = await writer.verify(tenant)
    assert.isFalse(result.ok)
    assert.equal(result.break?.tenantId, tenant)
    assert.equal(result.break?.seq, 2)
    assert.equal(result.break?.reason, 'checksum')
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
