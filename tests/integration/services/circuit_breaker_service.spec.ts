import { test } from '@japa/runner'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'

test.group('CircuitBreakerService (integration)', (group) => {
  let svc: CircuitBreakerService

  group.each.setup(async () => {
    svc = await app.container.make(CircuitBreakerService)
  })

  group.each.teardown(async () => {
    await svc.destroy('int-test-tenant').catch(() => {})
  })

  test('circuit starts in CLOSED state', ({ assert }) => {
    svc.getCircuit('int-test-tenant')
    assert.isFalse(svc.isOpen('int-test-tenant'))
    assert.equal(svc.getMetrics('int-test-tenant')!.state, 'CLOSED')
  })

  test('force-open writes OPEN state to Redis', async ({ assert }) => {
    const breaker = svc.getCircuit('int-test-tenant')
    breaker.open()

    // Give the async persistState a tick to complete
    await new Promise((r) => setTimeout(r, 20))

    const stored = await redis.get('cb:state:int-test-tenant')
    assert.equal(stored, 'OPEN')
  })

  test('reset writes CLOSED state to Redis', async ({ assert }) => {
    const breaker = svc.getCircuit('int-test-tenant')
    breaker.open()
    await new Promise((r) => setTimeout(r, 20))

    svc.reset('int-test-tenant')
    await new Promise((r) => setTimeout(r, 20))

    const stored = await redis.get('cb:state:int-test-tenant')
    assert.equal(stored, 'CLOSED')
  })

  test('destroy removes circuit and deletes Redis key', async ({ assert }) => {
    const breaker = svc.getCircuit('int-test-tenant')
    breaker.open()
    await new Promise((r) => setTimeout(r, 20))

    await svc.destroy('int-test-tenant')

    assert.isNull(svc.getMetrics('int-test-tenant'))
    assert.isFalse(svc.isOpen('int-test-tenant'))
    const stored = await redis.get('cb:state:int-test-tenant')
    assert.isNull(stored)
  })

  test('restores OPEN state on a fresh service after a process restart', async ({ assert }) => {
    // Simulate a prior process having persisted OPEN, then a restart: a
    // brand-new service instance (empty in-memory circuits) must re-open the
    // breaker from Redis instead of starting CLOSED and hammering a down DB.
    await redis.set('cb:state:int-test-tenant', 'OPEN')
    const fresh = new CircuitBreakerService()
    const breaker = fresh.getCircuit('int-test-tenant')

    // Restore is fire-and-forget (a Redis read), so give it a tick.
    await new Promise((r) => setTimeout(r, 50))

    assert.isTrue(breaker.opened, 'breaker re-opened from persisted OPEN state')
    assert.isTrue(fresh.isOpen('int-test-tenant'))

    await fresh.destroy('int-test-tenant')
  })
})
