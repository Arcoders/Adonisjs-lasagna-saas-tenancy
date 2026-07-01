import { test } from '@japa/runner'
import QuotaService from '../../../../src/services/quota_service.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig, testConfig } from '../../../helpers/config.js'

/**
 * Unit coverage for the TS orchestration around reserve/settle/release: plan and
 * operator-ceiling resolution, the eval-argument wiring, the inert no-op path,
 * the reservation handle shape, and the duplicate-id guard. The Lua accounting
 * itself (single-EVAL both-or-neither, over-budget hard stop, clamp, idempotent
 * release, orphan reclaim by TTL) is a real-Redis property proven in the
 * integration tier; here the Redis client is a stub whose eval() result is
 * programmable and whose call arguments are captured. The over-budget branch is
 * NOT unit-tested because it dispatches `TenantQuotaExceeded` before throwing,
 * and the AdonisJS emitter is unavailable outside a booted app (see the
 * integration spec).
 */
class StubQuotaService extends QuotaService {
  public evalCalls: unknown[][] = []
  public evalResult: unknown = [1, 0, 0]
  protected async requireRedis(): Promise<any> {
    return {
      eval: async (...args: unknown[]) => {
        this.evalCalls.push(args)
        return typeof this.evalResult === 'function'
          ? (this.evalResult as (a: unknown[]) => unknown)(args)
          : this.evalResult
      },
    }
  }
}

function setupPlans(limits: Record<string, number>, extra: Record<string, unknown> = {}): void {
  setupTestConfig({
    ...testConfig,
    plans: { defaultPlan: 'standard', definitions: { standard: { limits } }, ...extra },
  } as never)
}

test.group('QuotaService.reserve — orchestration', () => {
  test('rejects a non-positive worstCase before any Redis call', async ({ assert }) => {
    setupPlans({ aiTokens: 1000 })
    const svc = new StubQuotaService()
    await assert.rejects(() => svc.reserve(buildTestTenant(), 'aiTokens', 0), /positive integer/)
    await assert.rejects(() => svc.reserve(buildTestTenant(), 'aiTokens', -5), /positive integer/)
    assert.lengthOf(svc.evalCalls, 0)
  })

  test('returns an inert no-op handle when nothing is enforced (unlimited, no ceiling)', async ({
    assert,
  }) => {
    setupPlans({}) // aiTokens undeclared => Infinity limit; no operatorCeiling
    const svc = new StubQuotaService()
    const r = await svc.reserve(buildTestTenant(), 'aiTokens', 100)
    assert.equal(r.id, '', 'the no-op handle carries an empty id')
    assert.equal(r.worstCase, 100)
    assert.isFalse(r.op)
    assert.lengthOf(svc.evalCalls, 0, 'nothing to enforce => no Redis round-trip')
  })

  test('a placed hold returns a populated handle carrying the reserve-time day and ttl', async ({
    assert,
  }) => {
    setupPlans({ aiTokens: 1000 }, { reservationTtlMs: 45_000 })
    const svc = new StubQuotaService()
    svc.evalResult = [1, 200, 0]
    const tenant = buildTestTenant()
    const r = await svc.reserve(tenant, 'aiTokens', 200)
    assert.isNotEmpty(r.id)
    assert.equal(r.tenantId, tenant.id)
    assert.equal(r.quota, 'aiTokens')
    assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(r.worstCase, 200)
    assert.equal(r.ttl, 45_000)
    assert.isFalse(r.op, 'no operator ceiling configured')
    assert.lengthOf(svc.evalCalls, 1)
  })

  test('floors a fractional worstCase before holding it', async ({ assert }) => {
    setupPlans({ aiTokens: 1000 })
    const svc = new StubQuotaService()
    svc.evalResult = [1, 0, 0]
    const r = await svc.reserve(buildTestTenant(), 'aiTokens', 12.9)
    assert.equal(r.worstCase, 12)
    // eval args: [script, numKeys, k1..k6, tLimit, oLimit, worst, ...]
    assert.equal(svc.evalCalls[0][10], '12', 'worstCase passed to Lua is the floored integer')
  })

  test('passes op-limit -1 without a ceiling, and the ceiling value when configured', async ({
    assert,
  }) => {
    setupPlans({ aiTokens: 1000 })
    let svc = new StubQuotaService()
    svc.evalResult = [1, 0, 0]
    await svc.reserve(buildTestTenant(), 'aiTokens', 10)
    assert.equal(svc.evalCalls[0][8], '1000', 'tenant limit at ARGV[1]')
    assert.equal(svc.evalCalls[0][9], '-1', 'operator ceiling disabled at ARGV[2]')

    setupPlans({ aiTokens: 1000 }, { operatorCeiling: { aiTokens: 5000 } })
    svc = new StubQuotaService()
    svc.evalResult = [1, 0, 0]
    const r = await svc.reserve(buildTestTenant(), 'aiTokens', 10)
    assert.equal(svc.evalCalls[0][9], '5000', 'operator ceiling passed through at ARGV[2]')
    assert.isTrue(r.op, 'handle records that an operator ceiling was in play')
  })

  test('passes tenant-limit -1 when the quota is unlimited but an operator ceiling applies', async ({
    assert,
  }) => {
    setupPlans({}, { operatorCeiling: { aiTokens: 5000 } }) // aiTokens unlimited per-tenant
    const svc = new StubQuotaService()
    svc.evalResult = [1, 0, 0]
    const r = await svc.reserve(buildTestTenant(), 'aiTokens', 10)
    assert.equal(svc.evalCalls[0][8], '-1', 'tenant limit disabled')
    assert.equal(svc.evalCalls[0][9], '5000', 'ceiling still enforced')
    assert.isTrue(r.op)
  })

  test('a duplicate reservation id is refused', async ({ assert }) => {
    setupPlans({ aiTokens: 1000 })
    const svc = new StubQuotaService()
    svc.evalResult = [-1]
    await assert.rejects(() => svc.reserve(buildTestTenant(), 'aiTokens', 10), /duplicate/)
  })
})

test.group('QuotaService.settle / release — orchestration', () => {
  const handle = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      id: 'h1',
      tenantId: 't-1',
      quota: 'aiTokens',
      day: '2026-07-01',
      worstCase: 10,
      ttl: 1000,
      op: false,
      ...over,
    }) as never

  test('settle floors cumulativeUsed and no-ops on an inert handle', async ({ assert }) => {
    setupPlans({ aiTokens: 1000 })
    const svc = new StubQuotaService()
    await svc.settle(handle({ id: '' }), 5)
    assert.lengthOf(svc.evalCalls, 0, 'inert handle => no Redis')

    svc.evalResult = [3, 3, 10]
    await svc.settle(handle(), 3.9)
    assert.lengthOf(svc.evalCalls, 1)
    assert.equal(svc.evalCalls[0][8], '3', 'cumulativeUsed floored to an integer at ARGV[1]')
  })

  test('settle coerces a non-finite cumulativeUsed to 0 rather than passing "NaN"', async ({
    assert,
  }) => {
    setupPlans({ aiTokens: 1000 })
    const svc = new StubQuotaService()
    svc.evalResult = [0, 0, 10]
    await svc.settle(handle(), Number.NaN)
    // "NaN" would abort the Lua (tonumber rejects it) and, under fail-open, drop
    // the charge silently. It must reach Lua as a clean 0.
    assert.equal(svc.evalCalls[0][8], '0', 'NaN coerced to 0')
  })

  test('release returns the freed remainder and no-ops on an inert handle', async ({ assert }) => {
    setupPlans({ aiTokens: 1000 })
    const svc = new StubQuotaService()
    assert.equal(await svc.release(handle({ id: '' })), 0)
    assert.lengthOf(svc.evalCalls, 0)

    svc.evalResult = [7]
    assert.equal(await svc.release(handle()), 7)

    svc.evalResult = [0] // second release => nothing left
    assert.equal(await svc.release(handle()), 0)
  })

  test('release passes opEnabled to Lua from the handle', async ({ assert }) => {
    setupPlans({ aiTokens: 1000 })
    const svc = new StubQuotaService()
    svc.evalResult = [0]
    await svc.release(handle({ op: true }))
    // eval args: [script, numKeys(4), k1..k4, holdId, opEnabled]
    assert.equal(svc.evalCalls[0][7], '1', 'opEnabled flag reflects the handle')
  })
})
