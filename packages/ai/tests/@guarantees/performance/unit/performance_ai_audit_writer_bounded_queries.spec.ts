import { test } from '@japa/runner'
import AiAuditWriter from '../../../../src/services/ai_audit_writer.js'
import { fakeAuditEnv, sampleAuditRow } from '../../../helpers/fake_audit_db.js'

/**
 * One append is a bounded, constant number of statements: the advisory lock, the
 * indexed tail read, and the insert. No per-row N+1 and no extra round-trips, so
 * audit cost is O(1) per attributed action (the recording fake is the only
 * query-count vehicle in the package).
 */
test.group('performance — AiAuditWriter bounded queries', () => {
  test('one append issues exactly the advisory lock + tail select + insert', async ({ assert }) => {
    const env = fakeAuditEnv()
    await new AiAuditWriter(env.deps).append(sampleAuditRow())

    assert.lengthOf(env.queries, 3)
    const shapes = env.queries.map((q) => q.sql.toLowerCase())
    assert.match(shapes[0]!, /pg_advisory_xact_lock/)
    // The table is schema-qualified + quoted via qualifyBackofficeTable ("schema"."table").
    assert.match(shapes[1]!, /select seq, checksum from "backoffice"\."ai_audit_logs"/)
    assert.match(shapes[2]!, /insert into "backoffice"\."ai_audit_logs"/)
  })
})
