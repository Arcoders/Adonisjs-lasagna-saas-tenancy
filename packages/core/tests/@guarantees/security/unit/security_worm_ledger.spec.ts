import { test } from '@japa/runner'
import WormLedgerWriter, {
  WORM_LEDGER_COLUMNS,
  WormLedgerScopeError,
  WormLedgerWriteError,
  wormChecksum,
  type WormDb,
  type WormLedgerRow,
  type WormQueryClient,
} from '../../../../src/services/worm_ledger_writer.js'

/**
 * An in-memory `backoffice.worm_ledger` that answers the writer's four query
 * shapes (advisory lock, tail read, insert, verify sweep). It stores rows exactly
 * as the writer binds them, and returns `metadata` as a parsed object so it models
 * jsonb readback (key order NOT preserved), which the stableStringify checksum must
 * survive.
 */
class FakeWormLedger {
  rows: Array<Record<string, unknown>> = []

  db(): WormDb {
    return { connection: () => this.#client() }
  }

  #client(): WormQueryClient {
    const self = this
    const client: WormQueryClient = {
      async rawQuery(sql: string, bindings: readonly unknown[] = []) {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (sql.includes('ORDER BY seq DESC')) {
          const tid = bindings[0]
          const tail = self.rows
            .filter((r) => r.tenant_id === tid)
            .sort((a, b) => Number(b.seq) - Number(a.seq))[0]
          return { rows: tail ? [{ seq: tail.seq, checksum: tail.checksum }] : [] }
        }
        if (sql.includes('INSERT INTO')) {
          const insertedRow: Record<string, unknown> = {}
          WORM_LEDGER_COLUMNS.forEach((col, i) => (insertedRow[col] = bindings[i]))
          if (typeof insertedRow.metadata === 'string')
            insertedRow.metadata = JSON.parse(insertedRow.metadata as string)
          self.rows.push(insertedRow)
          return { rows: [] }
        }
        if (sql.includes('ORDER BY tenant_id')) {
          let rows = self.rows
          if (sql.includes('WHERE tenant_id'))
            rows = rows.filter((r) => r.tenant_id === bindings[0])
          rows = [...rows].sort(
            (a, b) =>
              String(a.tenant_id).localeCompare(String(b.tenant_id)) ||
              Number(a.seq) - Number(b.seq)
          )
          return { rows }
        }
        return { rows: [] }
      },
      async transaction(cb) {
        return cb(client)
      },
    }
    return client
  }
}

function row(overrides: Partial<WormLedgerRow> = {}): WormLedgerRow {
  return {
    tenantId: 'tenant-1',
    action: 'crypto:shred:pending',
    subjectHash: 'a'.repeat(64),
    category: 'marketing',
    reason: 'consent',
    metadata: {},
    occurredAt: '2026-07-04T10:00:00.000Z',
    ...overrides,
  }
}

function writer(fake: FakeWormLedger, activeScopeTenantId?: () => string | undefined) {
  return new WormLedgerWriter({
    getDb: async () => fake.db(),
    connectionName: 'backoffice',
    activeScopeTenantId,
  })
}

test.group('WORM ledger — append-only hash chain', () => {
  test('append links a per-tenant chain (seq, prev, checksum) that verifies', async ({
    assert,
  }) => {
    const fake = new FakeWormLedger()
    const w = writer(fake)
    const e1 = await w.append(row({ action: 'a1' }))
    const e2 = await w.append(row({ action: 'a2' }))
    const e3 = await w.append(row({ action: 'a3' }))

    assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3])
    assert.isNull(e1.prevChecksum)
    assert.equal(e2.prevChecksum, e1.checksum)
    assert.equal(e3.prevChecksum, e2.checksum)
    assert.equal(e2.checksum, wormChecksum(row({ action: 'a2' }), 2, e1.checksum))

    const result = await w.verify('tenant-1')
    assert.isTrue(result.ok)
    assert.equal(result.checked, 3)
  })

  test('each tenant has its own chain starting at seq 1', async ({ assert }) => {
    const fake = new FakeWormLedger()
    const w = writer(fake)
    const a = await w.append(row({ tenantId: 'A' }))
    const b = await w.append(row({ tenantId: 'B' }))
    assert.deepEqual([a.seq, b.seq], [1, 1])
    assert.isTrue((await w.verify()).ok)
  })

  test('metadata key order does not change the checksum (jsonb reordering survives)', async ({
    assert,
  }) => {
    const fake = new FakeWormLedger()
    const w = writer(fake)
    await w.append(row({ metadata: { alpha: 1, beta: 2 } }))
    // Simulate jsonb readback reordering the keys.
    fake.rows[0].metadata = { beta: 2, alpha: 1 }
    assert.isTrue((await w.verify('tenant-1')).ok)
  })

  test('a rewritten row is caught as a checksum break', async ({ assert }) => {
    const fake = new FakeWormLedger()
    const w = writer(fake)
    await w.append(row({ action: 'a1' }))
    await w.append(row({ action: 'a2' }))
    fake.rows[1].action = 'tampered' // rewrite past the (disabled) triggers
    const result = await w.verify('tenant-1')
    assert.isFalse(result.ok)
    assert.equal(result.break?.reason, 'checksum')
    assert.equal(result.break?.seq, 2)
  })

  test('a deleted row is caught as a gap', async ({ assert }) => {
    const fake = new FakeWormLedger()
    const w = writer(fake)
    await w.append(row())
    await w.append(row())
    await w.append(row())
    fake.rows.splice(1, 1) // delete seq 2
    const result = await w.verify('tenant-1')
    assert.isFalse(result.ok)
    assert.equal(result.break?.reason, 'gap')
  })

  test('a broken prev-link is caught', async ({ assert }) => {
    const fake = new FakeWormLedger()
    const w = writer(fake)
    await w.append(row())
    await w.append(row())
    fake.rows[1].prev_checksum = 'b'.repeat(64)
    const result = await w.verify('tenant-1')
    assert.isFalse(result.ok)
    assert.equal(result.break?.reason, 'prev_link')
  })
})

test.group('WORM ledger — fail-closed', () => {
  test('a write failure throws WormLedgerWriteError (never a silent success)', async ({
    assert,
  }) => {
    const w = new WormLedgerWriter({
      getDb: async () => {
        throw new Error('db down')
      },
      connectionName: 'backoffice',
    })
    await assert.rejects(() => w.append(row()), /could not be written/)
    try {
      await w.append(row())
      assert.fail('expected a throw')
    } catch (error) {
      assert.instanceOf(error, WormLedgerWriteError)
    }
  })

  test('an append whose tenant differs from the active scope is refused', async ({ assert }) => {
    const fake = new FakeWormLedger()
    const w = writer(fake, () => 'other-tenant')
    try {
      await w.append(row({ tenantId: 'tenant-1' }))
      assert.fail('expected a scope error')
    } catch (error) {
      assert.instanceOf(error, WormLedgerScopeError)
    }
    assert.lengthOf(fake.rows, 0)
  })
})
