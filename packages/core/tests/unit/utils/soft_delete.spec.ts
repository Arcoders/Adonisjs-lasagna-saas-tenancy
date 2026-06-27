import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  isExpired,
  selectPurgeable,
  DEFAULT_SOFT_DELETE_RETENTION_DAYS,
} from '../../../src/utils/soft_delete.js'

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

/**
 * WS-2 / tenant-lifecycle-partial-failure. `selectPurgeable` is the pure core of
 * `tenant:purge-expired`: by default it purges only retention-expired tenants;
 * with `includeOrphans` it purges EVERY soft-deleted tenant (the recovery path
 * for an immediate destroy whose schema drop failed). A bug here would either
 * skip a real orphan or purge a still-within-retention tenant early.
 */
test.group('selectPurgeable', () => {
  const now = Date.now()
  const day = 86400_000
  function tenant(id: string, deletedDaysAgo: number | null) {
    return {
      id,
      isDeleted: deletedDaysAgo !== null,
      deletedAt: deletedDaysAgo === null ? null : DateTime.fromMillis(now - deletedDaysAgo * day),
    }
  }

  test('default: only soft-deleted tenants past the retention window', ({ assert }) => {
    const tenants = [
      tenant('active', null), // not deleted
      tenant('recent', 5), // deleted, within retention
      tenant('expired', 60), // deleted, past retention
    ]
    const picked = selectPurgeable(tenants, 30, {}, now).map((t) => t.id)
    assert.deepEqual(picked, ['expired'])
  })

  test('includeOrphans: every soft-deleted tenant regardless of retention', ({ assert }) => {
    const tenants = [tenant('active', null), tenant('recent', 5), tenant('expired', 60)]
    const picked = selectPurgeable(tenants, 30, { includeOrphans: true }, now).map((t) => t.id)
    assert.deepEqual(picked.sort(), ['expired', 'recent'])
  })

  test('never selects a non-deleted tenant even with includeOrphans', ({ assert }) => {
    const picked = selectPurgeable([tenant('active', null)], 30, { includeOrphans: true }, now)
    assert.lengthOf(picked, 0)
  })
})
