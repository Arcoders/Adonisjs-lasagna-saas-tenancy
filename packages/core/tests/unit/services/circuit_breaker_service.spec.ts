import { test } from '@japa/runner'
import CircuitBreakerService from '../../../src/services/circuit_breaker_service.js'
import { setupTestConfig } from '../../helpers/config.js'

test.group('CircuitBreakerService — state queries', (group) => {
  group.each.setup(() => setupTestConfig())

  test('isOpen returns false for unknown tenant', ({ assert }) => {
    const svc = new CircuitBreakerService()
    assert.isFalse(svc.isOpen('unknown-tenant'))
  })

  test('getMetrics returns null for unknown tenant', ({ assert }) => {
    const svc = new CircuitBreakerService()
    assert.isNull(svc.getMetrics('unknown-tenant'))
  })

  test('getAllMetrics returns empty object when no circuits exist', ({ assert }) => {
    const svc = new CircuitBreakerService()
    assert.deepEqual(svc.getAllMetrics(), {})
  })

  test('getCircuit creates a circuit and returns it', ({ assert }) => {
    const svc = new CircuitBreakerService()
    const circuit = svc.getCircuit('tenant-abc')
    assert.isDefined(circuit)
  })

  test('getCircuit is idempotent — same instance returned', ({ assert }) => {
    const svc = new CircuitBreakerService()
    const first = svc.getCircuit('tenant-xyz')
    const second = svc.getCircuit('tenant-xyz')
    assert.strictEqual(first, second)
  })

  test('isOpen returns false for a freshly created circuit', ({ assert }) => {
    const svc = new CircuitBreakerService()
    svc.getCircuit('fresh-tenant')
    assert.isFalse(svc.isOpen('fresh-tenant'))
  })

  test('getMetrics returns CLOSED state for fresh circuit', ({ assert }) => {
    const svc = new CircuitBreakerService()
    svc.getCircuit('metrics-tenant')
    const metrics = svc.getMetrics('metrics-tenant')

    assert.isNotNull(metrics)
    assert.equal(metrics!.state, 'CLOSED')
    assert.equal(metrics!.tenantId, 'metrics-tenant')
    assert.equal(metrics!.failures, 0)
    assert.equal(metrics!.successes, 0)
  })

  test('getAllMetrics includes all created circuits', ({ assert }) => {
    const svc = new CircuitBreakerService()
    svc.getCircuit('t1')
    svc.getCircuit('t2')
    const all = svc.getAllMetrics()

    assert.property(all, 't1')
    assert.property(all, 't2')
  })
})

test.group('CircuitBreakerService — reset & destroy', (group) => {
  group.each.setup(() => setupTestConfig())

  test('reset closes a circuit (idempotent on closed)', ({ assert }) => {
    const svc = new CircuitBreakerService()
    svc.getCircuit('reset-tenant')
    assert.doesNotThrow(() => svc.reset('reset-tenant'))
    assert.isFalse(svc.isOpen('reset-tenant'))
  })

  test('reset on unknown tenant is a no-op', ({ assert }) => {
    const svc = new CircuitBreakerService()
    assert.doesNotThrow(() => svc.reset('does-not-exist'))
  })

  test('destroy removes circuit from map', async ({ assert }) => {
    const svc = new CircuitBreakerService()
    svc.getCircuit('destroy-tenant')
    assert.isNotNull(svc.getMetrics('destroy-tenant'))

    await svc.destroy('destroy-tenant')

    assert.isNull(svc.getMetrics('destroy-tenant'))
    assert.isFalse(svc.isOpen('destroy-tenant'))
  })

  test('destroy on unknown tenant is a no-op', async ({ assert }) => {
    const svc = new CircuitBreakerService()
    await assert.doesNotReject(() => svc.destroy('ghost-tenant'))
  })
})

test.group('CircuitBreakerService — instance isolation', (group) => {
  group.each.setup(() => setupTestConfig())

  test('two fresh instances do NOT share circuit state', ({ assert }) => {
    const svc1 = new CircuitBreakerService()
    const svc2 = new CircuitBreakerService()

    const breaker = svc1.getCircuit('shared-tenant')
    breaker.open()

    assert.isTrue(svc1.isOpen('shared-tenant'))
    assert.isFalse(
      svc2.isOpen('shared-tenant'),
      'second instance must not see first instance state'
    )
  })

  test('getCircuit on svc2 creates an independent fresh circuit', ({ assert }) => {
    const svc1 = new CircuitBreakerService()
    const svc2 = new CircuitBreakerService()

    svc1.getCircuit('isolation-tenant').open()
    svc2.getCircuit('isolation-tenant')

    assert.equal(svc1.getMetrics('isolation-tenant')!.state, 'OPEN')
    assert.equal(svc2.getMetrics('isolation-tenant')!.state, 'CLOSED')
  })
})

test.group('CircuitBreakerService — state transitions', (group) => {
  group.each.setup(() => setupTestConfig())

  test('isOpen returns true when circuit is forced open', ({ assert }) => {
    const svc = new CircuitBreakerService()
    const breaker = svc.getCircuit('force-open-tenant')
    breaker.open()
    assert.isTrue(svc.isOpen('force-open-tenant'))
  })

  test('getMetrics reflects OPEN state after force-open', ({ assert }) => {
    const svc = new CircuitBreakerService()
    const breaker = svc.getCircuit('open-metrics-tenant')
    breaker.open()
    const m = svc.getMetrics('open-metrics-tenant')
    assert.equal(m!.state, 'OPEN')
  })

  test('reset after force-open closes the circuit', ({ assert }) => {
    const svc = new CircuitBreakerService()
    const breaker = svc.getCircuit('reset-force-tenant')
    breaker.open()
    assert.isTrue(svc.isOpen('reset-force-tenant'))
    svc.reset('reset-force-tenant')
    assert.isFalse(svc.isOpen('reset-force-tenant'))
  })
})

test.group('CircuitBreakerService — works without Redis (null seam)', (group) => {
  group.each.setup(() => setupTestConfig())

  // Documents the Concern 3 claim at the unit tier: with no Redis bound,
  // lazyRedis() resolves to null and the persist/restore calls short-circuit, so
  // a breaker still force-opens, resets, destroys, and reports state without
  // throwing. The Redis-DOWN path (calls that reject mid-flight, hitting the
  // catch+log branches) is covered by the integration spec
  // circuit_breaker_service_redis_down.spec.ts.
  test('full open -> reset -> destroy cycle never throws with no Redis', async ({ assert }) => {
    const svc = new CircuitBreakerService()
    const breaker = svc.getCircuit('no-redis-tenant')

    assert.doesNotThrow(() => breaker.open())
    assert.isTrue(svc.isOpen('no-redis-tenant'))
    assert.equal(svc.getMetrics('no-redis-tenant')!.state, 'OPEN')

    assert.doesNotThrow(() => svc.reset('no-redis-tenant'))
    assert.isFalse(svc.isOpen('no-redis-tenant'))

    await assert.doesNotReject(() => svc.destroy('no-redis-tenant'))
    assert.isNull(svc.getMetrics('no-redis-tenant'))
  })
})
