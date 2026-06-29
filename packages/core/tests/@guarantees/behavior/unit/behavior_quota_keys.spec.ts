import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  ROLLING_TTL_SECONDS,
  QUOTA_CONSUME_LUA,
  rollingKey,
  snapshotKey,
  periodToday,
} from '../../../../src/services/quota/keys.js'

/**
 * Pins the Redis key formats and the atomic consume script for QuotaService.
 * These are load-bearing invariants: `reset()` clears a tenant's counters with a
 * wildcard `SCAN quota:<id>:*`, and consume/getUsage must read and write the
 * SAME key. A silent drift (dropping the date segment, reordering, renaming the
 * `:snap:` marker) would make counters never enforce or never reset while the
 * higher-level tests still pass — so the formats are frozen here.
 */
const TENANT_ID = '11111111-1111-4111-8111-111111111111'

test.group('quota keys', () => {
  test('rollingKey is quota:<id>:<yyyy-MM-dd UTC>:<quota>', ({ assert }) => {
    const today = DateTime.utc().toFormat('yyyy-MM-dd')
    assert.equal(
      rollingKey(TENANT_ID, 'apiCallsPerDay'),
      `quota:${TENANT_ID}:${today}:apiCallsPerDay`
    )
    assert.equal(periodToday(), today)
  })

  test('snapshotKey is quota:<id>:snap:<quota> (no date segment)', ({ assert }) => {
    assert.equal(snapshotKey(TENANT_ID, 'seats'), `quota:${TENANT_ID}:snap:seats`)
  })

  test('rolling and snapshot keys never collide for the same quota name', ({ assert }) => {
    assert.notEqual(rollingKey(TENANT_ID, 'snap'), snapshotKey(TENANT_ID, 'snap'))
    // A quota literally named "snap" still gets a date-segmented rolling key.
    assert.match(rollingKey(TENANT_ID, 'snap'), /:\d{4}-\d{2}-\d{2}:snap$/)
  })

  test('both key shapes live under the reset() wildcard quota:<id>:*', ({ assert }) => {
    assert.isTrue(rollingKey(TENANT_ID, 'x').startsWith(`quota:${TENANT_ID}:`))
    assert.isTrue(snapshotKey(TENANT_ID, 'x').startsWith(`quota:${TENANT_ID}:`))
  })

  test('ROLLING_TTL_SECONDS is 48h', ({ assert }) => {
    assert.equal(ROLLING_TTL_SECONDS, 172_800)
  })

  test('QUOTA_CONSUME_LUA is trimmed and holds the GET/limit-check/INCRBY/EXPIRE shape', ({
    assert,
  }) => {
    assert.equal(QUOTA_CONSUME_LUA, QUOTA_CONSUME_LUA.trim())
    assert.match(QUOTA_CONSUME_LUA, /redis\.call\('GET', KEYS\[1\]\)/)
    assert.match(QUOTA_CONSUME_LUA, /if current \+ amount > limit then/)
    assert.match(QUOTA_CONSUME_LUA, /redis\.call\('INCRBY', KEYS\[1\], amount\)/)
    assert.match(QUOTA_CONSUME_LUA, /redis\.call\('EXPIRE', KEYS\[1\], ttl\)/)
  })
})
