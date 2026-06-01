import { test } from '@japa/runner'
import ResilienceService from '../../../src/services/resilience_service.js'
import DependencyUnavailableException from '../../../src/exceptions/dependency_unavailable_exception.js'

test.group('ResilienceService.run', () => {
  test('returns the run() result on success', async ({ assert }) => {
    const svc = new ResilienceService()
    const out = await svc.run({
      dependency: 'redis',
      operation: 'test.op',
      policy: 'fail-closed',
      fallback: () => 'fallback',
      run: async () => 'ok',
    })
    assert.equal(out, 'ok')
  })

  test('fail-open: returns fallback when run() throws', async ({ assert }) => {
    const svc = new ResilienceService()
    const out = await svc.run({
      dependency: 'redis',
      operation: 'quota.consume',
      policy: 'fail-open',
      tenantId: 't1',
      fallback: () => 42,
      run: async () => {
        throw new Error('redis down')
      },
    })
    assert.equal(out, 42)
  })

  test('fail-closed: throws DependencyUnavailableException when run() throws', async ({
    assert,
  }) => {
    const svc = new ResilienceService()
    await assert.rejects(
      () =>
        svc.run({
          dependency: 'postgres',
          operation: 'quota.consume',
          policy: 'fail-closed',
          tenantId: 't9',
          fallback: () => 0,
          run: async () => {
            throw new Error('pg down')
          },
        }),
      DependencyUnavailableException
    )
  })

  test('the thrown exception carries dependency/operation/tenantId + 503', async ({ assert }) => {
    const svc = new ResilienceService()
    try {
      await svc.run({
        dependency: 'redis',
        operation: 'rateLimit.check',
        policy: 'fail-closed',
        tenantId: 'tenant-x',
        fallback: () => null,
        run: async () => {
          throw new Error('boom')
        },
      })
      assert.fail('should have thrown')
    } catch (err) {
      assert.instanceOf(err, DependencyUnavailableException)
      const e = err as DependencyUnavailableException
      assert.equal(e.dependency, 'redis')
      assert.equal(e.operation, 'rateLimit.check')
      assert.equal(e.tenantId, 'tenant-x')
      assert.equal(e.status, 503)
      assert.equal(e.code, 'E_DEPENDENCY_UNAVAILABLE')
    }
  })

  test('async fallback is awaited', async ({ assert }) => {
    const svc = new ResilienceService()
    const out = await svc.run({
      dependency: 'redis',
      operation: 'x',
      policy: 'fail-open',
      fallback: async () => 'async-fallback',
      run: async () => {
        throw new Error('x')
      },
    })
    assert.equal(out, 'async-fallback')
  })
})
