import { test } from '@japa/runner'
import AiAuditWriter, { auditChecksum } from '../../../../src/services/ai_audit_writer.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeAuditEnv, sampleAuditRow } from '../../../helpers/fake_audit_db.js'

test.group('behavior — AiAuditWriter append', () => {
  test('the first append is seq 1 with a null prev and a matching checksum', async ({ assert }) => {
    const env = fakeAuditEnv()
    const entry = await new AiAuditWriter(env.deps).append(sampleAuditRow())
    assert.equal(entry.seq, 1)
    assert.isNull(entry.prevChecksum)
    assert.equal(entry.checksum, auditChecksum(sampleAuditRow(), 1, null))
    assert.match(entry.id, /^[0-9a-f-]{36}$/)
  })

  test('a second append is seq 2 linked to the first checksum (per-tenant chain)', async ({
    assert,
  }) => {
    const writer = new AiAuditWriter(fakeAuditEnv().deps)
    const e1 = await writer.append(sampleAuditRow())
    const e2 = await writer.append(sampleAuditRow())
    assert.equal(e2.seq, 2)
    assert.equal(e2.prevChecksum, e1.checksum)
    assert.equal(e2.checksum, auditChecksum(sampleAuditRow(), 2, e1.checksum))
  })

  test('the write takes the per-tenant advisory lock on the backoffice connection', async ({
    assert,
  }) => {
    const env = fakeAuditEnv()
    await new AiAuditWriter(env.deps).append(sampleAuditRow())
    const lock = env.queries.find((q) => /pg_advisory_xact_lock/.test(q.sql))
    assert.exists(lock)
    assert.deepEqual(lock!.bindings, ['ai_audit:tenant-1'])
    assert.equal(env.connections[0], 'backoffice')
  })

  test('two tenants keep independent chains (each starts at seq 1)', async ({ assert }) => {
    const writer = new AiAuditWriter(fakeAuditEnv().deps)
    const a = await writer.append(sampleAuditRow({ tenantId: 'tenant-a' }))
    const b = await writer.append(sampleAuditRow({ tenantId: 'tenant-b' }))
    assert.equal(a.seq, 1)
    assert.equal(b.seq, 1)
    assert.isNull(b.prevChecksum)
  })

  test('a scope mismatch is refused before any write (ContextSeal)', async ({ assert }) => {
    const env = fakeAuditEnv({ activeScope: 'someone-else' })
    let threw: unknown
    try {
      await new AiAuditWriter(env.deps).append(sampleAuditRow())
    } catch (error) {
      threw = error
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'tenant_scope_mismatch')
    assert.lengthOf(env.inserts, 0)
  })
})
