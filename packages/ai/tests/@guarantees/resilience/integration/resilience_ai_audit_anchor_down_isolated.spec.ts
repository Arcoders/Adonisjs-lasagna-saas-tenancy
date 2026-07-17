import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import AiAuditWriter, { type AuditDb } from '../../../../src/services/ai_audit_writer.js'
import {
  setupRealAudit,
  auditRow,
  centralConn,
  rowsOfResult,
} from '../../../helpers/real_audit_pg.js'

/**
 * Anchoring isolation on REAL Postgres: the canonical row commits FIRST and a down
 * external destination (a throwing SIEM sink) is isolated best-effort, so the
 * request still succeeds and the row is durably written. The integration
 * counterpart of the unit anchor-best-effort spec. Self-skips when Postgres is
 * unavailable.
 */
let ready = false

test.group('AI audit anchoring is isolated from the canonical write (real pg)', (group) => {
  group.setup(async () => {
    const s = await setupRealAudit()
    ready = s.ready
    return s.cleanup
  })

  test('a down anchor destination never fails the request; the canonical row still commits', async ({
    assert,
  }) => {
    // tenant_id is a `uuid` column, so the id must be a real UUID.
    const tenant = randomUUID()
    const writer = new AiAuditWriter({
      getDb: async () => db as unknown as AuditDb,
      connectionName: centralConn(),
      schemaName: 'backoffice',
      activeScopeTenantId: () => tenant,
      getDestinations: async () => ({
        list: () => [
          {
            name: 'siem',
            write() {
              throw new Error('siem down')
            },
          },
        ],
      }),
      runExtension: (fn) => fn(),
    })

    const entry = await writer.append(auditRow(tenant))
    assert.equal(entry.seq, 1)

    const res = await db
      .connection(centralConn())
      .rawQuery('SELECT count(*)::int AS n FROM backoffice.ai_audit_logs WHERE tenant_id = ?', [
        tenant,
      ])
    assert.equal(Number(rowsOfResult(res)[0]!.n), 1)
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
