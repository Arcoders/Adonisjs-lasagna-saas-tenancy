import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { QuotaExceededException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { AI_TAG } from '../../helpers/tags.js'

/**
 * Fault-injection tier: an adversarial flood on the operator-global ceiling
 * (denial-of-wallet, #13). Many tenants reserve at once against a shared ceiling
 * sized to admit only a few. The behavior tier proves the both-or-neither ceiling
 * for a single reserve; this proves it holds under a concurrent BURST — the
 * single-EVAL atomicity must serialize the winners so the committed + outstanding
 * reserved never exceeds the ceiling, and the losers are refused fairly.
 *
 * The second case composes the flood with a crash: the winners never settle or
 * release (a crashed stream). Their reservation TTL must reclaim the shared
 * ceiling capacity so a later tenant can reserve again — proving the reaper works
 * under contention, not just for one idle hold.
 */
function fakeTenant(id: string): TenantModelContract {
  return { id, name: `q-${id}` } as unknown as TenantModelContract
}

const QUOTA = 'aiTokens'
const day = () => DateTime.utc().toFormat('yyyy-MM-dd')
const opCommitted = () => `quota:op:${day()}:${QUOTA}`
const opHolds = () => `quota:op:${day()}:${QUOTA}:holds`
const opAmt = () => `quota:op:${day()}:${QUOTA}:amt`

/** Sum of live operator hold remainders (worstCase - settled) across all members. */
async function opOutstanding(): Promise<number> {
  const members = await redis.zrange(opHolds(), 0, -1)
  let total = 0
  for (const m of members) {
    const amt = await redis.hget(opAmt(), m)
    if (!amt) continue
    const [worst, settled] = amt.split(':').map(Number)
    total += Math.max(0, worst - (settled || 0))
  }
  return total
}

test.group('operator ceiling under a concurrent flood (fault injection, real Redis)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))

  let svc: QuotaService
  let tenants: TenantModelContract[]
  let originalConfig: ReturnType<typeof getConfig>

  function configure(ttlMs?: number): void {
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'p',
        // Per-tenant limit is generous so the operator ceiling is the only gate.
        definitions: { p: { limits: { [QUOTA]: 1_000_000 } } },
        operatorCeiling: { [QUOTA]: 1000 },
        ...(ttlMs !== undefined ? { reservationTtlMs: ttlMs } : {}),
      },
    } as never)
  }

  group.each.setup(async () => {
    svc = await app.container.make(QuotaService)
    tenants = Array.from({ length: 10 }, () => fakeTenant(randomUUID()))
    originalConfig = getConfig()
  })

  group.each.teardown(async () => {
    for (const t of tenants) await svc.reset(t).catch(() => {})
    await redis.del(opCommitted(), opHolds(), opAmt()).catch(() => {})
    setConfig(originalConfig)
  })

  test('a burst of reserves never over-commits the ceiling and refuses the rest fairly', async ({
    assert,
  }) => {
    configure()
    // ceiling 1000 / worstCase 200 => exactly 5 of the 10 concurrent reserves fit.
    const results = await Promise.allSettled(tenants.map((t) => svc.reserve(t, QUOTA, 200)))
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected')

    assert.lengthOf(won, 5, 'exactly floor(ceiling / worstCase) reserves win the burst')
    assert.lengthOf(lost, 5, 'the rest are refused')
    for (const r of lost) {
      assert.instanceOf((r as PromiseRejectedResult).reason, QuotaExceededException)
    }

    // The invariant: committed + outstanding reserved never exceeds the ceiling.
    const committed = Number(await redis.get(opCommitted())) || 0
    const outstanding = await opOutstanding()
    assert.equal(committed + outstanding, 1000, 'the winners hold exactly the ceiling, no more')
    assert.isAtMost(committed + outstanding, 1000, 'no over-commit under the burst')
    assert.equal(await redis.zcard(opHolds()), 5, 'exactly five operator holds are live')
  })

  test("a crashed winner's hold is reclaimed by TTL so a later tenant can reserve", async ({
    assert,
  }) => {
    configure(200) // short reservation TTL
    // Saturate the ceiling with five winners that then "crash" (never settle/release).
    const winners = tenants.slice(0, 5)
    const latecomer = tenants[5]
    const placed = await Promise.allSettled(winners.map((t) => svc.reserve(t, QUOTA, 200)))
    assert.lengthOf(
      placed.filter((r) => r.status === 'fulfilled'),
      5,
      'ceiling saturated'
    )

    // Immediately, the latecomer is refused: the ceiling is fully held.
    await assert.rejects(() => svc.reserve(latecomer, QUOTA, 200), QuotaExceededException)

    // After the TTL elapses, the crashed holds are reapable; the latecomer's
    // reserve reaps them and succeeds — the shared capacity was reclaimed.
    await new Promise((r) => setTimeout(r, 350))
    const r = await svc.reserve(latecomer, QUOTA, 200)
    assert.isNotEmpty(r.id, 'ceiling capacity reclaimed after the crashed holds expired')
    assert.isAtMost(await opOutstanding(), 1000, 'still no over-commit after the reclaim')
  })
})
