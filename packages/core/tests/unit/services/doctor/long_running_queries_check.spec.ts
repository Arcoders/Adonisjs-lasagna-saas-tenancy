import { test } from '@japa/runner'
import longRunningQueriesCheck from '../../../../src/services/doctor/checks/long_running_queries_check.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { setupTestConfig } from '../../../helpers/config.js'

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
