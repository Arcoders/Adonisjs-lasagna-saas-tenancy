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
})
