import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  setupRealAudit,
  realWriter,
  auditRow,
  centralConn,
} from '../../../helpers/real_audit_pg.js'

/**
 * Fail-closed on a real audit-write outage: with the audit table gone from under
 * the writer, an append must fail-closed with `audit_write_failed` (503), never a
 * silent success (the fail-closed matrix). Self-skips when Postgres is unavailable.
 */
let ready = false

test.group('AI audit fail-closed on a write outage (real pg)', (group) => {
  group.setup(async () => {
    const s = await setupRealAudit()
    ready = s.ready
    return s.cleanup
  })

  test('a write outage (the table is gone) is a fail-closed 503, never a silent success', async ({
    assert,
  }) => {
    await db
      .connection(centralConn())
      .rawQuery('DROP TABLE IF EXISTS backoffice.ai_audit_logs CASCADE')

    const writer = realWriter('t-down')
    let threw: unknown
    try {
      await writer.append(auditRow('t-down'))
    } catch (error) {
      threw = error
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'audit_write_failed')
    assert.equal((threw as AIException).httpStatus, 503)
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
