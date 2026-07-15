import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import WormShredLedger from '../../../../src/services/worm_shred_ledger.js'
import type { WormLedgerWriter } from '@adonisjs-lasagna/saas-tenancy/internal'

/** A recording WormLedgerWriter double: captures each append and returns an incrementing seq. */
class FakeWriter {
  readonly appends: Array<Record<string, unknown>> = []
  #seq = 0
  async append(row: Record<string, unknown>): Promise<{ seq: number }> {
    this.appends.push(row)
    return { seq: ++this.#seq }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// The crypto ShredLedger adapts the shared append-only WormLedgerWriter. Because the
// ledger forbids UPDATE/DELETE, COMMITTED is recorded by appending a second row that
// references the PENDING seq (never a mutation). The subject id is hashed before it reaches
// the ledger, so the WORM chain stays non-PII (keeping it forever leaks nothing).
test.group('crypto WormShredLedger: append-only two-phase, non-PII', () => {
  test('appendPending writes a hashed subject and returns the PENDING seq handle', async ({
    assert,
  }) => {
    const writer = new FakeWriter()
    const ledger = new WormShredLedger(writer as unknown as WormLedgerWriter)

    const pending = await ledger.appendPending({
      tenantId: 't1',
      subjectId: 'renter-42',
      category: 'marketing',
      reason: 'consent',
    })

    assert.equal(pending.tenantId, 't1')
    assert.equal(pending.id, '1') // the writer's seq, as a string handle
    assert.lengthOf(writer.appends, 1)
    const row = writer.appends[0]!
    assert.equal(row.action, 'crypto:shred:pending')
    assert.equal(row.category, 'marketing')
    assert.equal(row.reason, 'consent')
    // The raw subject id NEVER reaches the ledger, only its sha256 digest.
    assert.equal(row.subjectHash, sha256('renter-42'))
    assert.notEqual(row.subjectHash, 'renter-42')
  })

  test('markCommitted APPENDS a committed marker referencing the PENDING seq (never mutates)', async ({
    assert,
  }) => {
    const writer = new FakeWriter()
    const ledger = new WormShredLedger(writer as unknown as WormLedgerWriter)

    const pending = await ledger.appendPending({ tenantId: 't1', subjectId: 's', category: 'c' })
    await ledger.markCommitted(pending)

    assert.lengthOf(writer.appends, 2) // two appends, never an update
    const committed = writer.appends[1]!
    assert.equal(committed.action, 'crypto:shred:committed')
    assert.isNull(committed.subjectHash) // the committed marker carries no PII
    assert.deepEqual(committed.metadata, { refSeq: 1 }) // references the PENDING seq
  })
})
