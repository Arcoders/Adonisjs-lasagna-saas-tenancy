import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { AI_TAG } from '../../../helpers/tags.js'

/**
 * Red-team: a QuotaReservation handle is server-only in-process state, but it is
 * a plain object, so a caller could forge or mutate one. This pins the property
 * that makes such tampering harmless *by construction*, so a future refactor
 * cannot silently regress it and the AI satellite can rely on it.
 *
 * Every Redis op in settle()/release() is keyed by the handle's own
 * (tenantId, day, quota) via the `*Key` builders, and the hold is a member named
 * by the handle's `id`. A handle whose tenantId (or quota, or day, or id) has
 * been swapped therefore addresses a DIFFERENT Redis namespace: the hold is not
 * found there, the Lua returns its "already reaped" sentinel, and nothing is
 * charged, neither to the victim tenant (whose keys were never touched) nor to the
 * attacker's tenant (whose namespace has no such hold). There is no cross-tenant
 * charge, and the victim's real hold is left intact. The control case proves the
 * assertions are not vacuous: an *untampered* handle settles and releases for
 * real, so a leak would be detected.
 */
function fakeTenant(id: string): TenantModelContract {
  return { id, name: `q-${id}` } as unknown as TenantModelContract
}

const QUOTA = 'aiTokens'
const day = () => DateTime.utc().toFormat('yyyy-MM-dd')
const tHolds = (tid: string) => `quota:${tid}:${day()}:${QUOTA}:holds`
const opCommitted = () => `quota:op:${day()}:${QUOTA}`
const opHolds = () => `quota:op:${day()}:${QUOTA}:holds`
const opAmt = () => `quota:op:${day()}:${QUOTA}:amt`

test.group('QuotaReservation handle tampering is harmless (integration, real Redis)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))

  let svc: QuotaService
  let victim: TenantModelContract
  let attacker: TenantModelContract
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    svc = await app.container.make(QuotaService)
    victim = fakeTenant(randomUUID())
    attacker = fakeTenant(randomUUID())
    originalConfig = getConfig()
    setConfig({
      ...originalConfig,
      plans: { defaultPlan: 'p', definitions: { p: { limits: { [QUOTA]: 1000 } } } },
    } as never)
  })

  group.each.teardown(async () => {
    await svc.reset(victim).catch(() => {})
    await svc.reset(attacker).catch(() => {})
    await redis.del(opCommitted(), opHolds(), opAmt()).catch(() => {})
    setConfig(originalConfig)
  })

  test('control: an untampered handle settles and releases for real', async ({ assert }) => {
    const r = await svc.reserve(victim, QUOTA, 100)
    await svc.settle(r, 30)
    assert.equal(await svc.getUsage(victim, QUOTA), 30, 'the real settle charged the victim')
    assert.equal(await svc.release(r), 70, 'the real release freed the remainder')
    assert.equal(await redis.zcard(tHolds(victim.id)), 0, 'the hold is gone after release')
  })

  test('settle with a swapped tenantId charges neither tenant and leaves the hold', async ({
    assert,
  }) => {
    const r = await svc.reserve(victim, QUOTA, 100)
    // Attacker forges a handle pointing at their own tenant but reusing the
    // victim's hold id, hoping to charge the victim (or dodge their own budget).
    const forged = { ...r, tenantId: attacker.id }
    await svc.settle(forged, 50)
    assert.equal(await svc.getUsage(victim, QUOTA), 0, 'victim not charged')
    assert.equal(
      await svc.getUsage(attacker, QUOTA),
      0,
      'attacker not charged either (namespace miss)'
    )
    assert.equal(await redis.zcard(tHolds(victim.id)), 1, "victim's hold left intact")
  })

  test('settle with a forged hold id is a no-op', async ({ assert }) => {
    const r = await svc.reserve(victim, QUOTA, 100)
    const forged = { ...r, id: `forged-${randomUUID()}` }
    await svc.settle(forged, 50)
    assert.equal(await svc.getUsage(victim, QUOTA), 0, 'no charge for a hold that does not exist')
    assert.equal(await redis.zcard(tHolds(victim.id)), 1, 'the real hold is untouched')
  })

  test('release with a swapped tenantId frees nothing and leaves the hold', async ({ assert }) => {
    const r = await svc.reserve(victim, QUOTA, 100)
    const forged = { ...r, tenantId: attacker.id }
    assert.equal(await svc.release(forged), 0, 'release against the wrong namespace frees nothing')
    assert.equal(
      await redis.zcard(tHolds(victim.id)),
      1,
      "victim's hold survives the forged release"
    )
    // The victim can still legitimately release their own hold afterwards.
    assert.equal(await svc.release(r), 100, 'the real owner still releases the full remainder')
  })

  test('settle with a swapped quota or day misses the namespace and charges nothing', async ({
    assert,
  }) => {
    const r = await svc.reserve(victim, QUOTA, 100)
    await svc.settle({ ...r, quota: 'someOtherQuota' }, 50)
    await svc.settle({ ...r, day: '1999-01-01' }, 50)
    assert.equal(await svc.getUsage(victim, QUOTA), 0, 'neither swap charged the victim')
    assert.equal(await redis.zcard(tHolds(victim.id)), 1, 'the real hold is untouched')
  })
})
