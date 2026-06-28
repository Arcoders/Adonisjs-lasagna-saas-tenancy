import { test } from '@japa/runner'
import HealthService, { toPublicHealthReport } from '../../../src/health/health_service.js'

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

// SECURITY (#5): the public projection that /readyz and /healthz serve must
// strip every field that could enumerate tenants or leak internals.
test.group('toPublicHealthReport — public probe projection', () => {
  test('drops meta, message, and durationMs but keeps status + criticality', ({ assert }) => {
    const projected = toPublicHealthReport({
      status: 'degraded',
      uptime: 42,
      checks: {
        circuit_breakers: {
          status: 'fail',
          durationMs: 9,
          message: 'connection refused at 10.1.2.3',
          meta: { open: ['11111111-1111-4111-8111-111111111111'] },
        },
        backoffice_db: { status: 'pass', durationMs: 3, critical: true },
      },
    })

    assert.deepEqual(projected, {
      status: 'degraded',
      uptime: 42,
      checks: {
        circuit_breakers: { status: 'fail' },
        backoffice_db: { status: 'pass', critical: true },
      },
    })
    // The tenant id must not survive anywhere in the projected body.
    assert.notInclude(JSON.stringify(projected), '11111111-1111-4111-8111-111111111111')
  })

  test('preserves the aggregate status for the 200/503 decision', ({ assert }) => {
    for (const status of ['ok', 'degraded', 'fail'] as const) {
      assert.equal(toPublicHealthReport({ status, uptime: 1, checks: {} }).status, status)
    }
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
    svc.addCheck(
      'a',
      () => new Promise((r) => setTimeout(() => r({ status: 'pass', durationMs: 0 }), 60))
    )
    svc.addCheck(
      'b',
      () => new Promise((r) => setTimeout(() => r({ status: 'pass', durationMs: 0 }), 60))
    )

    const start = Date.now()
    const report = await svc.readiness(500)
    const elapsed = Date.now() - start

    assert.equal(report.status, 'ok')
    assert.isBelow(elapsed, 200, `should be ~60ms, observed ${elapsed}ms`)
  })
})

test.group('HealthService — critical checks', () => {
  test('a failing critical check forces fail even when every other check passes', async ({
    assert,
  }) => {
    const svc = new HealthService()
    svc.addCheck('db', () => ({ status: 'fail', durationMs: 0, message: 'down' }), {
      critical: true,
    })
    svc.addCheck('redis', () => ({ status: 'pass', durationMs: 0 }))
    svc.addCheck('circuits', () => ({ status: 'pass', durationMs: 0 }))

    const report = await svc.readiness()
    assert.equal(report.status, 'fail')
    assert.equal(report.checks.db.status, 'fail')
  })

  test('the failing critical check is marked critical in the report', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('db', () => ({ status: 'fail', durationMs: 0 }), { critical: true })
    svc.addCheck('redis', () => ({ status: 'pass', durationMs: 0 }))

    const report = await svc.readiness()
    assert.isTrue(report.checks.db.critical)
    assert.isUndefined(report.checks.redis.critical)
  })

  test('a failing non-critical check among passes still reads degraded', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('db', () => ({ status: 'pass', durationMs: 0 }), { critical: true })
    svc.addCheck('optional', () => ({ status: 'fail', durationMs: 0 }))

    const report = await svc.readiness()
    assert.equal(report.status, 'degraded')
  })

  test('two-argument addCheck keeps the legacy semantics (no critical escalation)', async ({
    assert,
  }) => {
    const svc = new HealthService()
    svc.addCheck('a', () => ({ status: 'fail', durationMs: 0 }))
    svc.addCheck('b', () => ({ status: 'pass', durationMs: 0 }))

    const report = await svc.readiness()
    assert.equal(report.status, 'degraded')
  })

  test('a critical check that times out forces fail and keeps the timeout message', async ({
    assert,
  }) => {
    const svc = new HealthService()
    svc.addCheck('hang', () => new Promise(() => {}), { critical: true })
    svc.addCheck('redis', () => ({ status: 'pass', durationMs: 0 }))

    const report = await svc.readiness(50)
    assert.equal(report.status, 'fail')
    assert.isTrue(report.checks.hang.critical)
    assert.match(report.checks.hang.message ?? '', /timeout/)
  })

  test('a passing critical check does not affect the aggregate', async ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('db', () => ({ status: 'pass', durationMs: 0 }), { critical: true })
    svc.addCheck('redis', () => ({ status: 'pass', durationMs: 0 }))

    const report = await svc.readiness()
    assert.equal(report.status, 'ok')
    assert.isTrue(report.checks.db.critical)
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

  test('isCritical reflects the registration option', ({ assert }) => {
    const svc = new HealthService()
    svc.addCheck('hard', () => ({ status: 'pass', durationMs: 0 }), { critical: true })
    svc.addCheck('soft', () => ({ status: 'pass', durationMs: 0 }))
    assert.isTrue(svc.isCritical('hard'))
    assert.isFalse(svc.isCritical('soft'))
    assert.isFalse(svc.isCritical('missing'))
  })
})
