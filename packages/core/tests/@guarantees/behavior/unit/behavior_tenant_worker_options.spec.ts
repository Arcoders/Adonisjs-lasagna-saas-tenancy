import { test } from '@japa/runner'
import { buildTenantWorkerOptions } from '../../../../src/helpers/tenant_worker_options.js'
import { setupTestConfig, testConfig } from '../../../helpers/config.js'

test.group('buildTenantWorkerOptions', (group) => {
  group.each.setup(() => setupTestConfig())

  test('defaults concurrency to config.queue.defaultConcurrency', ({ assert }) => {
    setupTestConfig({
      queue: { ...testConfig.queue, defaultConcurrency: 4 },
    })
    const opts = buildTenantWorkerOptions('t1')
    assert.equal(opts.concurrency, 4)
  })

  test('honours an explicit concurrency override', ({ assert }) => {
    const opts = buildTenantWorkerOptions('t1', 7)
    assert.equal(opts.concurrency, 7)
  })

  test('names the worker tenant:<id> and carries the Redis connection', ({ assert }) => {
    setupTestConfig({
      queue: {
        ...testConfig.queue,
        redis: { host: 'redis.internal', port: 6380, username: 'u', password: 'p', db: 3 },
      },
    })
    const opts = buildTenantWorkerOptions('acme', 2)
    assert.equal(opts.name, 'tenant:acme')
    assert.deepInclude(opts.connection as object, {
      host: 'redis.internal',
      port: 6380,
      username: 'u',
      password: 'p',
      db: 3,
    })
  })

  test('defaults Redis db to 0 when unset', ({ assert }) => {
    setupTestConfig({
      queue: { ...testConfig.queue, redis: { host: 'h', port: 6379 } },
    })
    const opts = buildTenantWorkerOptions('t1', 1)
    assert.equal((opts.connection as { db: number }).db, 0)
  })

  test('rejects a concurrency below 1', ({ assert }) => {
    assert.throws(
      () => buildTenantWorkerOptions('t1', 0),
      /concurrency must be a finite integer >= 1/
    )
    assert.throws(
      () => buildTenantWorkerOptions('t1', -3),
      /concurrency must be a finite integer >= 1/
    )
  })

  test('rejects a non-finite concurrency', ({ assert }) => {
    assert.throws(() => buildTenantWorkerOptions('t1', Number.NaN), /finite integer/)
    assert.throws(() => buildTenantWorkerOptions('t1', Number.POSITIVE_INFINITY), /finite integer/)
  })
})
