import { test } from '@japa/runner'
import { assertNever } from '../../../../src/internal/assert_never.js'

test.group('assertNever', () => {
  test('throws loudly if control ever reaches it at runtime', ({ assert }) => {
    // Simulate an unchecked cast reaching an exhaustive default arm.
    assert.throws(() => assertNever('leak' as never, 'outcome'), /unexpected outcome: leak/)
  })
})
