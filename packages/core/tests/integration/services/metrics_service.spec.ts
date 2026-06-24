import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import db from '@adonisjs/lucid/services/db'
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

test.group('MetricsService.flush — bulk upsert (P2-1)', (group) => {
  // tenant_metrics.tenant_id is a uuid column, so these must be valid UUIDs
  // (the flush writes them straight from the parsed Redis key).
  const t1 = '11111111-1111-4111-8111-111111111111'
  const t2 = '22222222-2222-4222-8222-222222222222'
  const svc = new MetricsService()

  group.each.teardown(async () => {
    for (const t of [t1, t2]) {
      const keys = await redis.keys(`metrics:${t}:*`)
      if (keys.length) await redis.del(...keys)
    }
    await db
      .connection('backoffice')
      .query()
      .from('tenant_metrics')
      .whereIn('tenant_id', [t1, t2])
      .delete()
  })

  test('flushes every tenant counter into tenant_metrics in one pass', async ({ assert }) => {
    await svc.increment(t1, 'requests', 4)
    await svc.increment(t1, 'errors', 1)
    await svc.trackBandwidth(t1, 2048)
    await svc.increment(t2, 'requests', 9)

    await svc.flush(TODAY)

    const rows = await db
      .connection('backoffice')
      .query()
      .from('tenant_metrics')
      .whereIn('tenant_id', [t1, t2])
      .andWhere('period', TODAY)
      .orderBy('tenant_id', 'asc')

    assert.lengthOf(rows, 2)
    const byTenant = Object.fromEntries(rows.map((r: any) => [r.tenant_id, r]))
    assert.equal(Number(byTenant[t1].request_count), 4)
    assert.equal(Number(byTenant[t1].error_count), 1)
    assert.equal(Number(byTenant[t1].bandwidth_bytes), 2048)
    assert.equal(Number(byTenant[t2].request_count), 9)
  })

  test('re-flushing the same period upserts (no duplicate rows)', async ({ assert }) => {
    await svc.increment(t1, 'requests', 4)
    await svc.flush(TODAY)
    await svc.increment(t1, 'requests', 6) // now 10 total in redis
    await svc.flush(TODAY)

    const rows = await db
      .connection('backoffice')
      .query()
      .from('tenant_metrics')
      .where('tenant_id', t1)
      .andWhere('period', TODAY)

    assert.lengthOf(rows, 1)
    assert.equal(Number(rows[0].request_count), 10)
  })
})

test.group('MetricsService.flush — reads through the getRedis() seam', (group) => {
  // A future period so it never collides with the TODAY-based groups above.
  const tenantId = '33333333-3333-4333-8333-333333333333'
  const period = '2099-02-20'

  group.each.teardown(async () => {
    await db
      .connection('backoffice')
      .query()
      .from('tenant_metrics')
      .where('tenant_id', tenantId)
      .delete()
  })

  test('flush() scans + mgets through the overridden getRedis(), not module redis', async ({
    assert,
  }) => {
    const keys = [
      `metrics:${tenantId}:${period}:requests`,
      `metrics:${tenantId}:${period}:errors`,
      `metrics:${tenantId}:${period}:bandwidth`,
    ]
    const values: Record<string, string> = { [keys[0]]: '42', [keys[1]]: '3', [keys[2]]: '1024' }
    let scanCalled = false
    let mgetCalled = false

    // A full fake (scan + mget). If any flush/scan path still reached the
    // module-level `redis` instead of getRedis(), it would read the real
    // (empty) store and the upsert below would not match these fake counts.
    class FakeRedisMetrics extends MetricsService {
      protected getRedis() {
        return {
          scan: async (cursor: string) => {
            scanCalled = true
            return cursor === '0' ? ['0', keys] : ['0', []]
          },
          mget: async (...ks: string[]) => {
            mgetCalled = true
            return ks.map((k) => values[k] ?? null)
          },
        } as any
      }
    }

    await new FakeRedisMetrics().flush(period)

    assert.isTrue(scanCalled, 'flush must SCAN through the overridden getRedis()')
    assert.isTrue(mgetCalled, 'flush must MGET through the overridden getRedis()')

    const row: any = await db
      .connection('backoffice')
      .query()
      .from('tenant_metrics')
      .where('tenant_id', tenantId)
      .andWhere('period', period)
      .first()

    assert.isNotNull(row, 'flush must upsert the fake counters it read through the seam')
    assert.equal(Number(row.request_count), 42)
    assert.equal(Number(row.error_count), 3)
    assert.equal(Number(row.bandwidth_bytes), 1024)
  })
})
