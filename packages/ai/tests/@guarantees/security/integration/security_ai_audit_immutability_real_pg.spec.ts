import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  setupRealAudit,
  realWriter,
  auditRow,
  centralConn,
  rowsOfResult,
} from '../../../helpers/real_audit_pg.js'

/**
 * The append-only proof on REAL Postgres: the writer appends a row, then
 * UPDATE / DELETE / TRUNCATE are each rejected by the DB triggers regardless of
 * role, and the row is unchanged and still present. Mirrors core's
 * `security_audit_immutability.spec.ts`. Self-skips when Postgres is unavailable
 * (local), runs in CI.
 */
let ready = false

test.group('AI audit append-only enforcement (real pg)', (group) => {
  group.setup(async () => {
    const s = await setupRealAudit()
    ready = s.ready
    return s.cleanup
  })

  test('INSERT is allowed; UPDATE, DELETE and TRUNCATE are rejected at the database', async ({
    assert,
  }) => {
    const writer = realWriter('t-imm')
    const entry = await writer.append(auditRow('t-imm'))
    assert.equal(entry.seq, 1)

    const client = db.connection(centralConn())
    await assert.rejects(
      () =>
        client.rawQuery('UPDATE backoffice.ai_audit_logs SET tokens = 0 WHERE id = ?', [entry.id]),
      /append-only|insufficient_privilege/i
    )
    await assert.rejects(
      () => client.rawQuery('DELETE FROM backoffice.ai_audit_logs WHERE id = ?', [entry.id]),
      /append-only|insufficient_privilege/i
    )
    await assert.rejects(
      () => client.rawQuery('TRUNCATE backoffice.ai_audit_logs'),
      /append-only|insufficient_privilege/i
    )

    const res = await client.rawQuery('SELECT tokens FROM backoffice.ai_audit_logs WHERE id = ?', [
      entry.id,
    ])
    assert.equal(Number(rowsOfResult(res)[0].tokens), 10)
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
