import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService from '../../../../src/services/tool_executor.js'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../../src/define_config.js'

/**
 * Tool execution under many tenants at once, on a real database.
 *
 * Two properties that only show up at scale. First, tool calls for different tenants
 * must genuinely OVERLAP: nothing on the path may take a process-wide lock. A shared
 * mutex would keep every functional test green while quietly serialising the whole
 * fleet behind the slowest tenant's query, and the only symptom in production is
 * latency. Second, the Phase-2a admission cap must bound in-flight work PER TENANT —
 * a busy tenant is refused a new loop, and that refusal must not touch anyone else.
 */
const N = 8
const DELAY_MS = 50
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)

const tenants = Array.from({ length: N }, (_, i) => ({
  i,
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_toolperf_${i}_${suffix}`,
  conn: `ai_toolperf_conn_${i}_${suffix}`,
}))

let ready = false

const als = new AsyncLocalStorage<string>()
const byId = new Map(tenants.map((t) => [t.tenant.id, t]))
const ctx = {} as unknown as HttpContext
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A tool with a real query plus a fixed delay, so overlap is measurable. */
const slowRead: AIToolHostDefinition = {
  name: 'slow_read',
  description: 'a deliberately slow tenant read',
  inputSchema: { type: 'object', properties: {} },
  mode: 'read',
  handler: async () => {
    const active = als.getStore()
    const realm = active ? byId.get(active) : undefined
    if (!realm) throw new Error('no ambient tenancy scope in the handler')
    await db.connection(realm.conn).rawQuery('SELECT 1 FROM perf_rows')
    await sleep(DELAY_MS)
    return { scope: active }
  },
}

const toolsConfig: AIToolsConfig = {
  registry: [slowRead],
  authorizeTool: () => ({ kind: 'allow' }),
}

const service = () =>
  new ToolExecutorService({
    runScoped: (tenant, fn) => als.run(tenant.id, fn),
    activeScopeTenantId: () => als.getStore(),
    getToolsConfig: () => toolsConfig,
  })

test.group('tool execution across concurrent tenants (real Postgres)', (group) => {
  group.setup(async () => {
    const primary = getConfig().centralConnectionName
    const client = db.connection(primary)
    try {
      await client.rawQuery('SELECT 1')
    } catch {
      ready = false
      return async () => {}
    }
    ready = true

    const template = db.manager.get(primary)?.config
    for (const t of tenants) {
      db.manager.add(t.conn, { ...template, searchPath: [t.schema] } as never)
      await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${t.schema}"`)
      await db
        .connection(t.conn)
        .rawQuery(`CREATE TABLE IF NOT EXISTS "${t.schema}".perf_rows (id int)`)
      await db.connection(t.conn).rawQuery(`INSERT INTO "${t.schema}".perf_rows (id) VALUES (1)`)
    }

    return async () => {
      const cleanup = db.connection(primary)
      for (const t of tenants) {
        await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${t.schema}" CASCADE`).catch(() => {})
        if (db.manager.has(t.conn)) await db.manager.release(t.conn)
      }
    }
  })

  test('tool calls for different tenants overlap rather than serialise', async ({ assert }) => {
    const svc = service()
    const started = Date.now()

    const results = await Promise.all(
      tenants.map((t) =>
        svc
          .forRequest(ctx, t.tenant, [slowRead])
          .execute(
            { id: `p-${t.i}`, name: 'slow_read', arguments: '{}' },
            new AbortController().signal,
            1
          )
          .then((turn) => turn.content)
      )
    )
    const elapsed = Date.now() - started

    assert.lengthOf(results, N)
    for (const t of tenants) {
      const mine = results.filter((c) => c.includes(t.tenant.id))
      assert.lengthOf(mine, 1, `tenant ${t.i} must appear in exactly its own result`)
    }

    // Serial would be N x DELAY_MS (400ms at these numbers). The bound is deliberately
    // loose — this is a "nothing is globally serialised" probe, not a benchmark, so it
    // must not flake on a loaded machine while still failing hard on a real mutex.
    const serial = N * DELAY_MS
    assert.isBelow(
      elapsed,
      serial * 0.6,
      `${N} tenants' tool calls took ${elapsed}ms; serial would be ~${serial}ms, which points at ` +
        `a process-wide lock on the tool path`
    )
  }).skip(() => !ready, 'Postgres unavailable')

  test('the admission cap bounds in-flight work per tenant, independently', async ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const cap = 2
    const [a, b] = [tenants[0]!, tenants[1]!]

    // Saturate tenant A.
    const held = [
      watcher.acquire(a.tenant.id, { maxConcurrent: cap }),
      watcher.acquire(a.tenant.id, { maxConcurrent: cap }),
    ]
    const refused = (() => {
      try {
        watcher.acquire(a.tenant.id, { maxConcurrent: cap })
        return null
      } catch (error) {
        return error
      }
    })()

    assert.instanceOf(refused, AIException)
    assert.equal((refused as AIException).aiCode, 'too_many_concurrent')
    assert.equal((refused as AIException).httpStatus, 429)

    // A saturated tenant must not spend anyone else's budget: B is unaffected.
    assert.doesNotThrow(() => watcher.acquire(b.tenant.id, { maxConcurrent: cap }))

    // Releasing one of A's frees exactly one slot, no more.
    held[0]!.dispose()
    assert.doesNotThrow(() => watcher.acquire(a.tenant.id, { maxConcurrent: cap }))
    assert.throws(
      () => watcher.acquire(a.tenant.id, { maxConcurrent: cap }),
      /too many concurrent/i
    )
  }).skip(() => !ready, 'Postgres unavailable')

  test('every tenant admitted under the cap completes its call', async ({ assert }) => {
    // The cap bounds admission; it must not silently drop admitted work. Each tenant
    // runs cap-many calls concurrently and all of them must land.
    const watcher = new TenantLivenessWatcher()
    const svc = service()
    const cap = 2

    const work = tenants.flatMap((t) =>
      Array.from({ length: cap }, (_, k) => async () => {
        const handle = watcher.acquire(t.tenant.id, { maxConcurrent: cap })
        try {
          const turn = await svc
            .forRequest(ctx, t.tenant, [slowRead])
            .execute(
              { id: `cap-${t.i}-${k}`, name: 'slow_read', arguments: '{}' },
              handle.signal,
              1
            )
          return turn.content.includes(t.tenant.id)
        } finally {
          handle.dispose()
        }
      })
    )

    const outcomes = await Promise.all(work.map((fn) => fn()))
    assert.lengthOf(outcomes, N * cap)
    assert.deepEqual(
      outcomes.filter((ok) => !ok),
      [],
      'every admitted call must complete under its own scope'
    )
    assert.equal(watcher.watchedTenantCount(), 0, 'every handle was disposed')
  }).skip(() => !ready, 'Postgres unavailable')
})
