import { test } from '@japa/runner'
import longRunningQueriesCheck, {
  buildLongQueryIssue,
  type ActivityRow,
} from '../../../../src/services/doctor/checks/long_running_queries_check.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { setupTestConfig } from '../../../helpers/config.js'

const SENSITIVE_ROW: ActivityRow = {
  pid: 4242,
  datname: 'tenant_11111111_1111_4111_8111_111111111111',
  usename: 'app_role',
  application_name: 'lasagna',
  duration_seconds: 95,
  // A literal secret embedded in another tenant's slow query.
  query: "UPDATE users SET api_token = 'sk_live_DEADBEEFsecret' WHERE email = 'ceo@victim.com'",
}

test.group('longRunningQueriesCheck', (group) => {
  group.each.setup(() => setupTestConfig())

  test('declares the required shape', ({ assert }) => {
    assert.equal(longRunningQueriesCheck.name, 'long_running_queries')
    assert.match(longRunningQueriesCheck.description, /postgres|query|active/i)
    assert.isFunction(longRunningQueriesCheck.run)
  })

  test('does not throw when central connection is unavailable', async ({ assert }) => {
    // Without an AdonisJS app boot, db.connection() will throw — the check
    // must catch it and either return [] or an info-level diagnostic. It
    // must NEVER throw, because the doctor command keeps running other
    // checks after a failure.
    let issues: any
    try {
      issues = await longRunningQueriesCheck.run({
        tenants: [],
        repo: mockTenantRepository(),
        attemptFix: false,
      })
    } catch (err: any) {
      assert.fail(`check threw: ${err.message}`)
    }
    assert.isArray(issues)
  })
})

// SECURITY (#17): the doctor report is reachable over HTTP at the admin
// /health/report surface, so a long query's RAW SQL text (which can carry
// another tenant's secrets/PII as literals) must never land in meta by default.
test.group('buildLongQueryIssue — query-text scrub', () => {
  test('drops the raw query text and emits only a non-reversible fingerprint by default', ({
    assert,
  }) => {
    const issue = buildLongQueryIssue(SENSITIVE_ROW, 120, false)
    const meta = issue.meta as Record<string, unknown>

    assert.isUndefined(meta.query, 'raw SQL must not be in meta by default')
    assert.isString(meta.queryFingerprint)
    assert.lengthOf(meta.queryFingerprint as string, 12)
    // The secret literal must not survive anywhere in the serialized issue.
    assert.notInclude(JSON.stringify(issue), 'sk_live_DEADBEEFsecret')
    assert.notInclude(JSON.stringify(issue), 'ceo@victim.com')
    // Operationally useful, non-sensitive fields are preserved.
    assert.equal(meta.pid, 4242)
    assert.equal(meta.durationSeconds, 95)
    assert.equal(issue.code, 'long_running_query') // 95s < 120s error threshold → warn
    assert.equal(issue.severity, 'warn')
  })

  test('escalates to a critical issue past the error threshold (still no raw text)', ({
    assert,
  }) => {
    const issue = buildLongQueryIssue(SENSITIVE_ROW, 90, false)
    assert.equal(issue.code, 'long_running_query_critical')
    assert.equal(issue.severity, 'error')
    assert.isUndefined((issue.meta as any).query)
  })

  test('includes the raw query only when the host explicitly opts in', ({ assert }) => {
    const issue = buildLongQueryIssue(SENSITIVE_ROW, 120, true)
    const meta = issue.meta as Record<string, unknown>
    assert.equal(meta.query, SENSITIVE_ROW.query)
    assert.isString(meta.queryFingerprint)
  })

  test('the fingerprint is stable for identical queries and differs across queries', ({
    assert,
  }) => {
    const a = buildLongQueryIssue(SENSITIVE_ROW, 120, false).meta as any
    const b = buildLongQueryIssue(SENSITIVE_ROW, 120, false).meta as any
    const c = buildLongQueryIssue({ ...SENSITIVE_ROW, query: 'SELECT 1' }, 120, false).meta as any
    assert.equal(a.queryFingerprint, b.queryFingerprint)
    assert.notEqual(a.queryFingerprint, c.queryFingerprint)
  })
})
