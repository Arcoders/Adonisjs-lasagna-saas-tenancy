import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { consumeRateLimit } from '@adonisjs-lasagna/saas-tenancy/services'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import AIException from '../../../src/exceptions/ai_exception.js'
import AiRateLimiter, { aiRateLimitKey } from '../../../src/services/ai_rate_limiter.js'
import ToolExecutorService from '../../../src/services/tool_executor.js'
import MockAIProvider from '../../../src/testing/mock_ai_provider.js'
import { buildToolLoopProducer } from '../../../src/gateway/tool_loop.js'
import { toolCallFragment } from '../../helpers/tool_chat_doubles.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../src/define_config.js'
import type { StreamFragment } from '../../../src/types/ai_provider_contract.js'

/**
 * Fault-injection tier: Redis drops exactly when a tool ROUND meters itself, i.e.
 * inside the loop's `onBeforeRound` hook that rounds >= 2 must clear before the
 * gateway re-enters the provider.
 *
 * The resilience-tier spec (resilience_rate_limiter_outage_fail_closed) already
 * proves the LIMITER fails closed under this outage, in isolation. What it cannot
 * show is the composition, which is where the money actually leaks: a live
 * multi-round tool loop that has ALREADY flushed headers, streamed text and run a
 * tool. At that point a limiter refusal cannot be a pre-flight 503 anymore, so the
 * question is what the loop does with it. Continuing unmetered would hand a tenant an
 * unbounded number of upstream calls the moment Redis blinks, which is precisely the
 * denial-of-wallet shape the rail exists to stop.
 *
 * So the outage is injected at the one seam it really lives at: the real
 * `AiRateLimiter` over the real `consumeRateLimit`. Everything downstream of it is
 * real: a real Postgres schema, a real connection, a real tool handler that queries
 * it, and the real executor and loop. The window is set far above what one run
 * consumes, so a refusal can only come from the outage and never from the limit biting.
 *
 * Both outage shapes are driven, because they fail differently. `outageRedis` rejects
 * `exec()` (the resilience spec's shape). `replyLostRedis` is the shape ioredis really
 * produces and the dangerous one: `exec()` RESOLVES, carrying per-command errors, so a
 * rail that only guarded against a rejection would read it as a healthy pass and let
 * the round through unmetered.
 *
 * A note for whoever extends this, because it is an easy trap: do NOT assert that a
 * refused round wrote nothing to the real bucket while the limiter is holding a double.
 * The double is the only redis that path can reach, so the real key is untouched no
 * matter what the source does, and `zcard === 0` passes even with the rail deleted. A
 * healthy control on an adjacent key does not rescue it: it proves redis is reachable,
 * which was never the competing explanation. Assert on `providerCalls` instead, which
 * is where the guarantee is observable.
 *
 * Shared-database hygiene (the trap crypto's fault teardown fell into once): every
 * schema, connection and tenant id is derived from a per-run `randomUUID`, so the
 * Redis keys cannot collide with a parallel run and the teardown drops only what this
 * file created. Nothing shared is touched.
 */

const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const TENANT = { id: randomUUID() } as unknown as TenantModelContract
const SCHEMA = `ai_fault_rr_${suffix}`
const CONN = `ai_fault_rr_conn_${suffix}`
const BOOKING = `BK-${suffix}`
const OP = 'chat'

let ready = false

/** Every rate-limit key this file touched, so the teardown cleans up after a failure too. */
const touchedKeys = new Set<string>()

/** The ambient tenancy scope, the shape `tenancy.run` / `tenancy.currentId` present. */
const als = new AsyncLocalStorage<string>()

/** The connection a bound scope routes to; unknown scope means unknown rows. */
const connFor = (tenantId: string): string | undefined =>
  tenantId === TENANT.id ? CONN : undefined

/**
 * A redis whose rate-limit pipeline builds normally but whose `exec()` rejects with a
 * connection error, the realistic shape of a mid-flight outage. `consumeRateLimit`
 * awaits `pipeline.exec()`, so the rejection surfaces through the awaited call.
 */
const outageRedis = {
  pipeline() {
    const chain: Record<string, unknown> = {}
    for (const method of ['zremrangebyscore', 'zadd', 'zcard', 'expire']) {
      chain[method] = () => chain
    }
    chain.exec = async () => {
      throw connectionDropped()
    }
    return chain
  },
} as never

/**
 * The OTHER half of the outage, and the one that actually reaches Redis: the commands
 * are delivered and executed, then the connection drops before the replies come back.
 * `consumeRateLimit`'s own docblock is explicit that this is what ioredis really does
 * (it RESOLVES `exec()` with per-command `[error, value]` tuples rather than rejecting),
 * so a double that only ever rejects never exercises that detection at all.
 *
 * This matters here beyond realism. Under this shape the `zadd` has ALREADY landed in
 * the real bucket by the time the limiter learns it is blind, so a spec that asserts
 * "the refused round wrote nothing" against the real key is only ever describing its own
 * double. What the rail actually owes us is that it still refuses.
 */
function replyLostRedis(): never {
  return {
    pipeline() {
      const real = redis.pipeline()
      const chain: Record<string, unknown> = {}
      for (const method of ['zremrangebyscore', 'zadd', 'zcard', 'expire']) {
        chain[method] = (...args: unknown[]) => {
          ;(real as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args)
          return chain
        }
      }
      chain.exec = async () => {
        // The commands really run; only the replies are lost.
        const results = (await real.exec()) ?? []
        return results.map(() => [connectionDropped(), null])
      }
      return chain
    },
  } as never
}

function connectionDropped(): Error {
  const err = new Error('read ECONNRESET') as Error & { code?: string }
  err.code = 'ECONNRESET'
  return err
}

/** What one run of the loop produced. */
interface LoopRun {
  /** The fragments the client actually received before the loop threw. */
  readonly fragments: StreamFragment[]
  /** The error the loop propagated, if any. */
  readonly caught: unknown
  /** How many times the provider was entered; round 2 must never appear here. */
  readonly providerCalls: number
  /** The rows each tool invocation read from the real schema, in order. */
  readonly handlerReads: string[][]
}

/**
 * Run the tool loop end to end with the limiter blind. Round 1 streams text and calls
 * the tool, the tool reads real rows, and round 2 walks into the outage. Each run gets
 * its own key fingerprint so the tests never share a bucket.
 */
async function runLoopUnderOutage(
  fingerprint: string,
  brokenRedis: never = outageRedis
): Promise<LoopRun> {
  touchedKeys.add(aiRateLimitKey(OP, TENANT.id, fingerprint))

  const handlerReads: string[][] = []
  const countBookings: AIToolHostDefinition = {
    name: 'count_bookings',
    description: 'count this tenant bookings',
    inputSchema: { type: 'object', properties: {} },
    mode: 'read',
    handler: async () => {
      // Resolve the connection from the AMBIENT scope, never from a captured tenant
      // (the shape `isolation_two_tenant_tool_no_leak` uses): reading `CONN` directly
      // would find the right rows whatever the executor bound, which proves nothing.
      const active = als.getStore()
      if (!active) throw new Error('the handler ran with no ambient tenancy scope')
      const conn = connFor(active)
      if (!conn) throw new Error(`no connection for the active scope ${active}`)
      const result = await db.connection(conn).rawQuery('SELECT reference FROM bookings ORDER BY 1')
      const rows = (result.rows as { reference: string }[]).map((r) => r.reference)
      handlerReads.push(rows)
      return { total: rows.length, rows }
    },
  }

  const toolsConfig: AIToolsConfig = {
    registry: [countBookings],
    authorizeTool: () => ({ kind: 'allow' }),
  }
  const executor = new ToolExecutorService({
    runScoped: (tenant, fn) => als.run(tenant.id, fn),
    activeScopeTenantId: () => als.getStore(),
    getToolsConfig: () => toolsConfig,
  })

  // The limit is far above what one run spends, so the only thing that can refuse a
  // round here is the outage itself.
  const limiter = new AiRateLimiter({
    consume: (args) => consumeRateLimit({ getRedis: async () => brokenRedis, ...args }),
    policy: { limit: 50, windowSeconds: 60 },
  })

  const provider = new MockAIProvider({
    name: 'claude',
    contractVersion: 2,
    rounds: [
      // Round 1: real streamed text, then a tool call, so the loop must come back.
      [
        { data: 'déjame mirar tus reservas, ', tokens: 4 },
        toolCallFragment('call-1', 'count_bookings', '{}'),
      ],
      // Round 2's answer. The outage means it is never pulled.
      [{ data: 'tienes 1 reserva', tokens: 3 }],
    ],
  })

  const ctx = {} as unknown as HttpContext
  const producer = buildToolLoopProducer({
    tenantId: TENANT.id,
    provider,
    baseRequest: { messages: [{ role: 'user', content: '¿cuántas reservas tengo?' }] },
    tools: [countBookings],
    executor: executor.forRequest(ctx, TENANT, [countBookings]),
    perRoundMaxTokens: 64,
    maxRounds: 3,
    onBeforeRound: () => limiter.check({ op: OP, tenantId: TENANT.id, fingerprint }),
  })

  const fragments: StreamFragment[] = []
  let caught: unknown
  try {
    for await (const fragment of producer(new AbortController().signal)) {
      fragments.push(fragment)
    }
  } catch (error) {
    caught = error
  }
  return { fragments, caught, providerCalls: provider.calls.length, handlerReads }
}

test.group('a Redis outage on a tool round rate limit (real Postgres + Redis)', (group) => {
  group.setup(async () => {
    const primary = getConfig().centralConnectionName
    const client = db.connection(primary)
    try {
      await client.rawQuery('SELECT 1')
      await redis.ping()
    } catch {
      ready = false
      return
    }
    ready = true

    const template = db.manager.get(primary)?.config
    db.manager.add(CONN, { ...template, searchPath: [SCHEMA] } as never)
    await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`)
    await db
      .connection(CONN)
      .rawQuery(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".bookings (reference text)`)
    await db
      .connection(CONN)
      .rawQuery(`INSERT INTO "${SCHEMA}".bookings (reference) VALUES (?)`, [BOOKING])

    return async () => {
      for (const key of touchedKeys) await redis.del(key).catch(() => {})
      await client.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
      if (db.manager.has(CONN)) await db.manager.release(CONN)
    }
  })

  test('a round that cannot be metered fails closed and never re-enters the provider', async ({
    assert,
  }) => {
    // assert.rejects would not hand back the error, and the aiCode is the whole point.
    const run = await runLoopUnderOutage('fp-fail-closed')

    assert.instanceOf(run.caught, AIException)
    assert.equal((run.caught as AIException).aiCode, 'rate_limit_unavailable')
    assert.equal((run.caught as AIException).httpStatus, 503)
    // The load-bearing half: the loop propagated instead of swallowing the refusal
    // and streaming round 2 anyway. One provider call means round 2 never happened.
    assert.equal(
      run.providerCalls,
      1,
      'a blind limiter must stop the loop, never let it call the provider unmetered'
    )
  }).skip(() => !ready, 'Postgres or Redis unavailable')

  test('a round whose meter reply is lost still fails closed, even though the write landed', async ({
    assert,
  }) => {
    const fingerprint = 'fp-reply-lost'
    const key = aiRateLimitKey(OP, TENANT.id, fingerprint)

    const run = await runLoopUnderOutage(fingerprint, replyLostRedis())

    // This is the outage ioredis actually produces, and it is the one that can talk the
    // rail into failing OPEN: `exec()` resolves, so a limiter that only guarded against
    // a rejection would read a resolved pipeline, miss the per-command errors, and let
    // round 2 through unmetered. Both `consumeRateLimit`'s three-way detection and the
    // limiter's fail-closed catch have to hold for this to pass.
    assert.instanceOf(run.caught, AIException)
    assert.equal((run.caught as AIException).aiCode, 'rate_limit_unavailable')
    assert.equal(
      run.providerCalls,
      1,
      'a resolved-but-broken pipeline must refuse the round, not read as a healthy pass'
    )

    // The honest state of the real bucket, which is the OPPOSITE of "nothing was
    // written": the commands reached Redis, so the round it refused is charged its one
    // hit. That is the conservative direction (it can cost a tenant a slot, never grant
    // an unmetered call) and the window TTL reclaims it, so it is bounded, not orphaned.
    assert.equal(
      await redis.zcard(key),
      1,
      'the hit landed before the reply was lost: the refusal is charged, and bounded by the window'
    )
  }).skip(() => !ready, 'Postgres or Redis unavailable')

  test('round 1 still streamed and its tool ran against the real schema before the outage bit', async ({
    assert,
  }) => {
    // The failure is scoped to the round that could not be metered. Everything the
    // tenant was already served stays served: an outage on round 2 must not retract
    // round 1's text or pretend its tool never ran.
    const run = await runLoopUnderOutage('fp-round-one-stands')

    assert.lengthOf(run.fragments, 2, 'round 1 yielded its text and one tool-call notice')
    assert.equal(run.fragments[0]?.data, 'déjame mirar tus reservas, ')
    assert.equal(run.fragments[1]?.event, 'tool_call')

    const notice = JSON.parse(run.fragments[1]?.data ?? '{}') as Record<string, unknown>
    assert.equal(notice.name, 'count_bookings')
    assert.notProperty(notice, 'arguments', 'the notice stays redacted even on the failing round')

    // A real database read, not a recorded intent: the tool executed inside the bound
    // scope and saw this tenant's own row.
    assert.deepEqual(run.handlerReads, [[BOOKING]], 'the round-1 tool ran exactly once, for real')
  }).skip(() => !ready, 'Postgres or Redis unavailable')
})
