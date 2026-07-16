import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import db from '@adonisjs/lucid/services/db'
import emitter from '@adonisjs/core/services/emitter'
import { DateTime } from 'luxon'
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MetricRecorded } from '@adonisjs-lasagna/saas-tenancy/events'

const TODAY = DateTime.utc().toFormat('yyyy-MM-dd')

// tenant_custom_metrics.tenant_id is a uuid column.
const t1 = '31111111-1111-4111-8111-111111111111'
const t2 = '32222222-2222-4222-8222-222222222222'
const t3 = '33333333-3333-4333-8333-333333333333'

async function cleanup(tenantIds: string[]) {
  for (const t of tenantIds) {
    const keys = await redis.keys(`custom_metrics:${t}:*`)
    if (keys.length) await redis.del(...keys)
  }
  await db
    .connection('backoffice')
    .query()
    .from('tenant_custom_metrics')
    .whereIn('tenant_id', tenantIds)
    .delete()
}

function customRows(tenantIds: string[]) {
  return db
    .connection('backoffice')
    .query()
    .from('tenant_custom_metrics')
    .whereIn('tenant_id', tenantIds)
    .andWhere('period', TODAY)
    .orderBy('tenant_id', 'asc')
    .orderBy('name', 'asc')
}

test.group('MetricsService.emitMetric + flushCustomMetrics (integration)', (group) => {
  const svc = new MetricsService()

  group.each.teardown(async () => {
    await cleanup([t1, t2, t3])
  })

  test('emit writes a custom_metrics key with the INCRBY value', async ({ assert }) => {
    await svc.emitMetric(t1, 'bookings', 3)
    const value = await redis.get(`custom_metrics:${t1}:${TODAY}:bookings`)
    assert.equal(value, '3')
  })

  test('flushes every (tenant,name) counter into tenant_custom_metrics', async ({ assert }) => {
    await svc.emitMetric(t1, 'bookings', 2)
    await svc.emitMetric(t1, 'revenue_cents', 1299)
    await svc.emitMetric(t2, 'bookings', 5)

    await svc.flushCustomMetrics(TODAY)

    const rows = await customRows([t1, t2])
    assert.lengthOf(rows, 3)
    const byKey = Object.fromEntries(rows.map((r: any) => [`${r.tenant_id}|${r.name}`, r]))
    assert.equal(Number(byKey[`${t1}|bookings`].value), 2)
    assert.equal(Number(byKey[`${t1}|revenue_cents`].value), 1299)
    assert.equal(Number(byKey[`${t2}|bookings`].value), 5)
  })

  test('re-flushing the same period upserts (one row per tenant+period+name)', async ({
    assert,
  }) => {
    await svc.emitMetric(t1, 'bookings', 4)
    await svc.flushCustomMetrics(TODAY)
    await svc.emitMetric(t1, 'bookings', 6) // now 10 total in redis
    await svc.flushCustomMetrics(TODAY)

    const rows = await customRows([t1])
    assert.lengthOf(rows, 1)
    assert.equal(Number(rows[0].value), 10)
  })

  test('flushing an empty period is a no-op (no rows, no throw)', async ({ assert }) => {
    await assert.doesNotReject(() => svc.flushCustomMetrics(TODAY))
    const rows = await customRows([t1, t2, t3])
    assert.lengthOf(rows, 0)
  })

  test('CHAOS: 50 concurrent emits to one key flush to exactly 50 (INCRBY atomic)', async ({
    assert,
  }) => {
    await Promise.all(Array.from({ length: 50 }, () => svc.emitMetric(t1, 'hits', 1)))
    await svc.flushCustomMetrics(TODAY)

    const rows = await customRows([t1])
    assert.lengthOf(rows, 1)
    assert.equal(Number(rows[0].value), 50)
  })

  test('CHAOS: a large keyset crosses the read/write chunk boundaries', async ({ assert }) => {
    // 520 distinct names > WRITE_CHUNK (500) and > 2× READ_CHUNK (256).
    const COUNT = 520
    await Promise.all(Array.from({ length: COUNT }, (_, i) => svc.emitMetric(t3, `m_${i}`, i + 1)))
    await svc.flushCustomMetrics(TODAY)

    const rows = await customRows([t3])
    assert.lengthOf(rows, COUNT)
    const total = rows.reduce((acc: number, r: any) => acc + Number(r.value), 0)
    assert.equal(total, (COUNT * (COUNT + 1)) / 2, 'every value flushed exactly once')
  }).timeout(30_000)

  test('dispatches MetricRecorded with the exact payload', async ({ assert }) => {
    const captured: Array<{ tenantId: string; name: string; value: number; period: string }> = []
    const handler = (e: MetricRecorded) => {
      captured.push(e.payload)
    }
    emitter.on(MetricRecorded, handler)
    try {
      await svc.emitMetric(t1, 'bookings', 7)
      await new Promise((r) => setTimeout(r, 30))
    } finally {
      emitter.off(MetricRecorded, handler)
    }

    assert.lengthOf(captured, 1)
    assert.deepEqual(captured[0], { tenantId: t1, name: 'bookings', value: 7, period: TODAY })
  })

  test('CHAOS: a throwing MetricRecorded listener does not break emitMetric', async ({
    assert,
  }) => {
    const handler = () => {
      throw new Error('listener blew up')
    }
    emitter.on(MetricRecorded, handler)
    try {
      await assert.doesNotReject(() => svc.emitMetric(t1, 'bookings', 1))
    } finally {
      emitter.off(MetricRecorded, handler)
    }
    // the value was still written despite the listener throwing
    const value = await redis.get(`custom_metrics:${t1}:${TODAY}:bookings`)
    assert.equal(value, '1')
  })
})

// A Redis stub whose pipeline rejects, to prove emitMetric fails open.
class DownRedisMetrics extends MetricsService {
  protected getRedis(): any {
    return {
      pipeline: () => ({
        incrby() {
          return this
        },
        expire() {
          return this
        },
        async exec() {
          throw new Error('ECONNREFUSED — Redis is down')
        },
      }),
    }
  }
}

test.group('MetricsService.emitMetric — fail-open (integration)', (group) => {
  group.each.teardown(async () => {
    await cleanup([t1])
  })

  test('CHAOS: a rejecting Redis write is swallowed and nothing is recorded', async ({
    assert,
  }) => {
    const svc = new DownRedisMetrics()
    let dispatched = 0
    const handler = () => {
      dispatched += 1
    }
    emitter.on(MetricRecorded, handler)
    try {
      await assert.doesNotReject(() => svc.emitMetric(t1, 'bookings', 1))
      await new Promise((r) => setTimeout(r, 30))
    } finally {
      emitter.off(MetricRecorded, handler)
    }
    assert.equal(dispatched, 0, 'no MetricRecorded when the write failed (nothing was recorded)')
  })
})
