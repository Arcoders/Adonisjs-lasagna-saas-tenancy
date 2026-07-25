import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  QuotaService,
  consumeRateLimit,
  executeExtension,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import StreamExtensionService from '../../../../src/gateway/stream_extension.js'
import AiRateLimiter, { aiRateLimitKey } from '../../../../src/services/ai_rate_limiter.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { AI_TOKENS_QUOTA } from '../../../../src/constants.js'
import { FakeStreamTarget, fragmentsProducer } from '../../../helpers/stream_doubles.js'

/**
 * Proof the AI cost governor actually BITES on real Redis, end to end through
 * the gateway spine (not FakeQuota, not QuotaService in isolation): with a
 * configured aiTokens budget, a stream whose worst case exceeds it resolves
 * `failed_preflight over_budget` with no bytes; the operator ceiling bites even
 * with no per-plan limit (denial of wallet); and the BYOK per-key rate limit
 * throttles at the window. These close the map's gap that every AI cost test used
 * FakeQuota, so nothing proved the wired aiTokens path meters.
 */
function fakeTenant(id: string): TenantModelContract {
  return { id, name: `ai-${id}` } as unknown as TenantModelContract
}

const day = () => DateTime.utc().toFormat('yyyy-MM-dd')
const opKeys = () => [
  `quota:op:${day()}:${AI_TOKENS_QUOTA}`,
  `quota:op:${day()}:${AI_TOKENS_QUOTA}:holds`,
  `quota:op:${day()}:${AI_TOKENS_QUOTA}:amt`,
]

test.group('AI cost governor bites on real Redis (integration)', (group) => {
  let svc: StreamExtensionService
  let tenantId: string
  let tenant: TenantModelContract
  let originalConfig: ReturnType<typeof getConfig>

  function budget(opts: { limit?: number; ceiling?: number } = {}): void {
    const limits = opts.limit === undefined ? {} : { [AI_TOKENS_QUOTA]: opts.limit }
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'p',
        definitions: { p: { limits } },
        getPlan: () => 'p',
        ...(opts.ceiling !== undefined
          ? { operatorCeiling: { [AI_TOKENS_QUOTA]: opts.ceiling } }
          : {}),
      },
    } as never)
  }

  group.setup(async () => {
    // The real QuotaService against real Redis; no breaker (a breaker preflight
    // fast-fails a fake tenant with no schema, which would mask the quota rail
    // this spec isolates). The breaker path is proven separately.
    const quota = await app.container.make(QuotaService)
    svc = new StreamExtensionService({ quota, runExtension: executeExtension })
  })

  group.each.setup(async () => {
    tenantId = randomUUID()
    tenant = fakeTenant(tenantId)
    originalConfig = getConfig()
  })

  group.each.teardown(async () => {
    await redis.del(...opKeys()).catch(() => {})
    // The tenant hold keys self-expire; delete the committed/holds this run left.
    const keys = await redis.keys(`quota:${tenantId}:*`).catch(() => [])
    if (keys.length) await redis.del(...keys).catch(() => {})
    setConfig(originalConfig)
  })

  test('a stream over the aiTokens budget resolves failed_preflight over_budget, no bytes', async ({
    assert,
  }) => {
    budget({ limit: 100 })
    const target = new FakeStreamTarget()

    const result = await svc.stream(target, fragmentsProducer([{ data: 'x', tokens: 1 }]), {
      label: 'ai:chat',
      tenant,
      quota: AI_TOKENS_QUOTA,
      worstCase: 200,
      validateFragment: (f) => f,
    })

    assert.equal(result.outcome, 'failed_preflight')
    if (result.outcome === 'failed_preflight') assert.equal(result.error, 'over_budget')
    assert.isFalse(target.flushed, 'a pre-flight refusal leaves headers unsent')
    assert.equal(target.output, '')
  })

  test('a stream within the aiTokens budget completes and settles the used tokens', async ({
    assert,
  }) => {
    budget({ limit: 100 })
    const target = new FakeStreamTarget()

    const result = await svc.stream(
      target,
      fragmentsProducer([
        { data: 'hola', tokens: 2 },
        { data: 'mundo', tokens: 3 },
      ]),
      {
        label: 'ai:chat',
        tenant,
        quota: AI_TOKENS_QUOTA,
        worstCase: 50,
        validateFragment: (f) => f,
      }
    )

    assert.equal(result.outcome, 'completed')
    if (result.outcome === 'completed') assert.equal(result.tokensSettled, 5)
    assert.isTrue(target.flushed)
  })

  test('the operator ceiling bites even with no per-plan limit (denial of wallet)', async ({
    assert,
  }) => {
    budget({ ceiling: 100 }) // no per-tenant limit; the fleet-wide ceiling is the only cap
    const target = new FakeStreamTarget()

    const result = await svc.stream(target, fragmentsProducer([{ data: 'x', tokens: 1 }]), {
      label: 'ai:chat',
      tenant,
      quota: AI_TOKENS_QUOTA,
      worstCase: 150,
      validateFragment: (f) => f,
    })

    assert.equal(result.outcome, 'failed_preflight')
    if (result.outcome === 'failed_preflight') assert.equal(result.error, 'over_budget')
    assert.equal(await redis.zcard(opKeys()[1]!), 0, 'the operator hold was not committed')
  })
})

test.group('AI per-key rate limit bites on real Redis (integration)', (group) => {
  const tenantId = randomUUID()
  const fingerprint = 'fp-int'
  const key = aiRateLimitKey('chat', tenantId, fingerprint)

  group.each.teardown(async () => {
    await redis.del(key).catch(() => {})
  })

  test('the window throttles: the limit-plus-one hit is a 429 and the bucket exists', async ({
    assert,
  }) => {
    const limiter = new AiRateLimiter({
      consume: (args) => consumeRateLimit({ getRedis: async () => redis, ...args }),
      policy: { limit: 2, windowSeconds: 60 },
    })
    const hit = () => limiter.check({ op: 'chat', tenantId, fingerprint })

    await hit() // count 1
    await hit() // count 2 (== limit, allowed)

    let threw: unknown
    try {
      await hit() // count 3 (> limit)
    } catch (err) {
      threw = err
    }

    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'rate_limited')
    assert.equal((threw as AIException).httpStatus, 429)
    assert.isAbove(await redis.zcard(key), 0, 'the ext:ai bucket recorded the hits')
  })

  test('two tenants sharing a provider fingerprint get independent buckets', async ({ assert }) => {
    const fp = 'shared-fp-t2'
    const t1 = randomUUID()
    const t2 = randomUUID()
    const k1 = aiRateLimitKey('chat', t1, fp)
    const k2 = aiRateLimitKey('chat', t2, fp)
    const limiter = new AiRateLimiter({
      consume: (args) => consumeRateLimit({ getRedis: async () => redis, ...args }),
      policy: { limit: 1, windowSeconds: 60 },
    })
    try {
      await limiter.check({ op: 'chat', tenantId: t1, fingerprint: fp }) // t1 count 1, allowed
      let t1Threw: unknown
      try {
        await limiter.check({ op: 'chat', tenantId: t1, fingerprint: fp }) // t1 count 2 > limit
      } catch (err) {
        t1Threw = err
      }
      assert.instanceOf(t1Threw, AIException)
      assert.equal((t1Threw as AIException).aiCode, 'rate_limited')

      // Tenant 2 shares the fingerprint but its bucket is tenant-scoped: a fresh window.
      await limiter.check({ op: 'chat', tenantId: t2, fingerprint: fp }) // must NOT throw
      assert.notEqual(k1, k2, 'the two tenants key different buckets')
      assert.isAbove(await redis.zcard(k2), 0, 'tenant 2 has its own bucket')
    } finally {
      await redis.del(k1, k2).catch(() => {})
    }
  })
})
