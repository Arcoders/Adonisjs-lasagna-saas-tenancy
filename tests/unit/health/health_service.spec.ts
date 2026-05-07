import { test } from '@japa/runner'
import HealthService from '../../../src/health/health_service.js'

test.group('HealthService — liveness', () => {
  test('liveness returns ok with uptime >= 0', ({ assert }) => {
    const svc = new HealthService()
    const result = svc.liveness()
    assert.equal(result.status, 'ok')
    assert.isAtLeast(result.uptime, 0)
  })
})

test.group('HealthService — readiness with no checks', () => {
  test('returns ok with empty checks map', async ({ assert }) => {
    const svc = new HealthService()
    const report = await svc.readiness()
    assert.equal(report.status, 'ok')
    assert.deepEqual(report.checks, {})
  })
})

test.group('HealthService — readiness with checks', () => {
  test('all-pass returns ok and includes durationMs', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('db', () => ({ status: 'pass', durationMs: 0 }))
    svc.addCheck('redis', async () => ({ status: 'pass', durationMs: 0 }))

    const report = await svc.readiness()
    assert.equal(report.status, 'ok')
    assert.equal(report.checks.db.status, 'pass')
    assert.equal(report.checks.redis.status, 'pass')
    assert.isAtLeast(report.checks.db.durationMs, 0)
    assert.isAtLeast(report.checks.redis.durationMs, 0)
  })

  test('all-fail returns fail', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('db', () => ({ status: 'fail', durationMs: 0, message: 'down' }))
    svc.addCheck('redis', () => ({ status: 'fail', durationMs: 0 }))

    const report = await svc.readiness()
    assert.equal(report.status, 'fail')
  })

  test('mixed returns degraded', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('db', () => ({ status: 'pass', durationMs: 0 }))
    svc.addCheck('redis', () => ({ status: 'fail', durationMs: 0 }))

    const report = await svc.readiness()
    assert.equal(report.status, 'degraded')
  })

  test('a check that throws is recorded as fail', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('blowup', () => {
      throw new Error('boom')
    })

    const report = await svc.readiness()
    assert.equal(report.checks.blowup.status, 'fail')
    assert.match(report.checks.blowup.message ?? '', /boom/)
  })

  test('a check that hangs is killed by the timeout', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('hang', () => new Promise(() => {}))

    const report = await svc.readiness(50)
    assert.equal(report.checks.hang.status, 'fail')
    assert.match(report.checks.hang.message ?? '', /timeout/)
  })

  test('checks run in parallel — total time is bounded by the slowest, not the sum', async ({
    assert,
  }) => {
    const svc = new HealthService()
    svc.addCheck('a', () => new Promise((r) => setTimeout(() => r({ status: 'pass', durationMs: 0 }), 60)))
    svc.addCheck('b', () => new Promise((r) => setTimeout(() => r({ status: 'pass', durationMs: 0 }), 60)))

    const start = Date.now()
    const report = await svc.readiness(500)
    const elapsed = Date.now() - start

    assert.equal(report.status, 'ok')
    assert.isBelow(elapsed, 200, `should be ~60ms, observed ${elapsed}ms`)
  })
})

test.group('HealthService — registry helpers', () => {
  test('hasCheck reflects registration', ({ assert }) => {
    const svc = new HealthService()
    assert.isFalse(svc.hasCheck('foo'))
    svc.addCheck('foo', () => ({ status: 'pass', durationMs: 0 }))
    assert.isTrue(svc.hasCheck('foo'))
  })

  test('removeCheck unregisters the named check', ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('foo', () => ({ status: 'pass', durationMs: 0 }))
    svc.removeCheck('foo')
    assert.isFalse(svc.hasCheck('foo'))
  })
})
