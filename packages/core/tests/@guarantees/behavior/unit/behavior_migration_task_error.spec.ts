import { test } from '@japa/runner'
import { migrationTaskError } from '../../../../src/commands/migration_task_error.js'

/**
 * Unlike the command specs in this directory (metadata-only — command
 * modules pull the app logger into their graph), this helper imports
 * nothing, so its behavior is testable in the unit environment.
 *
 * The contract: the operator ALWAYS sees the underlying error message,
 * never a bare "failed" that forces a --verbose re-run (the F-4 lesson,
 * applied to the per-tenant migration commands).
 */
function captureTask() {
  const calls: string[] = []
  return {
    calls,
    error: (message: string) => {
      calls.push(message)
      return message
    },
  }
}

test.group('migrationTaskError()', () => {
  test('surfaces the error message without requiring --verbose', ({ assert }) => {
    const task = captureTask()
    migrationTaskError(task, new Error('relation "tenants" already exists'))
    assert.deepEqual(task.calls, ['relation "tenants" already exists'])
  })

  test('stringifies non-Error throwables', ({ assert }) => {
    const task = captureTask()
    migrationTaskError(task, 'string failure')
    assert.deepEqual(task.calls, ['string failure'])
  })

  test('falls back to "failed" when the error has no message', ({ assert }) => {
    const task = captureTask()
    migrationTaskError(task, new Error(''))
    assert.deepEqual(task.calls, ['failed'])
  })
})
