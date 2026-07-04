import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  centralConn,
  createWormLedger,
  dropWormLedger,
  probePg,
  realWormWriter,
} from '../../../helpers/real_crypto_pg.js'

/**
 * The shared WORM ledger's append-only + hash-chain guarantees on REAL Postgres
 * (crypto §6.6): the writer appends, then UPDATE / DELETE / TRUNCATE are each
 * rejected by the DB triggers regardless of role, and `verify()` re-walks the chain
 * and catches a tamper that disabled the triggers, rewrote a row, and re-enabled
 * them. This is the crypto satellite's proof of the core WormLedgerWriter that its
 * two-phase shred audit depends on, which unit tests could only exercise against an
 * in-memory fake. Self-skips when Postgres is unavailable, runs in CI.
 */
function shredEvent(tenantId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId,
    action: 'crypto:shred:pending',
    subjectHash: 'a'.repeat(64),
    category: 'marketing',
    reason: 'consent',
    metadata: {},
    occurredAt: '2026-07-04T12:00:00.000Z',
    ...over,
  }
}

let ready = false

test.group('crypto WORM ledger append-only enforcement (real pg)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    await createWormLedger()
    return async () => dropWormLedger()
  })

  test('INSERT is allowed; UPDATE, DELETE and TRUNCATE are rejected at the database', async ({
    assert,
  }) => {
    const tenantId = randomUUID()
    const writer = realWormWriter(tenantId)
    const entry = await writer.append(shredEvent(tenantId))
    assert.equal(entry.seq, 1)

    const client = db.connection(centralConn())
    await assert.rejects(
      () =>
        client.rawQuery('UPDATE backoffice.worm_ledger SET reason = ? WHERE id = ?', [
          'x',
          entry.id,
        ]),
      /append-only|insufficient_privilege/i
    )
    await assert.rejects(
      () => client.rawQuery('DELETE FROM backoffice.worm_ledger WHERE id = ?', [entry.id]),
      /append-only|insufficient_privilege/i
    )
    await assert.rejects(
      () => client.rawQuery('TRUNCATE backoffice.worm_ledger'),
      /append-only|insufficient_privilege/i
    )

    // The row is unchanged and a clean chain verifies.
    const verdict = await writer.verify(tenantId)
    assert.isTrue(verdict.ok)
    assert.equal(verdict.checked, 1)
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('verify() catches a tamper that slipped past the triggers (checksum break)', async ({
    assert,
  }) => {
    const tenantId = randomUUID()
    const writer = realWormWriter(tenantId)
    await writer.append(shredEvent(tenantId))
    const two = await writer.append(
      shredEvent(tenantId, {
        action: 'crypto:shred:committed',
        subjectHash: null,
        category: null,
        reason: null,
        metadata: { refSeq: 1 },
        occurredAt: '2026-07-04T12:00:01.000Z',
      })
    )

    // Simulate a table owner who disabled the triggers, rewrote a chained field, and
    // re-enabled them. The row-level triggers are bypassed, but the hash chain is not.
    const client = db.connection(centralConn())
    await client.rawQuery('ALTER TABLE backoffice.worm_ledger DISABLE TRIGGER USER')
    await client.rawQuery('UPDATE backoffice.worm_ledger SET action = ? WHERE id = ?', [
      'crypto:shred:tampered',
      two.id,
    ])
    await client.rawQuery('ALTER TABLE backoffice.worm_ledger ENABLE TRIGGER USER')

    const verdict = await writer.verify(tenantId)
    assert.isFalse(verdict.ok, 'the rewritten row breaks the chain')
    assert.equal(verdict.break?.reason, 'checksum')
    assert.equal(verdict.break?.seq, 2)
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
