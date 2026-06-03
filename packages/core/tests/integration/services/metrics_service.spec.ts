import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import { DateTime } from 'luxon'
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'

const TODAY = DateTime.utc().toFormat('yyyy-MM-dd')

function metricKey(tenantId: string, metric: string, period = TODAY) {
  return `metrics:${tenantId}:${period}:${metric}`
}

test.group('MetricsService (integration)', (group) => {
  const tenantId = 'metric-test-tenant-id'
  const svc = new MetricsService()

  group.each.teardown(async () => {
    const keys = await redis.keys(`metrics:${tenantId}:*`)
    if (keys.length) await redis.del(...keys)
  })

  test('increment writes the expected Redis key with correct value', async ({ assert }) => {
    await svc.increment(tenantId, 'requests', 1)

    const value = await redis.get(metricKey(tenantId, 'requests'))
    assert.equal(value, '1')
  })

  test('increment is additive — repeated calls accumulate', async ({ assert }) => {
    await svc.increment(tenantId, 'requests', 3)
    await svc.increment(tenantId, 'requests', 7)

    const value = await redis.get(metricKey(tenantId, 'requests'))
    assert.equal(value, '10')
  })

  test('increment for errors writes a separate key', async ({ assert }) => {
    await svc.increment(tenantId, 'requests', 5)
    await svc.increment(tenantId, 'errors', 2)

    const requests = await redis.get(metricKey(tenantId, 'requests'))
    const errors = await redis.get(metricKey(tenantId, 'errors'))
    assert.equal(requests, '5')
    assert.equal(errors, '2')
  })

  test('trackBandwidth writes the bandwidth key', async ({ assert }) => {
    await svc.trackBandwidth(tenantId, 1024)
    await svc.trackBandwidth(tenantId, 512)

    const value = await redis.get(metricKey(tenantId, 'bandwidth'))
    assert.equal(value, '1536')
  })

  test('increment sets a TTL of 48 hours on the key', async ({ assert }) => {
    await svc.increment(tenantId, 'requests', 1)

    const ttl = await redis.ttl(metricKey(tenantId, 'requests'))
    assert.isAbove(ttl, 172000, 'TTL should be close to 48 hours (172800 s)')
    assert.isAtMost(ttl, 172800)
  })

  test('keys follow the pattern metrics:<tenantId>:<YYYY-MM-DD>:<metric>', async ({ assert }) => {
    await svc.increment(tenantId, 'requests', 1)

    const keys = await redis.keys(`metrics:${tenantId}:*`)
    assert.isAbove(keys.length, 0)
    for (const key of keys) {
      const parts = key.split(':')
      assert.equal(parts[0], 'metrics')
      assert.equal(parts[1], tenantId)
      assert.match(parts[2], /^\d{4}-\d{2}-\d{2}$/, 'period must be YYYY-MM-DD')
    }
  })
})
