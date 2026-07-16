import { test } from '@japa/runner'
import {
  enforceQuota,
  __setQuotaServiceResolverForTests,
} from '../../../../src/middleware/enforce_quota_middleware.js'
import QuotaExceededException from '../../../../src/exceptions/quota_exceeded_exception.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'

interface RecordedCall {
  tenant: any
  quota: string
  amount: number
}

/**
 * Build a fake QuotaService that records `consume`/`track` calls and let the
 * test decide whether `consume` throws. The middleware resolves the service
 * through the test seam, so no booted container is needed.
 */
function fakeQuotaService(consumeThrows?: Error) {
  const calls: { consume: RecordedCall[]; track: RecordedCall[] } = { consume: [], track: [] }
  const svc = {
    // The real QuotaService returns the new usage count from both methods.
    async consume(tenant: any, quota: string, amount: number): Promise<number> {
      calls.consume.push({ tenant, quota, amount })
      if (consumeThrows) throw consumeThrows
      return amount
    },
    async track(tenant: any, quota: string, amount: number): Promise<number> {
      calls.track.push({ tenant, quota, amount })
      return amount
    },
  }
  return { svc, calls }
}

function makeCtx(tenant: any) {
  return { request: { tenant: async () => tenant } } as any
}

async function catchError(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return undefined
}

test.group('enforceQuota middleware', (group) => {
  group.each.teardown(() => __setQuotaServiceResolverForTests(undefined))

  test('enforce mode (default): consumes the quota then calls next', async ({ assert }) => {
    const { svc, calls } = fakeQuotaService()
    __setQuotaServiceResolverForTests(async () => svc)
    const tenant = buildTestTenant()
    const mw = enforceQuota('apiCallsPerDay')

    let nextCalled = false
    await mw(makeCtx(tenant), async () => {
      nextCalled = true
    })

    assert.lengthOf(calls.consume, 1)
    assert.lengthOf(calls.track, 0)
    assert.equal(calls.consume[0]!.quota, 'apiCallsPerDay')
    assert.equal(calls.consume[0]!.amount, 1)
    assert.strictEqual(calls.consume[0]!.tenant, tenant)
    assert.isTrue(nextCalled)
  })

  test('enforce mode: propagates QuotaExceededException and does NOT call next', async ({
    assert,
  }) => {
    const tenant = buildTestTenant()
    const overrun = new QuotaExceededException({
      tenantId: tenant.id,
      quota: 'apiCallsPerDay',
      limit: 10,
      current: 10,
      attempted: 1,
    })
    const { svc } = fakeQuotaService(overrun)
    __setQuotaServiceResolverForTests(async () => svc)
    const mw = enforceQuota('apiCallsPerDay')

    let nextCalled = false
    const err = await catchError(() =>
      mw(makeCtx(tenant), async () => {
        nextCalled = true
      })
    )

    assert.instanceOf(err, QuotaExceededException)
    assert.isFalse(nextCalled)
  })

  test('soft mode (enforce:false): tracks instead of consuming and always proceeds', async ({
    assert,
  }) => {
    const { svc, calls } = fakeQuotaService()
    __setQuotaServiceResolverForTests(async () => svc)
    const tenant = buildTestTenant()
    const mw = enforceQuota('uploadsPerDay', { enforce: false })

    let nextCalled = false
    await mw(makeCtx(tenant), async () => {
      nextCalled = true
    })

    assert.lengthOf(calls.track, 1)
    assert.lengthOf(calls.consume, 0)
    assert.equal(calls.track[0]!.quota, 'uploadsPerDay')
    assert.isTrue(nextCalled)
  })

  test('honors a custom amount in both modes', async ({ assert }) => {
    const tenant = buildTestTenant()

    const enforced = fakeQuotaService()
    __setQuotaServiceResolverForTests(async () => enforced.svc)
    await enforceQuota('seats', { amount: 5 })(makeCtx(tenant), async () => {})
    assert.equal(enforced.calls.consume[0]!.amount, 5)

    const soft = fakeQuotaService()
    __setQuotaServiceResolverForTests(async () => soft.svc)
    await enforceQuota('seats', { amount: 3, enforce: false })(makeCtx(tenant), async () => {})
    assert.equal(soft.calls.track[0]!.amount, 3)
  })
})
