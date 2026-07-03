import { test } from '@japa/runner'
import AiAuditWriter from '../../../../src/services/ai_audit_writer.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
  snapshotAiGuardCounters,
} from '../../../../src/isthmus/ai_guard_audit.js'
import { fakeAuditEnv, sampleAuditRow } from '../../../helpers/fake_audit_db.js'

test.group('behavior — AiAuditWriter unique-violation retry + fail-closed', (group) => {
  group.each.setup(() => {
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async () => {})
  })
  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('a 23505 on the first insert is retried and the append succeeds, no guard trip', async ({
    assert,
  }) => {
    const env = fakeAuditEnv({ failInsert: { code: '23505', times: 1 } })
    const entry = await new AiAuditWriter(env.deps).append(sampleAuditRow())
    assert.equal(entry.seq, 1)
    const inserts = env.queries.filter((q) => /insert into/i.test(q.sql))
    assert.lengthOf(inserts, 2)
    assert.lengthOf(snapshotAiGuardCounters().rejected, 0)
  })

  test('a persistent write failure is fail-closed (503) after the bounded retries, guard tripped once', async ({
    assert,
  }) => {
    const env = fakeAuditEnv({ failInsert: 'always' })
    let threw: unknown
    try {
      await new AiAuditWriter(env.deps).append(sampleAuditRow())
    } catch (error) {
      threw = error
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'audit_write_failed')
    assert.equal((threw as AIException).httpStatus, 503)
    assert.equal(
      snapshotAiGuardCounters().rejected.find((r) => r.id === 'guard.ai_audit_write_failed')?.value,
      1
    )
  })
})
