import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { isExpired, DEFAULT_SOFT_DELETE_RETENTION_DAYS } from '../../../src/utils/soft_delete.js'

test.group('isExpired', () => {
  test('returns false when deletedAt is null', ({ assert }) => {
    assert.isFalse(isExpired(null, 30))
  })

  test('returns false when deletedAt is undefined', ({ assert }) => {
    assert.isFalse(isExpired(undefined, 30))
  })

  test('returns false when deletion is younger than retention window', ({ assert }) => {
    const now = Date.now()
    const deletedAt = DateTime.fromMillis(now - 5 * 86400_000) // 5 days ago
    assert.isFalse(isExpired(deletedAt, 30, now))
  })

  test('returns true when deletion is older than retention window', ({ assert }) => {
    const now = Date.now()
    const deletedAt = DateTime.fromMillis(now - 60 * 86400_000) // 60 days ago
    assert.isTrue(isExpired(deletedAt, 30, now))
  })

  test('returns true at the exact boundary', ({ assert }) => {
    const now = Date.now()
    const deletedAt = DateTime.fromMillis(now - 30 * 86400_000) // exactly 30 days ago
    assert.isTrue(isExpired(deletedAt, 30, now))
  })

  test('honors the retentionDays argument', ({ assert }) => {
    const now = Date.now()
    const deletedAt = DateTime.fromMillis(now - 10 * 86400_000) // 10 days ago
    assert.isFalse(isExpired(deletedAt, 30, now))
    assert.isTrue(isExpired(deletedAt, 7, now))
  })

  test('returns false for an invalid DateTime', ({ assert }) => {
    const invalid = DateTime.fromISO('not-a-date')
    assert.isFalse(isExpired(invalid, 30))
  })

  test('default retention is 30 days', ({ assert }) => {
    assert.equal(DEFAULT_SOFT_DELETE_RETENTION_DAYS, 30)
  })
})
