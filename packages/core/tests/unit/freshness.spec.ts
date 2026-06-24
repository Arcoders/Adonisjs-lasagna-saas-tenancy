import { test } from '@japa/runner'
import { mapDataAsOf, isStale, staleDays } from '../../src/freshness.js'

test.group('freshness — mapDataAsOf', () => {
  test('coerces a Date to a UTC yyyy-MM-dd', ({ assert }) => {
    assert.equal(mapDataAsOf({ as_of: new Date('2026-06-24T23:30:00Z') }), '2026-06-24')
  })
  test('passes through an ISO string', ({ assert }) => {
    assert.equal(mapDataAsOf({ as_of: '2026-06-24' }), '2026-06-24')
  })
  test('null / undefined / missing row → null', ({ assert }) => {
    assert.isNull(mapDataAsOf({ as_of: null }))
    assert.isNull(mapDataAsOf({ as_of: undefined }))
    assert.isNull(mapDataAsOf(undefined))
    assert.isNull(mapDataAsOf({}))
  })
  test('garbage value → null, never throws', ({ assert }) => {
    assert.isNull(mapDataAsOf({ as_of: 'not-a-date' }))
    assert.isNull(mapDataAsOf({ as_of: 12345 }))
  })
})

test.group('freshness — isStale', () => {
  test('null asOf (no data) is stale', ({ assert }) => {
    assert.isTrue(isStale(null, '2026-06-24', 2))
  })
  test('exactly threshold days old is NOT stale (> not >=)', ({ assert }) => {
    assert.isFalse(isStale('2026-06-22', '2026-06-24', 2))
  })
  test('older than threshold is stale', ({ assert }) => {
    assert.isTrue(isStale('2026-06-21', '2026-06-24', 2))
  })
  test('future asOf (clock skew) is not stale', ({ assert }) => {
    assert.isFalse(isStale('2026-06-25', '2026-06-24', 2))
  })
  test('unparseable asOf is conservatively stale', ({ assert }) => {
    assert.isTrue(isStale('nope', '2026-06-24', 2))
  })
})

test.group('freshness — staleDays', () => {
  test('whole days between asOf and now', ({ assert }) => {
    assert.equal(staleDays('2026-06-20', '2026-06-24'), 4)
  })
  test('future asOf clamps to 0', ({ assert }) => {
    assert.equal(staleDays('2026-06-25', '2026-06-24'), 0)
  })
  test('null / invalid → null', ({ assert }) => {
    assert.isNull(staleDays(null, '2026-06-24'))
    assert.isNull(staleDays('x', '2026-06-24'))
  })
})
